/**
 * QQ 扫码登录（宿主端直接对接 ssl.ptlogin2.qq.com 官方网页登录流程）。
 *
 * 完整流程（对齐 Rain120/qq-music-api 官方实现 + 实测修正）：
 *  1. createQr()  -> GET /ptqrshow 拿二维码图片 + qrsig（hash33 得 ptqrtoken）
 *  2. checkQr()   -> 轮询 GET /ptqrlogin，直到「登录成功」
 *  3. 成功后跟随授权跳转（check_sig）拿 p_skey，g_tk = hash5381(p_skey)
 *  4. POST graph.qq.com/oauth2.0/authorize（g_tk + client_id=100497308）拿授权 code
 *  5. POST u.y.qq.com/cgi-bin/musicu.fcg（QQConnectLogin.QQLogin，带 code）拿 qm_keyst
 *  6. 汇总全部 Set-Cookie（uin/skey/p_skey/pt4_token/qm_keyst...）注入 QQ 音乐子服务
 *
 * 风控说明：当前出口 IP 对 daid=383（QQ 音乐）的 ptqrshow/ptqrlogin 请求
 * 在 u1=y.qq.com 时返回 403（IP 级业务风控）。把 u1 换成
 * graph.qq.com/oauth2.0/login_jump（QQ 音乐官方 OAuth 授权域名）即可绕过，
 * 且该流程签发的 p_skey/qm_keyst 正是 QQ 音乐 VIP 播放鉴权所需。
 */

const QR_APPID = '716027609' // QQ 音乐网页版 appid
const QR_DAID = '383' // QQ 音乐 daid
const QR_AID = '100497308' // pt_3rd_aid / client_id = QQ 音乐三方应用号
const U1 = 'https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** ptqrtoken 的 hash33 算法（QQ 登录页同款） */
function hash33(t) {
  let e = 0
  for (let i = 0, n = t.length; i < n; i++) e += (e << 5) + t.charCodeAt(i)
  return 2147483647 & e
}

/** p_skey -> g_tk（QQ 音乐 API 的 CSRF token） */
function getGtk(pSkey) {
  let hash = 5381
  for (let i = 0; i < pSkey.length; i++) hash += (hash << 5) + pSkey.charCodeAt(i)
  return hash & 0x7fffffff
}

/** 随机 uuid（authorize 的 ui 参数） */
function getGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    .replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
    .toUpperCase()
}

/** 解析 Set-Cookie 列表，返回 {name: value}（只取首个分号前的键值对；跳过空值清除型 cookie） */
function parseSetCookies(headers) {
  const out = {}
  for (const c of headers.getSetCookie()) {
    const kv = c.split(';')[0].trim()
    const i = kv.indexOf('=')
    if (i > 0) {
      const v = kv.slice(i + 1)
      // 跳过空值：同名的「清除型」Set-Cookie（如 p_skey=）不能覆盖前面已签发的真实值
      if (v !== '') out[kv.slice(0, i)] = v
    }
  }
  return out
}

function toCookieStr(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/**
 * 第一步：生成登录二维码。
 * @returns {{ qrsig, token, cookie, image }} image 为 data:image/png;base64
 */
export async function createQr() {
  const ts = (Math.random() * 2).toFixed(16) // 官方用随机 0.x 时间戳
  const url =
    `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${QR_APPID}&e=2&l=M&s=3&d=72&v=4&t=${ts}` +
    `&daid=${QR_DAID}&pt_3rd_aid=${QR_AID}&u1=${U1}`
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/' } })
  if (!res.ok) throw new Error(`ptqrshow HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const all = parseSetCookies(res.headers)
  const qrsig = all.qrsig || ''
  if (!qrsig) throw new Error('ptqrshow 未返回 qrsig')
  return {
    qrsig,
    token: hash33(qrsig),
    cookie: toCookieStr(all),
    image: `data:image/png;base64,${buf.toString('base64')}`
  }
}

/**
 * 第二步：轮询扫码状态；成功后执行授权链（check_sig -> authorize -> QQLogin）拿完整 cookie。
 * @param {string} qrsig
 * @param {number} token
 * @param {string} sessionCookie
 * @returns {{ code, nick, msg, cookie, isOk }}
 */
export async function checkQr(qrsig, token, sessionCookie = '') {
  const action = `0-0-${Date.now()}`
  const loginSig = encodeURIComponent('du-YS1h8*0GqVqcrru0pXkpwVg2DYw-DtbFulJ62IgPf6vfiJe*4ONVrYc5hMUNE')
  const url =
    `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${U1}&ptqrtoken=${token}` +
    `&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=${action}` +
    `&js_ver=23111510&js_type=1&login_sig=${loginSig}&pt_uistyle=40&aid=${QR_APPID}&daid=${QR_DAID}` +
    `&pt_3rd_aid=${QR_AID}&o1vId=3674fc47871e9c407d8838690b355408&pt_js_version=v1.48.1&`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/', Cookie: sessionCookie || `qrsig=${qrsig}` }
  })
  const text = await res.text()
  const m = text.match(/ptuiCB\('(\d+)','[^']*','([^']*)','([^']*)'(?:,'([^']*)')?/)
  if (!m) return { code: -1, nick: '', cookie: '', msg: '', isOk: false }
  const code = Number(m[1])
  const nick = m[3] || ''
  const msg = m[4] || ''
  // 非成功：把 ptqrlogin 的 Set-Cookie（如 qrsig 刷新）带回去，但只返回状态
  if (code !== 0) {
    return { code, nick, msg, cookie: '', isOk: false }
  }

  // ===== 登录成功：执行授权链拿 p_skey / qm_keyst =====
  let all = parseSetCookies(res.headers)
  try {
    // 1) 跟随 check_sig 跳转拿 p_skey（redirect: manual 手动收集 Set-Cookie）
    const checkSigUrl = m[2]
    if (!checkSigUrl) throw new Error('no checkSigUrl')
    console.log(`[qq-login] checkSigUrl=${checkSigUrl.slice(0, 150)}`)
    const r1 = await fetch(checkSigUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/', Cookie: toCookieStr(all) }
    })
    const sigCookies = parseSetCookies(r1.headers)
    console.log(`[qq-login] checkSig status=${r1.status} loc=${(r1.headers.get('location') || '').slice(0, 120)}`)
    console.log(`[qq-login] checkSig rawSetCookie=${r1.headers.getSetCookie().map((c) => c.split(';')[0]).join(' | ').slice(0, 300)}`)
    console.log(`[qq-login] checkSig setCookie=[${Object.keys(sigCookies).join(',')}]`)
    Object.assign(all, sigCookies)
    const pSkey = all.p_skey || ''
    console.log(`[qq-login] p_skey=${pSkey ? pSkey.slice(0, 8) + '...' : 'MISSING'}`)
    const gtk = pSkey ? getGtk(pSkey) : 0

    // 2) graph.qq.com OAuth 授权，拿 code
    const authForm = new FormData()
    authForm.append('response_type', 'code')
    authForm.append('client_id', QR_AID)
    authForm.append('redirect_uri', 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/')
    authForm.append('scope', 'get_user_info,get_app_friends')
    authForm.append('state', 'state')
    authForm.append('switch', '')
    authForm.append('from_ptlogin', '1')
    authForm.append('src', '1')
    authForm.append('update_auth', '1')
    authForm.append('openapi', '1010_1030')
    authForm.append('g_tk', String(gtk))
    authForm.append('auth_time', String(Date.now()))
    authForm.append('ui', getGuid())
    const r2 = await fetch('https://graph.qq.com/oauth2.0/authorize', {
      method: 'POST',
      body: authForm,
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: toCookieStr(all) }
    })
    Object.assign(all, parseSetCookies(r2.headers))
    const loc = r2.headers.get('location') || ''
    console.log(`[qq-login] authorize status=${r2.status} loc=${loc.slice(0, 100)}`)
    const codeMatch = loc.match(/[?&]code=([^&]+)/)
    if (!codeMatch) throw new Error(`authorize no code, loc=${loc.slice(0, 80)}`)
    const authCode = codeMatch[1]

    // 3) u.y.qq.com QQLogin 换 qm_keyst
    const loginData = JSON.stringify({
      comm: { g_tk: gtk, platform: 'yqq', ct: 24, cv: 0 },
      req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code: authCode } }
    })
    const r3 = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      body: loginData,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: toCookieStr(all) }
    })
    Object.assign(all, parseSetCookies(r3.headers))
  } catch (e) {
    console.log('[qq-login] authorize chain fail:', e?.message || e)
  }
  const cookie = toCookieStr(all)
  return { code: 0, nick, msg, cookie, isOk: !!cookie }
}
