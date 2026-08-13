// 前端统一 API 封装：window.ncm（preload 桥）
export const bridge = window.ncm

/**
 * api-enhanced 路由规则：module 文件名下划线转斜杠
 * （song_url_v1.js → /song/url/v1，login_qr_key.js → /login/qr/key）
 */
export function routeOf(method) {
  return method.replace(/_/g, '/')
}

/** 等待内置服务就绪（最多 15s） */
export async function waitServerReady() {
  for (let i = 0; i < 30; i++) {
    const s = await bridge.invoke('ncm:server-status')
    if (s === 'ready') return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** 调用本地 api-enhanced 接口 */
export async function api(method, params = {}) {
  const data = await bridge.invoke('ncm:api', { method: routeOf(method), params })
  if (data && data.code !== undefined && data.code !== 200 && data.code !== 0) {
    const err = new Error(data.message || data.msg || `接口错误 code=${data.code}`)
    err.code = data.code
    throw err
  }
  return data
}

export const ncm = {
  // 服务状态
  serverStatus: () => bridge.invoke('ncm:server-status'),
  serverRestart: () => bridge.invoke('ncm:server-restart'),
  onServerStatus: (cb) => bridge.on('ncm:server-status', cb),

  // 下载
  downloadAdd: (info) => bridge.invoke('ncm:download-add', info),
  downloadList: () => bridge.invoke('ncm:download-list'),
  downloadCancel: (id) => bridge.invoke('ncm:download-cancel', id),
  downloadRetry: (id) => bridge.invoke('ncm:download-retry', id),
  downloadRemove: (id, opts) => bridge.invoke('ncm:download-remove', id, opts),
  onDownloadProgress: (cb) => bridge.on('ncm:download-progress', cb),
  onDownloadDone: (cb) => bridge.on('ncm:download-done', cb),

  // 曲库
  libraryList: () => bridge.invoke('ncm:library-list'),
  libraryFolders: () => bridge.invoke('ncm:library-folders'),
  libraryAddFolder: (folder) => bridge.invoke('ncm:library-add-folder', folder),
  libraryScan: () => bridge.invoke('ncm:library-scan'),
  librarySelectFolder: () => bridge.invoke('ncm:select-folder'),
  libraryEdit: (id, fields) => bridge.invoke('ncm:library-edit', id, fields),
  libraryRemove: (id, opts) => bridge.invoke('ncm:library-remove', id, opts),
  libraryExport: (type) => bridge.invoke('ncm:library-export', type),
  libraryImport: () => bridge.invoke('ncm:library-import'),
  onLibraryUpdated: (cb) => bridge.on('ncm:library-updated', cb),

  // 本地歌单
  playlistList: () => bridge.invoke('ncm:playlist-list'),
  playlistSave: (p) => bridge.invoke('ncm:playlist-save', p),
  playlistRemove: (id) => bridge.invoke('ncm:playlist-remove', id),
  playlistExportM3u: (p) => bridge.invoke('ncm:playlist-export-m3u', p),
  playlistImportM3u: (name) => bridge.invoke('ncm:playlist-import-m3u', name),

  // 设置
  settingsGet: () => bridge.invoke('ncm:settings-get'),
  settingsSet: (k, v) => bridge.invoke('ncm:settings-set', k, v),

  // 系统
  openFolder: (p) => bridge.invoke('ncm:open-folder', p),
  saveDialog: (opts) => bridge.invoke('ncm:save-dialog', opts)
}

/** 网易云链接 → {type, id} */
export function parseLink(input) {
  const s = String(input).trim()
  if (!s) return null
  const patterns = [
    { type: 'song', re: /(?:song|music)[\/=](\d+)/ },
    { type: 'playlist', re: /playlist[\/=](\d+)/ },
    { type: 'album', re: /album[\/=](\d+)/ },
    { type: 'artist', re: /artist[\/=](\d+)/ },
    { type: 'mv', re: /mv[\/=](\d+)/ }
  ]
  for (const p of patterns) {
    const m = s.match(p.re)
    if (m) return { type: p.type, id: m[1] }
  }
  if (/^\d{5,15}$/.test(s)) return { type: 'song', id: s }
  return null
}

/** 封面 URL 拼接 */
export function coverUrl(id, size = 300) {
  if (!id) return ''
  return `https://p2.music.126.net/${id}?param=${size}y${size}`
}
