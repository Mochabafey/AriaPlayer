import { ipcMain, dialog, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { stores, flushAll } from '../store/db.js'

export function registerApiIpc(getServer) {
  // ---- 通用 API 转发到本地 api-enhanced ----
  ipcMain.handle('ncm:api', async (_e, { method, params }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('NCM_SERVER_NOT_READY')
    // api-enhanced 路由规则：下划线转斜杠（song_url_v1 → /song/url/v1）
    const route = method.replace(/_/g, '/').replace(/^\//, '')
    const qs = new URLSearchParams(params || {}).toString()
    const url = `http://127.0.0.1:${srv.port}/${route}${qs ? '?' + qs : ''}`
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    return res.json()
  })

  ipcMain.handle('ncm:server-status', () => {
    const srv = getServer()
    return srv ? srv.status : 'down'
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
