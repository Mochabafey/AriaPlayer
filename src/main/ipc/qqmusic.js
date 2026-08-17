import { ipcMain } from 'electron'
import http from 'http'
import https from 'https'
import { settingsRepo } from '../db/settings.js'
import { createQr, checkQr } from '../qqMusicLogin.js'

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
  // /getLyric 用 isFormat=0：返回 base64 解码后的原始 LRC **字符串**。
  // （isFormat=1 会被 Rain120 包装成 Lyric 对象 {lyric,tags,lines}，前端 parseLrc 无法处理）
  // 翻译：老接口的 trans 字段恒为空（平台不再下发），改走新版统一接口 musicu.fcg 的
  // GetPlayLyricInfo（需登录 cookie + trans:1 参数），其 trans 是 base64 编码的翻译 LRC。
  ipcMain.handle('qqmusic:lyric', async (_e, { songmid }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('QQMUSIC_SERVER_NOT_READY')
    if (!songmid) return { code: 404, lyric: '', trans: '' }
    const qs = new URLSearchParams({ songmid, isFormat: '0' }).toString()
    const json = await socketRequest(srv, `/getLyric?${qs}`)
    const raw = json?.response?.lyric
    // 兼容：isFormat=0 返回字符串；若偶发对象则取 .lyric 字段
    const lyric = typeof raw === 'string' ? raw : (raw?.lyric ?? '')
    const trans = await fetchQqTrans(songmid)
    return { code: lyric ? 200 : 404, lyric, trans }
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

  // ---- QQ 音乐扫码登录 ----
  // 生成二维码：返回 { qrsig, token, image(base64 dataURL) }
  ipcMain.handle('qqmusic:login-qr', async () => {
    try {
      const r = await createQr()
      console.log(`[qq-login] createQr OK img=${r.image.length}B qrsig=${r.qrsig.slice(0, 8)} token=${r.token}`)
      return r
    } catch (e) {
      console.log(`[qq-login] createQr FAIL: ${e?.message || e}`)
      throw e
    }
  })
  // 轮询扫码状态：65 等待 / 66 已扫待确认 / 67 失效 / 0 成功
  // 成功后自动保存 cookie + 昵称并重启 QQ 服务
  ipcMain.handle('qqmusic:login-check', async (_e, { qrsig, token, cookie }) => {
    const r = await checkQr(qrsig, token, cookie)
    const keys = r.cookie ? r.cookie.split('; ').map((c) => c.split('=')[0]) : []
    console.log(`[qq-login] checkQr code=${r.code} msg=[${r.msg}] nick=[${r.nick}] cookieKeys=[${keys.join(',')}] len=${r.cookie?.length || 0}`)
    if (r.code === 0 && r.cookie) {
      settingsRepo.set('qqCookie', r.cookie)
      if (r.nick) settingsRepo.set('qqNick', r.nick)
      console.log(`[qq-login] login success, cookie saved (${r.cookie.length} chars), restarting qqmusic service`)
      const srv = getServer()
      if (srv) await srv.restart()
    }
    return r
  })
  // 退出登录：清空 QQ cookie
  ipcMain.handle('qqmusic:login-clear', async () => {
    settingsRepo.set('qqCookie', '')
    settingsRepo.set('qqNick', '')
    const srv = getServer()
    if (srv) await srv.restart()
    return true
  })
  // 当前 QQ 昵称（登录态展示用）
  ipcMain.handle('qqmusic:get-nick', () => {
    const n = settingsRepo.get('qqNick')
    return typeof n === 'string' ? n : ''
  })

  // ---- QQ 音乐智能聚合搜索（smartbox：歌手/专辑/MV 各几条，用于聚合界面）----
  ipcMain.handle('qqmusic:smartbox', async (_e, { keyword }) => {
    const srv = getServer()
    if (!srv || srv.status !== 'ready') throw new Error('QQMUSIC_SERVER_NOT_READY')
    if (!keyword) return { code: 200, artists: [], albums: [], mvs: [] }
    const json = await socketRequest(srv, `/getSmartbox?key=${encodeURIComponent(keyword)}`)
    const data = json?.response?.data || {}
    return {
      code: 200,
      artists: (data.singer?.itemlist || []).map(normalizeQqArtist),
      albums: (data.album?.itemlist || []).map(normalizeQqAlbum),
      mvs: (data.mv?.itemlist || []).map(normalizeQqMv)
    }
  })
}

/** QQ musicu.fcg 签名（g_tk 由 skey 经 hash33 计算） */
function getGtk(skey) {
  if (!skey) return 5381
  let hash = 5381
  for (const c of skey) hash += (hash << 5) + c.charCodeAt(0)
  return hash & 0x7fffffff
}

/**
 * 从新版统一接口 musicu.fcg 的 GetPlayLyricInfo 拿歌词翻译。
 * 老接口 /getLyric 的 trans 恒空；此接口带 trans:1 参数才返回，
 * trans 为 base64 编码的翻译 LRC。需登录 cookie（skey 算 g_tk）。
 * 未登录/失败返回空串（前端保持纯原词）。
 */
function fetchQqTrans(songmid) {
  return new Promise((resolve) => {
    try {
      const c = settingsRepo.get('qqCookie')
      const cookie = typeof c === 'string' ? c : ''
      const skey = cookie.match(/skey=([^;]*)/)?.[1] || ''
      const uin = cookie.match(/uin=([^;]*)/)?.[1] || ''
      const body = JSON.stringify({
        req_0: {
          module: 'music.musichallSong.PlayLyricInfo',
          method: 'GetPlayLyricInfo',
          param: { songMID: songmid, qrc: 1, nobase64: 0, musicVer: 0, lyricVer: 0, trans: 1 }
        },
        comm: { ct: 19, cv: 1880, uin }
      })
      const path = `/cgi-bin/musicu.fcg?data=${encodeURIComponent(body)}&format=json&g_tk=${getGtk(skey)}`
      const req = https.get(
        {
          hostname: 'u.y.qq.com',
          path,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://y.qq.com/', Cookie: cookie }
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf-8')
              const trans = JSON.parse(raw).req_0?.data?.trans || ''
              resolve(trans ? Buffer.from(trans, 'base64').toString('utf-8') : '')
            } catch {
              resolve('')
            }
          })
        }
      )
      req.on('error', () => resolve(''))
      req.setTimeout(10000, () => req.destroy())
      req.end()
    } catch {
      resolve('')
    }
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

/** smartbox 歌手项 → 统一格式（id 用 singer_mid，前端/artist/:id 与网易云数字 id 不同源） */
function normalizeQqArtist(raw) {
  return {
    id: raw?.mid || raw?.id || '',
    name: raw?.name || '',
    pic: String(raw?.pic || '').replace(/^http:\/\//, 'https://'),
    source: 'qq'
  }
}

/** smartbox 专辑项 */
function normalizeQqAlbum(raw) {
  return {
    id: raw?.mid || raw?.id || '',
    name: raw?.name || '',
    artist: raw?.singer || '',
    pic: String(raw?.pic || '').replace(/^http:\/\//, 'https://'),
    source: 'qq'
  }
}

/** smartbox MV 项（id 用 vid，播放需 QQ 专属接口） */
function normalizeQqMv(raw) {
  return {
    id: raw?.vid || raw?.id || '',
    name: raw?.name || '',
    artist: raw?.singer || '',
    source: 'qq'
  }
}