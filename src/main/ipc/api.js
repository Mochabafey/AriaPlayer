import { ipcMain, dialog, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { stores, flushAll } from '../store/db.js'
import { ffmpegAvailable, ffmpegVersion, transcodeToWav } from '../ffmpeg.js'

export function registerApiIpc(getServer) {
  // ---- Cookie Jar：模拟浏览器会话，保持登录态 ----
  // api-enhanced 的登录态通过 Set-Cookie / Cookie 头传递（服务端不维护全局会话），
  // 这里手动保存每个响应返回的 cookie，并在后续请求带上。
  const cookieJar = new Map()

  function cookieHeader() {
    return [...cookieJar.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  function absorbCookies(res) {
    let setCookies = []
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie()
    } else {
      const v = res.headers.get('set-cookie')
      if (v) setCookies = [v]
    }
    for (const sc of setCookies) {
      if (!sc) continue
      const pair = sc.split(';')[0]
      const i = pair.indexOf('=')
      if (i > 0) cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  }

  // ---- 通用 API 转发到本地 api-enhanced ----
  ipcMain.handle('ncm:api', async (_e, { method, params }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('NCM_SERVER_NOT_READY')
    // api-enhanced 路由规则：下划线转斜杠（song_url_v1 → /song/url/v1）
    const route = method.replace(/_/g, '/').replace(/^\//, '')
    const qs = new URLSearchParams(params || {}).toString()
    const url = `http://127.0.0.1:${srv.port}/${route}${qs ? '?' + qs : ''}`
    const headers = {}
    const cookie = cookieHeader()
    if (cookie) headers['Cookie'] = cookie
    // 登录态/实时数据接口绕过服务端 2 分钟缓存（否则登录后 login_status 命中缓存仍显示匿名）
    if (/^(login|logout|register|user_playlist|likelist|recommend_songs|record_recent|daily_signin)/.test(route)) {
      headers['x-apicache-force-fetch'] = '1'
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
    absorbCookies(res)
    return res.json()
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

  // ---- 设置 ----
  ipcMain.handle('ncm:settings-get', () => stores.settings.get())
  ipcMain.handle('ncm:settings-set', (_e, key, value) => {
    stores.settings.set(key, value)
    flushAll()
    return stores.settings.get()
  })
}
