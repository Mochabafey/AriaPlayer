import { ipcMain } from 'electron'
import http from 'http'
import { settingsRepo } from '../db/settings.js'

/**
 * QQ音乐 API 私有通道转发（主进程侧）。
 * 渲染进程通过 ncm:invoke('qqmusic:search', { keyword }) 发起搜索，
 * 主进程经命名管道转发到 qqmusic 子进程（Koa 路由），返回 JSON。
 *
 * 路由映射：qqmusic:search → /getSearchByKey?keyword=xxx
 *          qqmusic:url     → /getMusicPlay/:songmid
 *          qqmusic:lyric   → /getLyric/:songmid
 */

/** 经私有 socket 通道请求 qqmusic 子进程，返回解析后的 JSON */
function socketRequest(srv, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: srv.socketPath,
      path: urlPath,
      headers: { 'Accept': 'application/json' },
      method: 'GET'
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve({ code: 500, message: 'bad json from qqmusic', raw: text.slice(0, 500) })
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(25000, () => req.destroy(new Error('qqmusic timeout')))
    req.end()
  })
}

export function registerQqMusicIpc(getServer) {
  // ---- 搜索 ----
  // Rain120 路由 /getSearchByKey/:key?/:limit?/:page?，参数从 ctx.query 读取
  //（key/limit/page/catZhida）。catZhida=0 才是歌曲（默认 1 会混入非歌曲）
  ipcMain.handle('qqmusic:search', async (_e, { keyword, page = 1, limit = 30 }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('QQMUSIC_SERVER_NOT_READY')
    const qs = new URLSearchParams({
      key: keyword,
      limit: String(limit),
      page: String(page),
      catZhida: '0'
    }).toString()
    const json = await socketRequest(srv, `/getSearchByKey?${qs}`)
    // 返回 { response: { code, data: { song: { list: [...] } } } }
    const list = json?.response?.data?.song?.list ?? []
    return { code: 200, songs: list.map(normalizeQqSong) }
  })

  // ---- 音源 URL ----
  // /getMusicPlay 从 ctx.query 读 songmid/resType/quality，resType=play 返回
  // { data: { playUrl: { [songmid]: { url, error } } } }
  // 免费账号高音质（320/flac）可能无权限（purl 为空），自动降级 128
  async function fetchQqUrl(srv, songmid, quality) {
    const qs = new URLSearchParams({ resType: 'play', songmid, quality: String(quality) }).toString()
    const json = await socketRequest(srv, `/getMusicPlay?${qs}`)
    const item = json?.data?.playUrl?.[songmid]
    if (!item?.url) {
      console.log(`[qqmusic] url empty mid=${songmid} q=${quality} err=${item?.error || 'n/a'} keys=${Object.keys(json?.data?.playUrl || {}).join(',')}`)
    }
    return item?.url || ''
  }
  ipcMain.handle('qqmusic:url', async (_e, { songmid }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('QQMUSIC_SERVER_NOT_READY')
    if (!songmid) return { code: 404, url: '' }
    let url = await fetchQqUrl(srv, songmid, '320')
    if (!url) url = await fetchQqUrl(srv, songmid, '128')
    return { code: url ? 200 : 404, url }
  })

  // ---- 歌词 ----
  // /getLyric 从 ctx.query 读 songmid/isFormat，isFormat=1 返回格式化 LRC：
  // { response: { code, lyric: '<lrc 文本>' } }
  ipcMain.handle('qqmusic:lyric', async (_e, { songmid }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('QQMUSIC_SERVER_NOT_READY')
    if (!songmid) return { code: 404, lyric: '' }
    const qs = new URLSearchParams({ songmid, isFormat: '1' }).toString()
    const json = await socketRequest(srv, `/getLyric?${qs}`)
    const lyric = json?.response?.lyric ?? json?.lyric ?? ''
    return { code: lyric ? 200 : 404, lyric }
  })

  // ---- 服务状态 ----
  ipcMain.handle('qqmusic:server-status', () => {
    const srv = getServer()
    return srv ? srv.status : 'down'
  })

  // ---- 服务重启 ----
  ipcMain.handle('qqmusic:server-restart', async () => {
    const srv = getServer()
    if (!srv) return false
    await srv.restart()
    return srv.status
  })

  // ---- QQ 音乐 Cookie（设置页配置，解锁 VIP/版权歌曲） ----
  ipcMain.handle('qqmusic:get-cookie', () => {
    const c = settingsRepo.get('qqCookie')
    return typeof c === 'string' ? c : ''
  })
  // 保存 cookie 并重启 QQ 服务使其生效
  ipcMain.handle('qqmusic:set-cookie', async (_e, cookie) => {
    settingsRepo.set('qqCookie', String(cookie || '').trim())
    const srv = getServer()
    if (srv) await srv.restart()
    return true
  })
}

/**
 * 把 qqmusic-api 返回的原始歌曲对象归一化成统一格式。
 * 与网易云歌曲字段对齐，方便前端合并展示。
 */
function normalizeQqSong(raw) {
  const name = raw?.songname || raw?.name || raw?.title || ''
  const artists = raw?.singer || raw?.singer_name || raw?.artist || ''
  const artistArr = Array.isArray(artists) ? artists.map((a) => a.name || a).filter(Boolean) : [artists].filter(Boolean)
  const album = raw?.albumname || raw?.album || raw?.album_name || ''
  const albummid = raw?.albummid || raw?.album_id || ''
  // qqmusic 的歌曲 ID 是 songmid（字符串，如 '003J0g3G1IRz3G'）
  // duration: interval 是秒，dt 是毫秒
  const dur = raw?.interval ? raw.interval * 1000 : (raw?.duration || raw?.dt || 0)
  return {
    id: raw?.songmid || raw?.song_id || raw?.id || '',
    name,
    artists: artistArr,
    artist: artistArr.join(' / '),
    album,
    albumId: albummid,
    pic: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : '',
    duration: dur,
    dt: dur,
    source: 'qq',
    _raw: raw
  }
}