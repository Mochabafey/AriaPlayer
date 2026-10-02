import http from 'http'
import https from 'https'

/**
 * 主进程共享的上游请求工具：
 *  - 统一 UA/Referer 常量（audioProtocol 与 audioCache 共用，消除重复实现）
 *  - fetchUpstream：Node 原生请求 + 手动跟随 3xx + abort 信号集成
 *  - URL 安全校验：堵 SSRF（内网探测）与 query 参数伪装域名绕过
 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
export const HDRS = { 'User-Agent': UA, Referer: 'https://music.163.com/' }

/**
 * 按目标域名推断防盗链 Referer。
 *
 * 各家 CDN 都会校验 Referer，用错域名直接 403：
 *   - 网易云 CDN：要 music.163.com
 *   - B 站 CDN（bilivideo.com / 各种 PCDN 边缘域名）：要 bilibili.com
 *   - QQ 音乐：要 y.qq.com
 * 旧实现全局写死网易云 Referer，导致 B 站视频流被 CDN 拒绝
 *（实测报 "proxy ERROR: upstream 403"）。
 *
 * 注意 B 站的边缘节点域名五花八门（如 xxx.edge.mountaintoys.cn、
 * upos-sz-estgcos.bilivideo.com），无法靠白名单穷举，
 * 故这里用「已知域名优先，其余保持网易云默认」的策略，
 * 而 B 站路径由调用方显式指定（见 audioProtocol 的 ref 参数）。
 */
export function refererFor(hostname, fallback = 'https://music.163.com/') {
  const h = String(hostname || '').toLowerCase()
  if (/bilibili\.com$|bilivideo\.(com|cn)$|hdslb\.com$|akamaized\.net$/.test(h)) {
    return 'https://www.bilibili.com/'
  }
  if (/qq\.com$|qqmusic\.qq\.com$/.test(h)) return 'https://y.qq.com/'
  return fallback
}

/**
 * 构造上游请求头。
 * @param {string} hostname 目标域名（用于推断 Referer）
 * @param {object} extra    额外/覆盖的头
 */
export function headersFor(hostname, extra = {}) {
  return { 'User-Agent': UA, Referer: refererFor(hostname), ...extra }
}

/**
 * 请求上游并手动跟随 3xx（Node http.get 不跟随；kuwo 等第三方源常跳转）。
 * 超时只熔断「等响应头」阶段：正文阶段下游背压暂停（如播放暂停后缓冲读满）
 * 是健康空闲，按空闲杀连接会让恢复播放瞬间断流。
 * signal：客户端放弃请求（快速拖动 seek 抛弃旧流）时立即断开上游，
 * 否则旧连接要挂满超时才死——快速拖动 N 次 = N 条僵尸连接抢带宽。
 */
export function fetchUpstream(url, headers, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    if (signal?.aborted) return reject(new Error('client aborted'))
    const mod = url.startsWith('https://') ? https : http
    let gotHeaders = false
    const req = mod.get(url, { headers }, (res) => {
      gotHeaders = true
      const loc = res.headers.location
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
        res.resume() // 丢弃重定向响应体再请求下一跳
        return resolve(fetchUpstream(new URL(loc, url).toString(), headers, signal, redirects + 1))
      }
      resolve(res)
    })
    req.on('error', reject)
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(new Error('client aborted')))
    }
    req.setTimeout(15000, () => {
      if (!gotHeaders) req.destroy(new Error('upstream timeout'))
    })
  })
}

/* ---- URL 安全校验（防 SSRF / 内网探测） ---- */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // fc00::/7 IPv6 私有
  /^\[?fe[89ab][0-9a-f]:/i // fe80::/10 IPv6 链路本地
]

/** hostname 是否指向本机/内网（字面量 + 十进制整数形式 IP 变体） */
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  for (const re of PRIVATE_HOST_PATTERNS) if (re.test(h)) return true
  // 十进制整数 IP（http://2130706433 = 127.0.0.1）与八进制变体
  if (/^\d+$/.test(h)) {
    const n = Number(h)
    if (Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff) {
      const a = (n >>> 24) & 0xff
      const b = (n >>> 16) & 0xff
      return isPrivateHost(`${a}.${b}.0.1`) || a === 127 || a === 10 || a === 0
    }
  }
  return false
}

/**
 * 解析 URL 并校验协议 + 非内网。校验失败返回 null，调用方拒绝请求。
 * 必须基于 new URL() 解析出的真实 hostname 判断——子串匹配整个 URL
 * 会被 `http://evil.com/?x=netease` 这类 query 伪装绕过。
 */
export function parseSafeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (isPrivateHost(u.hostname)) return null
  return u
}
