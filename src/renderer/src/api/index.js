// 前端统一 API 封装：window.ncm（preload 桥）
export const bridge = window.ncm

/**
 * api-enhanced 路由规则：module 文件名下划线转斜杠
 * （song_url_v1.js → /song/url/v1，login_qr_key.js → /login/qr/key）
 */
export function routeOf(method) {
  return method.replace(/_/g, '/')
}

/** 等待内置服务就绪（默认最多 30s）。主进程子服务启动含注册匿名 token 的
 *  网络往返 + 关闭版本检查后的剩余开销，15s 在弱网下可能误报未就绪。
 *
 *  maxMs：可选等待上限。播放路径传入较短的预算——用户已经按了播放键，
 *  让他干等 30s 再报错体验很差；宁可早失败早提示（服务真起不来时，
 *  弹「服务未就绪」比转圈 30s 更有信息量）。
 */
export async function waitServerReady(maxMs = 30000) {
  const deadline = Date.now() + maxMs
  for (let i = 0; i < 60; i++) {
    const s = await bridge.invoke('ncm:server-status')
    if (s === 'ready') return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** 单次查询内置服务是否已就绪（不轮询，用于快速路径判断） */
export async function serverReadyNow() {
  try {
    return (await bridge.invoke('ncm:server-status')) === 'ready'
  } catch {
    return false
  }
}

/** 调用本地 api-enhanced 接口；opts.noCache=true 跳过本地缓存（断流恢复强制刷新用） */
export async function api(method, params = {}, opts = {}) {
  const data = await bridge.invoke('ncm:api', { method: routeOf(method), params, noCache: !!opts.noCache })
  if (data && data.code !== undefined && data.code !== 200 && data.code !== 0) {
    const err = new Error(data.message || data.msg || `接口错误 code=${data.code}`)
    err.code = data.code
    throw err
  }
  return data
}

// ---- QQ音乐（多音源） ----
export const qqmusic = {
  /** 搜索歌曲 */
  search: (keyword, page = 1, limit = 30) => bridge.invoke('qqmusic:search', { keyword, page, limit }),
  /** 获取音源 URL */
  url: (songmid) => bridge.invoke('qqmusic:url', { songmid }),
  /** 获取歌词 */
  lyric: (songmid) => bridge.invoke('qqmusic:lyric', { songmid }),
  /** 服务状态 */
  serverStatus: () => bridge.invoke('qqmusic:server-status'),
  serverRestart: () => bridge.invoke('qqmusic:server-restart'),
  onServerStatus: (cb) => bridge.on('qqmusic:server-status', cb),
  /** QQ 音乐 Cookie（解锁 VIP/版权歌曲） */
  getCookie: () => bridge.invoke('qqmusic:get-cookie'),
  setCookie: (cookie) => bridge.invoke('qqmusic:set-cookie', cookie),
  /** QQ 音乐扫码登录 */
  loginQr: () => bridge.invoke('qqmusic:login-qr'),
  loginCheck: (qrsig, token, cookie) => bridge.invoke('qqmusic:login-check', { qrsig, token, cookie }),
  loginClear: () => bridge.invoke('qqmusic:login-clear'),
  getNick: () => bridge.invoke('qqmusic:get-nick'),
  /** QQ 智能聚合搜索（歌手/专辑/MV） */
  smartbox: (keyword) => bridge.invoke('qqmusic:smartbox', { keyword })
}

// ---- B站（MV 源）----
export const bili = {
  /** 登录态 */
  loginStatus: () => bridge.invoke('bili:login-status'),
  /** 申请登录二维码 → { url, qrcodeKey } */
  loginQr: () => bridge.invoke('bili:login-qr'),
  /** 轮询扫码状态 → { code, status: waiting|scanned|success|expired } */
  loginPoll: (qrcodeKey) => bridge.invoke('bili:login-poll', qrcodeKey),
  logout: () => bridge.invoke('bili:logout'),
  getCookie: () => bridge.invoke('bili:get-cookie'),
  setCookie: (str) => bridge.invoke('bili:set-cookie', str),
  clearCookie: () => bridge.invoke('bili:clear-cookie'),
  /** 搜索视频 */
  search: (keyword, page = 1, pageSize = 20) => bridge.invoke('bili:search', { keyword, page, pageSize }),
  /** 视频详情（含 cid / 分P） */
  videoInfo: (bvid) => bridge.invoke('bili:video-info', bvid),
  /**
   * 解析播放源 → 三种结果：
   *   { mode:'proxy', url }            直接播（durl 单文件）
   *   { mode:'ready', file }           已缓存的合流文件
   *   { mode:'merge', key, needMerge } 需合流，轮询 mergeStatus
   */
  resolve: (bvid, cid, quality, preferSingle = true) =>
    bridge.invoke('bili:resolve', { bvid, cid, quality, preferSingle }),
  /** 合流进度 */
  mergeStatus: (key) => bridge.invoke('bili:merge-status', key),
  /** 合流缓存管理 */
  cacheStats: () => bridge.invoke('bili:cache-stats'),
  cacheClear: () => bridge.invoke('bili:cache-clear')
}

export const ncm = {  // 服务状态
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

  // 音频缓存
  cacheStats: () => bridge.invoke('ncm:cache-stats'),
  cacheClear: () => bridge.invoke('ncm:cache-clear'),

  // 系统
  openFolder: (p) => bridge.invoke('ncm:open-folder', p),
  saveDialog: (opts) => bridge.invoke('ncm:save-dialog', opts),

  // NCM 转换
  convertPickFile: () => bridge.invoke('ncm:convert-pick-file'),
  convertPickDir: () => bridge.invoke('ncm:convert-pick-dir'),
  convertBatch: (opts) => bridge.invoke('ncm:convert-batch', opts),
  onConvertProgress: (cb) => bridge.on('ncm:convert-progress', cb)
}

/** 网易云链接 → {type, id} */
export function parseLink(input) {
  const s = String(input).trim()
  if (!s) return null
  // 优先处理纯 ID
  if (/^\d{5,15}$/.test(s)) return { type: 'song', id: s }
  // 链接格式：song?id=xxx / song/xxx / #/song?id=xxx / m/song?id=xxx
  // 关键：song 后可能跟 ?id= / = / /，数字不一定紧跟其后（song?id=33894312 的 ? 后是 id=）
  const patterns = [
    { type: 'song', re: /song[?/=]*(?:id[?/=])?(\d{5,})/ },
    { type: 'playlist', re: /playlist[?/=]*(?:id[?/=])?(\d{5,})/ },
    { type: 'album', re: /album[?/=]*(?:id[?/=])?(\d{5,})/ },
    { type: 'artist', re: /artist[?/=]*(?:id[?/=])?(\d{5,})/ },
    { type: 'mv', re: /mv[?/=]*(?:id[?/=])?(\d{5,})/ }
  ]
  for (const p of patterns) {
    const m = s.match(p.re)
    if (m) return { type: p.type, id: m[1] }
  }
  return null
}

/**
 * 解析输入：先直接 parseLink；若为 http(s) 链接且识别失败，
 * 尝试短链跳转（163cn.tv 等）拿到真实 URL 后再识别。
 */
export async function resolveLinkInput(input) {
  const parsed = parseLink(input)
  if (parsed) return { ...parsed, raw: String(input).trim() }
  const s = String(input || '').trim()
  if (!/^https?:\/\//.test(s)) return null
  try {
    const realUrl = await bridge.invoke('ncm:resolve-link', s)
    if (!realUrl) return null
    const parsed2 = parseLink(realUrl)
    if (parsed2) return { ...parsed2, raw: realUrl }
  } catch {
    /* ignore */
  }
  return null
}

/** 封面 URL 拼接 */
export function coverUrl(id, size = 300) {
  if (!id) return ''
  return `https://p2.music.126.net/${id}?param=${size}y${size}`
}

/**
 * 图片 URL 包装：远程图片走 ncm-audio://img 代理（主进程 Node http 拉取），
 * 绕开 Chromium 网络栈被系统代理拦截导致的封面/头像加载失败。
 * 本地路径（ncm-audio://cover?path=）与非 http 链接原样返回。
 */
export function imgUrl(url) {
  if (!url) return ''
  const s = String(url)
  if (s.startsWith('ncm-audio://')) return s
  if (!/^https?:\/\//.test(s)) return s
  return `ncm-audio://img?url=${encodeURIComponent(s)}`
}
