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
import { isPortable, portableStatus } from '../portable.js'
import { sealSession, openSession } from '../sessionCrypto.js'
import { ffmpegAvailable, ffmpegVersion, transcodeToWav } from '../ffmpeg.js'
import { cacheStats, cacheClear, enforceLimit } from '../audioCache.js'

/**
 * 供其它主进程模块复用的网易云接口调用入口。
 *
 * 在 registerApiIpc() 执行时被赋值（那时才有 getServer 与 cookie jar）。
 * 未注册前为 null —— 调用方需自行判空（ipc/playlist.js 的导入功能即如此）。
 *
 * @type {null | ((method: string, params?: object) => Promise<any>)}
 */
export let ncmApiCall = null

/* 可缓存的 API 及 TTL（命中 SQLite 缓存免走子进程请求网易云） */const API_CACHE_RULES = [
  { re: /^song\/url\/v1/, ttl: 10 * 60 * 1000 }, // 音源 URL 有时效，短缓存
  { re: /^lyric\b/, ttl: 7 * 24 * 60 * 60 * 1000 }, // 歌词（含翻译）极少变化
  { re: /^song\/detail\b/, ttl: 24 * 60 * 60 * 1000 } // 歌曲详情
]
/**
 * 登录态 / 实时数据：既不用本地 SQLite 缓存，也强制绕过服务端缓存。
 *
 * ## 服务端 2 分钟缓存（已实证）
 *
 * `server.js` 对所有 200 响应挂了 `cache('2 minutes', ...)`。
 * 实测（统计服务端日志中路由处理器的执行次数）：
 *
 *     连续两次 /listen/data/today/song（无特殊头）
 *       第 1 次 → 服务端处理 1 次
 *       第 2 次 → 累计仍是 1 次   ← 命中缓存，中间件直接返回
 *
 *     带 `x-apicache-force-fetch: 1` 再试
 *       第 2 次 → 累计 2 次       ← 绕过成功
 *
 * 这就是用户看到「刚听完的歌在今日收听里查不到，过一会儿又出现了」的原因：
 * 前一次查询的结果被缓存 2 分钟，期间无论怎么查都是旧快照。
 *
 * ## ⚠️ 关键坑：正则要匹配**转换后**的 route
 *
 * 调用链是：
 *
 *     method（下划线形式）→ route（斜杠形式）→ 用正则判断
 *     'record_recent_song' → 'record/recent/song' → FORCE_FETCH_RE.test(route)
 *
 * 所以正则里必须写**斜杠形式**。早期版本写成下划线形式
 *（`record_recent`、`listen_data`…），导致这些接口的强制刷新
 * **从未生效过** —— 包括「播放记录」与「听歌足迹」这两个最需要实时的接口。
 *
 * 下面用 `[/_]` 同时兼容两种写法，避免以后再踩（改 method 名或调整
 * 转换逻辑都不会再静默失效）。
 */
const FORCE_FETCH_RE =
  /^(login|logout|register|user[/_]playlist|likelist|recommend[/_]songs|record[/_]recent|daily[/_]signin|scrobble|like|listen[/_]data)/

export function registerApiIpc(getServer) {
  // ---- Cookie Jar：模拟浏览器会话，保持登录态 ----
  // api-enhanced 的登录态通过 Set-Cookie / Cookie 头传递（服务端不维护全局会话），
  // 这里手动保存每个响应返回的 cookie，并在后续请求带上。
  const cookieJar = new Map()

  /* ---- 登录态加密持久化（BLOB 存 SQLite session 表，见 db/session.js） ----
   * 三种封装格式，靠 4 字节 magic 区分：
   *
   *   SS01  Electron safeStorage（Windows DPAPI / macOS Keychain）
   *         —— 密文**绑定当前系统账户与机器**，最安全
   *   AG01  AES-256-GCM，密钥由机器信息派生（hostname|username|uid）
   *         —— safeStorage 不可用时的兜底，同样换机即废
   *   PG01  AES-256-GCM，密钥来自数据目录内的随机 keyfile
   *         —— **便携模式专用**：密钥随数据目录一起走（U 盘），
   *            换台电脑仍能解密，登录态才真正「便携」
   *
   * 为什么便携模式不能用 SS01：DPAPI 密文只能在**加密它的那台机器+账户**上解开。
   * 便携版把 ntr.db 拷到新机器后 safeStorage.decryptString 会抛异常，
   * 下面的 catch 会静默丢弃会话 → 每次换机都要重新扫码登录，
   * 与「插上就用」的预期不符。
   *
   * 安全性权衡：PG01 的密钥与密文同在 U 盘上，能读到 db 的人也能读到 key
   * —— 强度约等于「明文存储但需要两步」。这是便携场景的固有取舍
   *（用户要的就是数据随身走），且不降低非便携模式的安全性。
   * 解密失败（换机器/系统变更/数据损坏）一律静默丢弃，退回未登录状态。 */
  let saveTimer = null
  let jarDirty = false

  /** 传给 sessionCrypto 的上下文（便携模式 / safeStorage / 机器信息） */
  function sessionOpts() {
    const u = os.userInfo()
    return {
      portable: isPortable(),
      dataDir: app.getPath('userData'),
      safeStorage,
      hostname: os.hostname(),
      username: u.username,
      uid: u.uid
    }
  }

  function saveSession() {
    if (!cookieJar.size) return
    try {
      // 加密封装在 src/main/sessionCrypto.js（纯函数，可单测）
      const { blob } = sealSession([...cookieJar.entries()], sessionOpts())
      sessionRepo.save(blob)
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
    const blob = sessionRepo.load()
    if (!blob) return
    const r = openSession(blob, sessionOpts())
    if (!r.ok) {
      // 解密失败（换机器 / 系统凭据变更 / 数据损坏）：丢弃旧会话，走未登录。
      // 这是预期内的降级路径，不打扰用户。
      if (r.reason && r.reason !== 'empty') {
        console.log('[session] 旧登录态无法解封（%s），已退回未登录', r.reason)
      }
      return
    }
    for (const [k, v] of r.entries) cookieJar.set(k, v)
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
  /**
   * 调用网易云接口。抽成具名函数是为了让**其它主进程模块**也能调用
   *（如 ipc/playlist.js 导入网易云歌单），而不必自己重建 socket 连接、
   * 重写缓存与 cookie 处理逻辑。
   *
   * 通过模块级 `ncmApiCall` 暴露给外部（见文件末尾的导出）。
   */
  async function callNcmApi({ method, params, noCache }) {
    const srv = getServer()
    if (!srv) throw new Error('NCM_SERVER_NOT_READY')
    // 启动窗口期兜底：窗口 ready-to-show 不等子服务就绪就显示出来，
    // 用户立刻点播放时 status 还是 starting。此处短暂等待而非立刻抛错，
    // 否则前端会把 NOT_READY 当成「这首歌放不了」弹给用户
    //（表现为"启动时按播放报错一下，再按一次就好了"）。
    if (srv.status !== 'ready') {
      const ready = await srv.waitUntilReady(12000)
      if (!ready) throw new Error('NCM_SERVER_NOT_READY')
    }
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
  }

  // 暴露给其它主进程模块（playlist 导入等）
  ncmApiCall = (method, params) => callNcmApi({ method, params })

  ipcMain.handle('ncm:api', (_e, args) => callNcmApi(args))

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

  // ---- 便携模式状态（设置页展示数据目录 / 是否随身携带）----
  ipcMain.handle('ncm:portable-status', () => portableStatus())

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
