import { ipcMain, dialog, shell, safeStorage } from 'electron'
import fs from 'fs'
import http from 'http'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { app } from 'electron'
import { settingsRepo } from '../db/settings.js'
import { sessionRepo } from '../db/session.js'
import { apiCacheRepo } from '../db/apiCache.js'
import { ffmpegAvailable, ffmpegVersion, transcodeToWav } from '../ffmpeg.js'
import { cacheStats, cacheClear, enforceLimit } from '../audioCache.js'

/* 可缓存的 API 及 TTL（命中 SQLite 缓存免走子进程请求网易云） */
const API_CACHE_RULES = [
  { re: /^song\/url\/v1/, ttl: 10 * 60 * 1000 }, // 音源 URL 有时效，短缓存
  { re: /^lyric\b/, ttl: 7 * 24 * 60 * 60 * 1000 }, // 歌词（含翻译）极少变化
  { re: /^song\/detail\b/, ttl: 24 * 60 * 60 * 1000 } // 歌曲详情
]
/** 登录态/实时数据：既不用本地缓存，也强制绕过服务端缓存 */
const FORCE_FETCH_RE = /^(login|logout|register|user_playlist|likelist|recommend_songs|record_recent|daily_signin)/

export function registerApiIpc(getServer) {
  // ---- Cookie Jar：模拟浏览器会话，保持登录态 ----
  // api-enhanced 的登录态通过 Set-Cookie / Cookie 头传递（服务端不维护全局会话），
  // 这里手动保存每个响应返回的 cookie，并在后续请求带上。
  const cookieJar = new Map()

  /* ---- 登录态加密持久化（BLOB 存 SQLite session 表，见 db/session.js） ----
   * 加密优先走 Electron safeStorage（Windows DPAPI / macOS Keychain，
   * 密文绑定当前系统账户）；不可用时回退 AES-256-GCM（密钥由机器信息派生）。
   * 解密失败（换机器/系统变更）静默丢弃，退回未登录状态。 */
  let saveTimer = null
  let jarDirty = false

  function fallbackKey() {
    const u = os.userInfo()
    return crypto.scryptSync(`${os.hostname()}|${u.username}|${u.uid ?? ''}`, 'ntr-session-v1', 32)
  }
  function aesEncrypt(buf) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', fallbackKey(), iv)
    return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()])
  }
  function aesDecrypt(buf) {
    const d = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(buf.length - 16))
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()])
  }

  function saveSession() {
    if (!cookieJar.size) return
    try {
      const payload = Buffer.from(JSON.stringify([...cookieJar.entries()]), 'utf-8')
      let out
      if (safeStorage.isEncryptionAvailable()) {
        out = Buffer.concat([Buffer.from('SS01'), safeStorage.encryptString(payload.toString('utf-8'))])
      } else {
        out = Buffer.concat([Buffer.from('AG01'), aesEncrypt(payload)])
      }
      sessionRepo.save(out)
    } catch (e) {
      console.error('[session] save failed', e)
    }
  }

  function clearSession() {
    cookieJar.clear()
    jarDirty = false
    clearTimeout(saveTimer)
    sessionRepo.clear()
  }

  function loadSession() {
    try {
      const buf = sessionRepo.load()
      if (!buf) return
      const magic = buf.subarray(0, 4).toString('latin1')
      const body = buf.subarray(4)
      let json = ''
      if (magic === 'SS01' && safeStorage.isEncryptionAvailable()) {
        json = safeStorage.decryptString(body)
      } else if (magic === 'AG01') {
        json = aesDecrypt(body).toString('utf-8')
      } else {
        return
      }
      for (const [k, v] of JSON.parse(json)) cookieJar.set(k, v)
    } catch {
      // 解密失败（换机器 / 系统凭据变更 / 数据损坏）：丢弃旧会话，走未登录
    }
  }
  loadSession()

  // 应用退出前冲刷未落盘的会话（防抖定时器会被退出打断）
  app.on('before-quit', () => {
    if (jarDirty && cookieJar.size) {
      clearTimeout(saveTimer)
      jarDirty = false
      saveSession()
    }
  })

  function cookieHeader() {
    return [...cookieJar.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  /** Node http 原生支持 socketPath（named pipe / unix socket）， absorbs set-cookie */
  function absorbCookies(res) {
    let setCookies = res.headers['set-cookie']
    if (setCookies && !Array.isArray(setCookies)) setCookies = [setCookies]
    for (const sc of setCookies || []) {
      if (!sc) continue
      const pair = sc.split(';')[0]
      const i = pair.indexOf('=')
      if (i <= 0) continue
      const k = pair.slice(0, i).trim()
      const v = pair.slice(i + 1).trim()
      if (cookieJar.get(k) !== v) {
        cookieJar.set(k, v)
        jarDirty = true
      }
    }
    // cookie 有变化时防抖落盘（加密）
    if (jarDirty) {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        jarDirty = false
        saveSession()
      }, 500)
    }
  }

  /** 经私有 socket 通道请求 api-enhanced，返回 { res, text } */
  function socketRequest(srv, urlPath, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: srv.socketPath, path: urlPath, headers, method: 'GET' }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ res, text: Buffer.concat(chunks).toString('utf-8') }))
      })
      req.on('error', reject)
      req.setTimeout(30000, () => req.destroy(new Error('api timeout')))
      req.end()
    })
  }

  /** 稳定缓存键：route + 按 key 排序的 query。
   *  song/url/v1 的结果与登录态强相关（会员拿高清官方源、匿名只有低音质/试听），
   *  缓存键混入 MUSIC_U 指纹，避免匿名时期的结果串给登录后的会员会话（反之亦然） */
  function cacheKey(route, params) {
    const qs = Object.keys(params || {}).sort().map((k) => `${k}=${params[k]}`).join('&')
    let salt = ''
    if (/^song\/url\/v1/.test(route)) {
      const mu = cookieJar.get('MUSIC_U') || ''
      salt = mu ? `&mu=${crypto.createHash('sha1').update(mu).digest('hex').slice(0, 12)}` : ''
    }
    return `${route}?${qs}${salt}`
  }

  /** song/url/v1 只有网易自家 CDN 地址才值得缓存：解灰替换出的第三方地址
   *（kuwo/qijieya 等）时效短且不稳定，缓存了反而让断流恢复反复拿到同一个死地址 */
  function isCacheable(route, json) {
    if (route === 'song/url/v1') {
      const url = json?.data?.[0]?.url || ''
      return /126\.net|netease|music\.163/i.test(url)
    }
    return true
  }

  // ---- 通用 API 转发（私有 socket 通道）+ SQLite 缓存 ----
  ipcMain.handle('ncm:api', async (_e, { method, params, noCache }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('NCM_SERVER_NOT_READY')
    // api-enhanced 路由规则：下划线转斜杠（song_url_v1 → /song/url/v1）
    const route = method.replace(/_/g, '/').replace(/^\//, '')
    const realTime = FORCE_FETCH_RE.test(route)
    const cacheRule = realTime ? null : API_CACHE_RULES.find((r) => r.re.test(route))

    // 1. 命中本地 SQLite 缓存直接返回（切歌回听同曲秒出歌词/音源）；noCache 用于断流恢复强制刷新
    const key = cacheKey(route, params)
    if (cacheRule && !noCache) {
      const hit = apiCacheRepo.get(key)
      if (hit) return hit
    }

    const qs = new URLSearchParams(params || {}).toString()
    const headers = {}
    const cookie = cookieHeader()
    if (cookie) headers['Cookie'] = cookie
    if (realTime) headers['x-apicache-force-fetch'] = '1'
    const { res, text } = await socketRequest(srv, `/${route}${qs ? '?' + qs : ''}`, headers)
    absorbCookies(res)
    // 退出登录：服务端会下发过期 cookie，本地一并清空并删除持久化会话
    if (/^logout/.test(route)) clearSession()
    let json
    try { json = JSON.parse(text) } catch { json = { code: res.statusCode, message: 'bad json from upstream' } }
    // 2. 业务成功且值得缓存才写（网易云约定 code === 200）
    if (cacheRule && json.code === 200 && isCacheable(route, json)) apiCacheRepo.set(key, json, cacheRule.ttl)
    return json
  })

  // ---- 短链跳转解析（163cn.tv 等）→ 返回真实 URL ----
  ipcMain.handle('ncm:resolve-link', async (_e, input) => {
    const target = String(input || '').trim()
    if (!/^https?:\/\//.test(target)) return null
    try {
      const res = await fetch(target, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000)
      })
      const loc = res.headers.get('location')
      if (loc) return new URL(loc, target).toString()
      // 无跳转：返回最终响应 URL（可能是 200 页面）
      return res.url && res.url !== target ? res.url : null
    } catch {
      return null
    }
  })

  ipcMain.handle('ncm:server-status', () => {
    const srv = getServer()
    return srv ? srv.status : 'down'
  })

  // ---- ffmpeg ----
  ipcMain.handle('ncm:ffmpeg-version', async () => {
    if (!ffmpegAvailable()) return null
    return ffmpegVersion()
  })
  // 播放回退：任意音频 URL/文件 → wav 临时文件
  ipcMain.handle('ncm:ffmpeg-transcode', async (_e, { url, format = 'wav' }) => {
    if (!url || !ffmpegAvailable()) return null
    try {
      const tmpDir = path.join(app.getPath('temp'), 'ntr-transcode')
      if (format === 'wav') return await transcodeToWav(url, tmpDir)
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle('ncm:server-restart', async () => {
    const srv = getServer()
    if (!srv) return false
    await srv.restart()
    return srv.status
  })

  // ---- 系统对话框 / 打开文件夹 ----
  ipcMain.handle('ncm:save-dialog', async (_e, opts = {}) => {
    const r = await dialog.showSaveDialog({
      title: opts.title || '选择保存位置',
      defaultPath: opts.defaultPath,
      filters: opts.filters
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('ncm:open-folder', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p)
  })

  ipcMain.handle('ncm:select-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // ---- 设置（SQLite） ----
  ipcMain.handle('ncm:settings-get', () => settingsRepo.getAll())
  ipcMain.handle('ncm:settings-set', (_e, key, value) => {
    settingsRepo.set(key, value)
    // 缓存上限调整后立即收敛到新限额
    if (key === 'audioCacheLimitMB') enforceLimit()
    return settingsRepo.getAll()
  })

  // ---- 音频缓存管理 ----
  ipcMain.handle('ncm:cache-stats', () => cacheStats())
  ipcMain.handle('ncm:cache-clear', () => cacheClear())
}
