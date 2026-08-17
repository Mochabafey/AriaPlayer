/**
 * QQ 扫码登录（宿主端直接对接 ssl.ptlogin2.qq.com 官方网页登录流程）。
 *
 * 流程（与官方 QQ 登录页一致）：
 *  1. createQr()  -> GET /ptqrshow 拿到二维码图片 + qrsig（hash33 得 ptqrtoken）
 *  2. checkQr()   -> 轮询 GET /ptqrlogin：
 *       65 等待扫码 | 66 已扫码待确认 | 67 已失效 | 0 成功（收集 Set-Cookie）
 *
 * 登录业务参数说明：
 *  - QQ 音乐登录（appid=716027609, daid=383）在部分出口 IP 会被腾讯定向风控
 *    直接 403（ptqrshow/ptqrlogin 均被拒），而 QQ 空间（appid=549000912,
 *    daid=5）不受影响。
 *  - 扫码登录成功后拿到的 uin/skey/p_skey 是 **QQ 账号级登录态**（ptlogin2
 *    统一签发，domain=qq.com），QQ 音乐 webapi（u.y.qq.com）用同样的
 *    uin + skey 鉴权，因此用 QQ 空间的授权流程登录、把 cookie 喂给 QQ 音乐
 *    子服务，即可解锁 VIP/版权歌曲（前提：该 QQ 号开通了绿钻/会员）。
 */

const QR_APPID = '549000912' // QQ 空间 appid（避开 QQ 音乐 daid=383 的出口风控）
const QR_DAID = '5' // QQ 空间 daid
const QR_AID = '0' // pt_3rd_aid（QQ 空间为 0）
const U1 = 'https%3A%2F%2Fqzone.qq.com' // 登录后回调地址（仅用于协议，不实际跳转）
const PT_REDIR_PTTYPE = '5'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** ptqrtoken 的 hash33 算法（QQ 登录页同款） */
function hash33(t) {
  let e = 0
  for (let i = 0, n = t.length; i < n; i++) e += (e << 5) + t.charCodeAt(i)
  return 2147483647 & e
}

/** 解析 Set-Cookie 列表，返回 {name: value}（只取首个分号前的键值对） */
function parseSetCookies(headers) {
  const out = {}
  for (const c of headers.getSetCookie()) {
    const kv = c.split(';')[0].trim()
    const i = kv.indexOf('=')
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

/**
 * 第一步：生成登录二维码。
 * @returns {{ qrsig: string, token: number, cookie: string, image: string }}
 *   image 是 data:image/png;base64 可直接 <img> 展示；cookie 是会话 cookie（含 qrsig）
 */
export async function createQr() {
  const ts = Date.now() / 1000
  const url =
    `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${QR_APPID}&e=2&l=M&s=3&d=72&v=4&t=${ts}` +
    `&da=1&daid=${QR_DAID}&pt_3rd_aid=${QR_AID}&u1=${U1}&pt_feedback_link=${U1}` +
    `&pt_redirect_aid=${QR_AID}&pt_redir_pttype=${PT_REDIR_PTTYPE}`
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/' } })
  if (!res.ok) throw new Error(`ptqrshow HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const cookies = parseSetCookies(res.headers)
  const qrsig = cookies.qrsig || ''
  if (!qrsig) throw new Error('ptqrshow 未返回 qrsig')
  // 把会话 cookie（qrsig 等）原样带回，轮询时必须带上才能识别二维码会话
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0].trim())
    .join('; ')
  return { qrsig, token: hash33(qrsig), cookie, image: `data:image/png;base64,${buf.toString('base64')}` }
}

/**
 * 第二步：轮询扫码状态。
 * @param {string} qrsig createQr 返回的 qrsig
 * @param {number} token createQr 返回的 ptqrtoken
 * @param {string} sessionCookie createQr 返回的会话 cookie（必带 qrsig）
 * @returns {{ code: number, nick: string, cookie: string }}
 *   code: 0 成功（cookie 已拼好）/ 65 等待扫码 / 66 已扫码待确认 / 67 已失效
 */
export async function checkQr(qrsig, token, sessionCookie = '') {
  const action = `0-0-${Date.now()}`
  const url =
    `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${U1}&ptqrtoken=${token}` +
    `&pt_3rd_aid=${QR_AID}&pt_feedback_link=${U1}&pt_redirect_aid=${QR_AID}&pt_redir_pttype=${PT_REDIR_PTTYPE}` +
    `&ptredirect=1&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=${action}&js_ver=26071711&js_type=1` +
    `&login_sig=&pt_uistyle=40&aid=${QR_APPID}&daid=${QR_DAID}&`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/', Cookie: sessionCookie || `qrsig=${qrsig}` }
  })
  const text = await res.text()
  // 形如 ptuiCB('0','0','https://...','QQ昵称','提示消息',...) —— 参数个数不固定，
  // 只取前 5 个参数（code/url/nick/msg），不要求立即闭合
  const m = text.match(/ptuiCB\('(\d+)','[^']*','([^']*)','([^']*)'(?:,'([^']*)')?/)
  if (!m) return { code: -1, nick: '', cookie: '', msg: '' }
  const code = Number(m[1])
  const nick = m[3] || ''
  const msg = m[4] || ''
  let loginCookie = ''
  if (code === 0) {
    const all = parseSetCookies(res.headers)
    const keys = ['uin', 'skey', 'p_skey', 'pt4_token', 'p_uin', 'qm_keyst', 'qqmusic_key', 'uin_skey']
    loginCookie = keys.filter((k) => all[k] != null && all[k] !== '').map((k) => `${k}=${all[k]}`).join('; ')
    // 兜底：ptuiCB 的 URL 里也带 skey（某些情况 Set-Cookie 不全）
    if (!all.skey && m[2]) {
      const sm = m[2].match(/[?&]skey=([^&]+)/)
      if (sm) loginCookie = `${loginCookie}; skey=${decodeURIComponent(sm[1])}`.replace(/^; /, '')
    }
    // 兜底：uin 缺失时从回调 URL 的 uin 参数取
    if (!all.uin && m[2]) {
      const um = m[2].match(/[?&]uin=([^&]+)/)
      if (um) loginCookie = `${loginCookie}; uin=${decodeURIComponent(um[1])}`.replace(/^; /, '')
    }
  }
  return { code, nick, msg, cookie: loginCookie }
}
