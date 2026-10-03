/**
 * biliClient.js — B 站 Web API 客户端（主进程侧）
 *
 * 实现要点（均为实测确认，非文档推断）：
 *   - WBI 签名：2023 年后 B 站给 web 接口加了 w_rid/wts 签名。密钥来自 nav 接口
 *     的 wbi_img.img_url / sub_url，按固定混淆表重排得 mixinKey，再对参数排序拼接 MD5。
 *     实测未签名也能取流，但签名更稳（B 站对未签名请求有频控倾向）。
 *   - 取流双路径：
 *       durl（fnval=0）   → 单文件 mp4，<video> 可直接播，零 ffmpeg 开销、秒开
 *       dash（fnval=4048）→ 音视频分离，画质档位全（最高 4K），需 ffmpeg 合流
 *     策略：优先 durl（快），拿不到或需要高清时才用 dash。
 *   - 防盗链：B 站 CDN 校验 Referer + User-Agent，缺了会 403。
 *   - 扫码登录：qrcode/generate 拿 qrcode_key → 轮询 poll。
 *     状态码 86101=未扫码 / 86090=已扫码待确认 / 0=成功 / 86038=已失效。
 *     未登录只能拿 480P，登录后可解锁 1080P/4K（视账号会员状态）。
 */
import https from 'https'
import crypto from 'crypto'
import { settingsRepo } from './db/settings.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/** WBI 混淆表（固定值，来自 B 站前端 JS） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

/** 画质 id → 展示名（B 站官方命名） */
export const QUALITY_NAMES = {
  127: '超高清 8K',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '超清 4K',
  116: '高清 1080P60',
  112: '高清 1080P+',
  100: '智能修复',
  80: '高清 1080P',
  74: '高清 720P60',
  64: '高清 720P',
  32: '清晰 480P',
  16: '流畅 360P',
  6: '极速 240P'
}

/** 请求 B 站接口（Node https，手动带防盗链头） */
export function biliRequest(url, { headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const reqHeaders = {
      'User-Agent': UA,
      Referer: REFERER,
      Origin: 'https://www.bilibili.com',
      ...headers
    }
    // 带上登录 cookie（有则带，无则匿名请求）
    const cookie = cookieHeader()
    if (cookie) reqHeaders.Cookie = cookie
    if (body) reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded'

    const r = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: reqHeaders },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const text = buf.toString('utf-8')
          let json = null
          try { json = JSON.parse(text) } catch { /* 非 JSON（如二维码图片流） */ }
          // buffer 也回传：弹幕接口返回 deflate 压缩的 XML，
          // 转成 utf-8 字符串会损坏二进制数据，必须拿原始 buffer 解压
          resolve({ status: res.statusCode, headers: res.headers, text, json, buffer: buf })
        })
      }
    )
    r.on('error', reject)
    r.setTimeout(20000, () => r.destroy(new Error('bili request timeout')))
    if (body) r.write(body)
    r.end()
  })
}

/* ---------------- Cookie 管理 ---------------- */

/** 内存 cookie jar（B 站登录态：SESSDATA / bili_jct / DedeUserID 等） */
let biliCookies = {}
let loaded = false

/** 从 settings 加载持久化的 cookie */
function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    const raw = settingsRepo.get('biliCookie')
    if (raw && typeof raw === 'string') biliCookies = JSON.parse(raw)
  } catch {
    biliCookies = {}
  }
}

function cookieHeader() {
  ensureLoaded()
  const parts = Object.entries(biliCookies)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${v}`)
  return parts.join('; ')
}

/** 吸收响应里的 Set-Cookie */
function absorbCookies(res) {
  const sc = res.headers['set-cookie']
  const arr = Array.isArray(sc) ? sc : sc ? [sc] : []
  let changed = false
  for (const c of arr) {
    const kv = String(c).split(';')[0].trim()
    const i = kv.indexOf('=')
    if (i <= 0) continue
    const k = kv.slice(0, i)
    const v = kv.slice(i + 1)
    if (v === '') continue // 跳过清除型 cookie（同名空值不覆盖真实值）
    if (biliCookies[k] !== v) {
      biliCookies[k] = v
      changed = true
    }
  }
  if (changed) persist()
  return changed
}

function persist() {
  try {
    settingsRepo.set('biliCookie', JSON.stringify(biliCookies))
  } catch { /* ignore */ }
}

/** 保存用户手动粘贴的 cookie 字符串 */
export function setCookieString(str) {
  const obj = {}
  for (const pair of String(str || '').split(';')) {
    const kv = pair.trim()
    const i = kv.indexOf('=')
    if (i > 0) obj[kv.slice(0, i)] = kv.slice(i + 1)
  }
  biliCookies = obj
  loaded = true
  persist()
  return Object.keys(obj)
}

export function clearCookie() {
  biliCookies = {}
  loaded = true
  persist()
}

export function getCookieString() {
  return cookieHeader()
}

/* ---------------- WBI 签名 ---------------- */

let wbiCache = { mixinKey: '', at: 0 }
const WBI_TTL = 30 * 60 * 1000 // 密钥有效期较长，缓存 30 分钟

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

/** 按混淆表重排出 mixinKey（前 32 位） */
function mixinKeyOf(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

/** 取 mixinKey（带缓存；失败时返回空串，调用方走未签名路径） */
async function getMixinKey() {
  if (wbiCache.mixinKey && Date.now() - wbiCache.at < WBI_TTL) return wbiCache.mixinKey
  try {
    const res = await biliRequest('https://api.bilibili.com/x/web-interface/nav')
    const wbi = res.json?.data?.wbi_img
    if (!wbi) return ''
    const imgKey = wbi.img_url.split('/').pop().split('.')[0]
    const subKey = wbi.sub_url.split('/').pop().split('.')[0]
    wbiCache = { mixinKey: mixinKeyOf(imgKey + subKey), at: Date.now() }
    return wbiCache.mixinKey
  } catch {
    return ''
  }
}

/** 给参数加 WBI 签名（wts + w_rid） */
async function signParams(params) {
  const mixinKey = await getMixinKey()
  if (!mixinKey) {
    // 签名不可用：退回未签名（实测取流仍可用，只是少了频控保护）
    return new URLSearchParams(params).toString()
  }
  const wts = Math.round(Date.now() / 1000)
  const p = { ...params, wts }
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      // B 站前端会过滤这些字符，不过滤会导致签名不匹配
      const v = String(p[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  return `${query}&w_rid=${md5(query + mixinKey)}`
}

/* ---------------- 业务接口 ---------------- */

/** 检查登录态 */
export async function checkLogin() {
  try {
    const res = await biliRequest('https://api.bilibili.com/x/web-interface/nav')
    absorbCookies(res)
    const d = res.json?.data
    if (res.json?.code === -101 || !d?.isLogin) {
      return { loggedIn: false }
    }
    return {
      loggedIn: true,
      uname: d.uname,
      mid: d.mid,
      face: d.face,
      vip: d.vipStatus === 1,
      vipLabel: d.vip_label?.text || '',
      level: d.level_info?.current_level
    }
  } catch {
    return { loggedIn: false }
  }
}

/**
 * 搜索视频。
 * 用 wbi/search/type（带签名），返回归一化后的列表。
 */
export async function searchVideos(keyword, page = 1, pageSize = 20) {
  const qs = await signParams({
    search_type: 'video',
    keyword,
    page,
    page_size: pageSize
  })
  const res = await biliRequest(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`)
  absorbCookies(res)
  const j = res.json
  if (!j || j.code !== 0) {
    throw new Error(`B站搜索失败：${j?.message || '未知错误'}（code=${j?.code}）`)
  }
  const list = j.data?.result || []
  return list.map((v) => ({
    bvid: v.bvid,
    aid: v.aid,
    title: String(v.title || '').replace(/<[^>]+>/g, ''), // 搜索结果标题带高亮标签
    author: v.author,
    mid: v.mid,
    // duration 形如 "5:56" 或 "22:0"，统一转秒
    duration: parseDuration(v.duration),
    pic: normPic(v.pic), // 协议相对 //i0.hdslb.com/... → https
    play: v.play,
    danmaku: v.video_review,
    pubdate: v.pubdate,
    description: v.description
  }))
}

function parseDuration(s) {
  if (typeof s === 'number') return s
  const parts = String(s || '').split(':').map((x) => parseInt(x, 10) || 0)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

function normPic(p) {
  const s = String(p || '')
  if (!s) return ''
  if (s.startsWith('//')) return 'https:' + s
  return s.replace(/^http:/, 'https:')
}

/**
 * 取视频详情（含 cid）。
 * cid 是取流的必需参数，只能从这里拿。
 */
export async function videoInfo(bvid) {
  const res = await biliRequest(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  )
  absorbCookies(res)
  const j = res.json
  if (!j || j.code !== 0) {
    throw new Error(`获取视频信息失败：${j?.message || '未知错误'}（code=${j?.code}）`)
  }
  const d = j.data
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    desc: d.desc,
    pic: normPic(d.pic),
    duration: d.duration,
    owner: { mid: d.owner?.mid, name: d.owner?.name, face: normPic(d.owner?.face) },
    stat: {
      view: d.stat?.view,
      danmaku: d.stat?.danmaku,
      like: d.stat?.like,
      coin: d.stat?.coin,
      favorite: d.stat?.favorite,
      share: d.stat?.share
    },
    pubdate: d.pubdate,
    // 分P：多 P 视频需要按 cid 分别取流
    pages: (d.pages || []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration
    }))
  }
}

/**
 * 取播放地址。
 *
 * ⚠️ 档位表必须始终取自 DASH 请求（fnval=4048）：
 *    durl 请求（fnval=0）返回的 accept_quality 是**残缺的**，实测只有
 *    [64,16]（720P/360P），而 DASH 返回 [120,112,80,64,32,16]（含 4K/1080P）。
 *    早期实现首次播放走 durl 并把它的残缺档位表交给前端，导致画质菜单
 *    只剩「高清 720P / 流畅 360P」两项 —— 用户看不到更高画质。
 *
 * 策略：
 *   1. 先请求 DASH 拿到**完整档位表**（这是 UI 画质菜单的数据源）
 *   2. 若用户选的档位 ≤ durl 能提供的上限（通常 720P），且是首次播放，
 *      再用 durl 拿单文件（免合流、秒开）
 *   3. 更高画质只能走 DASH + ffmpeg 合流
 *
 * @param {string} bvid
 * @param {number|string} cid
 * @param {object} opts
 *   - qn: 期望画质 id（如 80=1080P）；不传则由 B 站给默认（未登录通常 480P）
 *   - preferSingle: 允许用 durl 单文件加速（默认 true；仅对低画质生效）
 * @returns {{ mode:'durl'|'dash', url?, quality, qualityName, acceptQuality, acceptDesc,
 *             video?, audio?, duration? }}
 */
export async function playUrl(bvid, cid, opts = {}) {
  const { qn, preferSingle = true } = opts

  // ---- 1. 先取 DASH（拿完整档位表 + 分离流地址）----
  const dash = await fetchDash(bvid, cid, qn)

  /**
   * 2. 判断是否值得改用 durl 单文件加速。
   *    只在「目标画质在 durl 支持范围内」时尝试 —— durl 上限通常是 720P。
   *    已知 durl 的 accept_quality 是 [64,16]，故用 64 作为门槛判断；
   *    不写死 64 而是取一次 durl 档位表来比对，避免上游策略变化后失效。
   */
  if (preferSingle) {
    const single = await tryDurl(bvid, cid, qn)
    if (single) {
      // durl 实际给出的档位若与 DASH 目标档位一致（说明该画质 durl 也支持），
      // 就用 durl（快）；否则保留 DASH 结果（画质优先）
      const sameQuality = Number(single.quality) === Number(dash.quality)
      if (sameQuality) {
        // 档位表用 DASH 的（完整），不用 durl 的残缺表
        return {
          ...single,
          acceptQuality: dash.acceptQuality,
          acceptDesc: dash.acceptDesc
        }
      }
    }
  }

  // ---- 3. 走高画质：DASH + 合流 ----
  return dash
}

/** 尝试拿 durl 单文件 */
async function tryDurl(bvid, cid, qn) {
  const params = { bvid, cid, fnval: 0, fourk: 1 }
  if (qn) params.qn = qn
  const qs = await signParams(params)
  const res = await biliRequest(`https://api.bilibili.com/x/player/wbi/playurl?${qs}`)
  absorbCookies(res)
  const d = res.json?.data
  const seg = d?.durl?.[0]
  if (!seg?.url) return null
  return {
    mode: 'durl',
    url: seg.url,
    backupUrls: (seg.backup_url || []).filter(Boolean),
    quality: d.quality,
    qualityName: QUALITY_NAMES[d.quality] || `画质 ${d.quality}`,
    acceptQuality: d.accept_quality || [],
    acceptDesc: d.accept_description || [],
    duration: Math.round((seg.length || 0) / 1000),
    size: seg.size || 0,
    // durl 响应体不含编码字段（不像 dash 那样给 codecs 列表），
    // 无法在不下载的情况下得知真实编码。故留空 —— 前端不显示，
    // 也不要写「通常为 H.264」这类未经证实的猜测（曾因此误导排障）。
    codecs: ''
  }
}

/** 取 DASH 分离流 */
async function fetchDash(bvid, cid, qn) {
  const params = { bvid, cid, fnval: 4048, fourk: 1 }
  if (qn) params.qn = qn
  const qs = await signParams(params)
  const res = await biliRequest(`https://api.bilibili.com/x/player/wbi/playurl?${qs}`)
  absorbCookies(res)
  const j = res.json
  if (!j || j.code !== 0) {
    throw new Error(`获取播放地址失败：${j?.message || '未知错误'}（code=${j?.code}）`)
  }
  const d = j.data
  const dash = d.dash
  if (!dash || !dash.video?.length) {
    // 没给 dash：退回 durl（强制）
    const fallback = await tryDurl(bvid, cid, qn)
    if (fallback) return fallback
    throw new Error('该视频没有可用的播放流')
  }

  // 按画质 id 选视频流；未指定则取当前 quality 对应的
  const targetQn = qn || d.quality
  const videoList = dash.video
  const byQn =
    videoList.filter((v) => v.id === targetQn).length
      ? videoList.filter((v) => v.id === targetQn)
      : videoList.slice().sort((a, b) => b.id - a.id)

  /**
   * 编码优先级：avc > av1 > hev。
   *
   * 关键：Chromium（Electron 内核）**默认不支持 HEVC/H.265 解码**（专利授权），
   * 拿到 hev 流会「时长正常、音频能播，但画面全黑（videoWidth=0）」。
   * B 站同一画质通常同时提供 avc/hev/av1 三种编码，故必须显式挑 avc。
   * av1 次选：新版 Chromium 支持，但硬解依赖设备；avc 兼容性最好。
   */
  const codecRank = (c) => {
    const s = String(c || '').toLowerCase()
    if (s.startsWith('avc') || s.includes('avc1')) return 0
    if (s.startsWith('av01') || s.includes('av1')) return 1
    if (s.startsWith('hev') || s.includes('hvc1') || s.includes('hev1')) return 2
    return 3
  }
  const video = byQn.slice().sort((a, b) => codecRank(a.codecs) - codecRank(b.codecs))[0]

  // 音频优先选最高码率
  const audio = (dash.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]

  /**
   * 诊断：高码率流（1080P+ / 4K）合流卡住时，需要确认拿到的流地址与参数。
   * 记录分辨率/码率/编码，便于判断是「上游降级」还是「地址失效」。
   */
  console.log(
    `[bili-dash] 请求qn=${qn ?? '(默认)'} 实得=${video?.id}(${video?.width}x${video?.height}) ` +
    `codec=${video?.codecs} bw=${Math.round((video?.bandwidth || 0) / 1000)}kbps ` +
    `audio=${audio?.codecs} ${Math.round((audio?.bandwidth || 0) / 1000)}kbps ` +
    `可用档位=[${[...new Set(videoList.map((v) => v.id))].join(',')}]`
  )

  // 记录该画质下所有可用编码，便于排障时判断是否只有 HEVC
  const availableCodecs = byQn.map((v) => v.codecs)

  return {
    mode: 'dash',
    video: {
      url: video.baseUrl || video.base_url,
      backupUrls: (video.backupUrl || video.backup_url || []).filter(Boolean),
      id: video.id,
      width: video.width,
      height: video.height,
      codecs: video.codecs,
      bandwidth: video.bandwidth
    },
    audio: audio
      ? {
          url: audio.baseUrl || audio.base_url,
          backupUrls: (audio.backupUrl || audio.backup_url || []).filter(Boolean),
          id: audio.id,
          codecs: audio.codecs,
          bandwidth: audio.bandwidth
        }
      : null,
    quality: video.id,
    qualityName: QUALITY_NAMES[video.id] || `${video.height}P`,
    acceptQuality: d.accept_quality || [],
    acceptDesc: d.accept_description || [],
    duration: d.dash.duration || 0,
    availableCodecs,
    /** 该画质只有 HEVC 时提示：Chromium 解不了，会黑屏 */
    hevcOnly: codecRank(video.codecs) === 2
  }
}

/* ---------------- 扫码登录 ---------------- */

/** 申请登录二维码 */
export async function qrGenerate() {
  const res = await biliRequest(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
  )
  absorbCookies(res)
  const j = res.json
  if (!j || j.code !== 0 || !j.data) {
    throw new Error(`申请二维码失败：${j?.message || '未知错误'}`)
  }
  return { url: j.data.url, qrcodeKey: j.data.qrcode_key }
}

/**
 * 轮询扫码状态。
 * code: 86101=未扫码 / 86090=已扫码待确认 / 0=成功 / 86038=已失效
 */
export async function qrPoll(qrcodeKey) {
  const res = await biliRequest(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`
  )
  const changed = absorbCookies(res)
  const j = res.json
  const d = j?.data || {}
  const code = d.code
  // 成功：cookie 已随 Set-Cookie 写入 jar
  if (code === 0) {
    // 部分环境下 SESSDATA 在 body 的 url 里，兜底解析一次
    if (!biliCookies.SESSDATA && d.url) {
      try {
        const u = new URL(d.url)
        for (const [k, v] of u.searchParams.entries()) {
          if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].includes(k)) {
            biliCookies[k] = decodeURIComponent(v)
          }
        }
        persist()
      } catch { /* ignore */ }
    }
    const info = await checkLogin()
    return { code, status: 'success', message: d.message || '登录成功', ...info }
  }
  const map = {
    86101: 'waiting',   // 未扫码
    86090: 'scanned',   // 已扫码，待确认
    86038: 'expired'    // 二维码失效
  }
  return {
    code,
    status: map[code] || 'unknown',
    message: d.message || '',
    cookieChanged: changed
  }
}

/** 退出登录（清 cookie） */
export async function logout() {
  clearCookie()
  return { ok: true }
}

/* ---------------- 弹幕 ---------------- */

/**
 * 拉取并解析 B 站弹幕。
 *
 * 接口：`/x/v1/dm/list.so?oid=<cid>` 返回 **deflate 压缩的 XML**
 *（老接口，无需 WBI 签名；protobuf 版 seg.so 需要额外签名参数，故用 XML）。
 *
 * XML 形如：
 *   <d p="时间,模式,字号,颜色,时间戳,池,用户hash,行号">弹幕内容</d>
 *   p 各字段：0=出现时间(秒) 1=模式 2=字号 3=颜色(十进制RGB) 4=发送时间戳
 *            5=弹幕池 6=发送者hash 7=数据库行号
 *   模式：1/2/3=滚动  4=底部  5=顶部  6=逆向  7=高级(代码弹幕，跳过)
 *
 * @returns {Promise<Array<{time:number,text:string,mode:number,color:string,size:number}>>}
 */
export async function fetchDanmaku(cid) {
  try {
    if (!cid) return []
    const res = await biliRequest(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`)
    let xml = res.text || ''
    // deflate 压缩：正文不是以 '<' 开头就尝试解压
    if (!xml.trimStart().startsWith('<') && res.buffer?.length) {
      const zlib = await import('zlib')
      try {
        xml = zlib.inflateRawSync(res.buffer).toString('utf-8')
      } catch {
        try {
          xml = zlib.inflateSync(res.buffer).toString('utf-8')
        } catch {
          try {
            xml = zlib.gunzipSync(res.buffer).toString('utf-8')
          } catch { /* 都失败则放弃 */ }
        }
      }
    }
    if (!xml.includes('<d ')) return []

    const out = []
    // 逐条匹配 <d p="...">文本</d>；文本里可能有 &amp; 等实体
    const re = /<d p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g
    let m
    while ((m = re.exec(xml))) {
      const p = m[1].split(',')
      const time = Number(p[0])
      const mode = Number(p[1])
      const size = Number(p[2]) || 25
      const colorNum = Number(p[3]) || 16777215
      // 7=高级弹幕（代码弹幕），不解析
      if (!isFinite(time) || mode === 7) continue
      const text = decodeXmlEntities(m[2]).trim()
      if (!text) continue
      out.push({
        time,
        text,
        mode,
        size,
        // 十进制 RGB → #rrggbb
        color: '#' + colorNum.toString(16).padStart(6, '0')
      })
    }
    out.sort((a, b) => a.time - b.time)
    return out
  } catch {
    return []
  }
}

/** 解码 XML 实体（弹幕文本里 &amp; &lt; &gt; &quot; &#39; 常见） */
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

/* ---------------- 观看记录上报 ---------------- */

/**
 * 上报观看进度（心跳）。
 *
 * B 站网页播放器每隔约 15 秒调一次 `/x/click-interface/web/heartbeat`，
 * 用于记录「观看历史」与「稍后再看」的播放进度。本应用此前从未调用，
 * 所以在 B 站 App/网页的「历史记录」里看不到用咏叹调看过的视频。
 *
 * 接口要点（实测）：
 *   - POST form-urlencoded，需登录 cookie（SESSDATA）
 *   - 需要 aid + cid + bvid（三者都给最稳，不同版本接口取值不同）
 *   - `played_time` 传**当前播放位置**（秒），B 站据此记录进度
 *   - `realtime` 传本次实际播放的秒数
 *   - `type=3` 表示「视频」
 *   - 返回 code 0 为成功；未登录返回 -101，参数错返回 -400
 *
 * @param {object} p
 *   - aid, cid, bvid
 *   - playedTime: 当前播放位置（秒）
 *   - realtime:   本次实际播放时长（秒）
 *   - duration:   视频总时长（秒）
 * @returns {Promise<{ok:boolean, code?:number, message?:string}>}
 */
export async function reportProgress({ aid, cid, bvid, playedTime, realtime, duration }) {
  try {
    if (!cid || (!aid && !bvid)) return { ok: false, message: 'missing ids' }
    const form = new URLSearchParams({
      aid: String(aid || ''),
      cid: String(cid),
      bvid: String(bvid || ''),
      // type=3：普通视频（B 站内部类型枚举）
      type: '3',
      // 播放位置（秒）—— 历史记录据此显示进度
      played_time: String(Math.max(0, Math.round(playedTime || 0))),
      // 本次实际播放秒数
      realtime: String(Math.max(0, Math.round(realtime || 0))),
      // 起始位置：0 表示从头播
      start_ts: String(Math.floor(Date.now() / 1000)),
      // 播放器标识，B 站按此区分来源
      player: 'interactive',
      // 视频总时长（部分版本需要）
      ...(duration ? { video_duration: String(Math.round(duration)) } : {})
    }).toString()

    const res = await biliRequest('https://api.bilibili.com/x/click-interface/web/heartbeat', {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    absorbCookies(res)
    const code = res.json?.code
    return {
      ok: code === 0,
      code,
      message: res.json?.message || res.json?.msg || ''
    }
  } catch (e) {
    return { ok: false, message: e.message }
  }
}

/**
 * 标记「已看完」（B 站历史记录里的进度打满）。
 * 视频播到结尾时调用，让 B 站侧显示完整观看而非中途退出。
 */
export async function reportFinished({ aid, cid, bvid, duration }) {
  return reportProgress({
    aid,
    cid,
    bvid,
    playedTime: duration || 0,
    realtime: duration || 0,
    duration
  })
}

/* ---------------- 字幕 ---------------- */

/**
 * 拉取 B 站视频自带字幕（CC 字幕）。
 *
 * 注意：B 站字幕**不是所有视频都有**（需要 UP 主上传或 AI 生成），
 * 且多数需要登录 cookie 才能拿到。取不到时返回空数组，由调用方
 * 回退到「搜网易云歌词」路径。
 *
 * 流程：player/v2 拿字幕列表（含 subtitle_url）→ 下载该 URL 的 JSON。
 *
 * @returns {Promise<Array<{from:number,to:number,text:string}>>}
 */
export async function fetchSubtitle(bvid, cid) {
  try {
    const qs = await signParams({ bvid, cid })
    const res = await biliRequest(`https://api.bilibili.com/x/player/wbi/v2?${qs}`)
    absorbCookies(res)
    const list = res.json?.data?.subtitle?.subtitles || []
    if (!list.length) return []
    // 优先中文，其次第一条
    const pick =
      list.find((s) => /zh|cn/i.test(s.lan || '')) || list[0]
    let url = pick?.subtitle_url || ''
    if (!url) return []
    // 协议相对 → https
    if (url.startsWith('//')) url = 'https:' + url
    const sub = await biliRequest(url)
    const body = sub.json?.body || []
    return body
      .map((x) => ({
        from: Number(x.from) || 0,
        to: Number(x.to) || 0,
        text: String(x.content || '').trim()
      }))
      .filter((x) => x.text)
  } catch {
    return []
  }
}

/* ---------------- 标题清洗 + 歌词搜索 ---------------- */

/**
 * 从 B 站视频标题提取用于搜歌的关键词。
 *
 * 实测 B 站音乐区标题噪声很多，例如：
 *   【4K】皇后乐队《波西米亚狂想曲》MV  AI高清修复
 *   【4K60FPS】皇后乐队Queen《波西米亚狂想曲》核能现场！无法超越的经典！
 *   Queen - Bohemian Rhapsody (Official Video)
 *   百万级装备听《Bohemian Rhapsody》波西米亚狂想曲 - Queen
 *
 * 清洗策略（按顺序）：
 *   1. 去掉【】[]（）() 内的装饰内容（画质/标签/前缀）
 *   2. 去掉常见噪声词（4K/8K/MV/官方/高清修复/AI/中文字幕/现场/live…）
 *   3. 去掉尾部的话题与感叹
 *   4. 提取《》或 "" 里的歌名（B 站音乐视频惯例：歌名放书名号里）
 *
 * @returns {{ keyword: string, songName: string, artist: string }}
 */
export function cleanTitle(rawTitle) {
  let t = String(rawTitle || '')

  /**
   * 1) 优先提取《》「」"" 内的内容作为歌名。
   *
   * 关键：**不能**把【】[]（）也算进来 —— 它们装的是画质/标签
   *（【4K】【中文字幕】【Hi-Res无损】），当歌名会把关键词变成 "4K"，
   * 搜索结果全错。B 站音乐视频的歌名惯例放在书名号或引号里。
   */
  const quoted = t.match(/[《「"“]([^》」"”]{1,60})[》」"”]/)
  let songName = quoted ? quoted[1].trim() : ''

  // 2) 去掉所有括号内容（含【】[]（）），它们是标签而非歌名
  t = t.replace(/[【\[（(][^】\]）)]*[】\]）)]/g, ' ')

  // 3) 去噪声词（画质/来源/版本等）
  // 注意：中文噪声词不能加 \b（\b 在 CJK 与 ASCII 边界行为不符合预期，
  // 会导致 "AI高清修复" 这类连写词清不掉），故中文部分单独用不带 \b 的替换。
  t = t.replace(
    // 画质/帧率：含 2160P/1440P 等 —— 漏掉它们会让搜索词变成
    // 「周杰伦 晴天 2160P 版」，搜到完全无关的歌（实测搜出《布拉格广场》）
    /\b(4K|8K|2K|1080P|1440P|2160P|720P|480P|60FPS|30FPS|FPS|MV|PV|OP|ED|HD|HDR|Hi-?Res|Official|official|Video|video|Audio|audio|ver\.?|Ver\.?|version|Performance|performance|Live|LIVE|live|AI)\b/gi,
    ' '
  )
  t = t.replace(
    /(无损|官方|高清修复|高清|修复|重制|重置|中文字幕|字幕|完整版|现场版|纯享|核能现场|百万级装备听|电影|主题曲|片头曲|片尾曲|插曲|翻唱|原唱|超清|标清|流畅|版|合集|全曲|首发)/g,
    ' '
  )
  // 4) 去多余符号与空白
  t = t.replace(/[!！?？~～、,，.。:：;；\-—_|/\\]+/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()

  /**
   * 5) 解析歌手：
   *    若已有书名号歌名，则把「书名号及其内容」整体从剩余文本里去掉，
   *    剩下的若是一段短文本就当作歌手名。
   *    否则按「A - B」拆分（B 站常见「Artist - Song」）。
   */
  let artist = ''
  if (songName) {
    // 连书名号一起移除（只移内容会留下《》残留混进歌手名）
    let rest = t.replace(/[《「"“][^》」"”]*[》」"”]/g, ' ')
    rest = rest.replace(songName, ' ')
    rest = rest.replace(/[《》「」""'']/g, ' ')
    rest = rest.replace(/\s+/g, ' ').trim()
    // 太长的不是歌手名（多半是副标题/描述），丢弃避免污染关键词
    if (rest && rest.length <= 24 && !/[。！？!?]/.test(rest)) artist = rest
  } else {
    const parts = t.split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean)
    if (parts.length >= 2) {
      // 「Artist - Song」是 B 站/YouTube 更常见的格式
      artist = parts[0]
      songName = parts.slice(1).join(' - ')
    } else {
      songName = t
    }
  }

  // 关键词：歌名优先，带上歌手提高命中率
  const keyword = [songName, artist].filter(Boolean).join(' ').trim() || t
  return { keyword, songName, artist }
}
