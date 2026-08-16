import { protocol } from 'electron'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { Readable } from 'stream'

const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'content-encoding',
  'etag',
  'last-modified'
]

const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav'
}

/**
 * 用 Node 原生 http/https 请求上游（绕开 Chromium 网络栈）。
 * net.fetch 在代理环境对 http 目标常报 ERR_BLOCKED_BY_CLIENT，导致音频无法代理。
 * 手动跟随 3xx 重定向（Node http.get 不跟随；kuwo 等第三方源常跳转）。
 */
async function fetchUpstream(url, headers, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects')
  const res = await fetchOnce(url, headers)
  const loc = res.headers.location
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
    const next = new URL(loc, url).toString()
    res.resume() // 丢弃重定向响应体再请求下一跳
    return fetchUpstream(next, headers, redirects + 1)
  }
  return res
}

function fetchOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    let gotHeaders = false
    const req = mod.get(url, { headers }, (res) => {
      gotHeaders = true
      resolve(res)
    })
    req.on('error', reject)
    // 超时只熔断「等响应头」阶段：正文阶段 Chromium 缓冲读满会暂停读取（正常背压），
    // 若按空闲销毁连接，缓冲播完上游已被杀 → 断流卡死。此为「播一会就卡住重播」的元凶。
    req.setTimeout(20000, () => {
      if (!gotHeaders) req.destroy(new Error('upstream timeout'))
    })
  })
}

/**
 * ncm-audio:// 自定义协议：
 *  - ncm-audio://stream?url=<真实地址>  远程音频代理（绕开 CORS，透传 Range 支持 seek）
 *  - ncm-audio://local?path=<本地路径>  本地曲库播放（读文件流）
 */
export function registerAudioProtocol() {
  protocol.handle('ncm-audio', async (request) => {
    try {
      const u = new URL(request.url)
      const range = request.headers.get('range')

      if (u.hostname === 'local') {
        const p = u.searchParams.get('path')
        if (!p || !fs.existsSync(p)) return new Response('file not found', { status: 404 })
        const stat = fs.statSync(p)
        const mime = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'
        let start = 0
        let end = stat.size - 1
        if (range) {
          const m = range.match(/bytes=(\d*)-(\d*)/)
          if (m && m[1] !== '') start = parseInt(m[1], 10)
          if (m && m[2] !== '') end = Math.min(parseInt(m[2], 10), end)
        }
        const headers = {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`
        }
        const body = fs.createReadStream(p, { start, end })
        return new Response(body, { status: start > 0 ? 206 : 200, headers })
      }

      if (u.hostname === 'cover') {
        const p = u.searchParams.get('path')
        if (!p || !fs.existsSync(p)) return new Response('not found', { status: 404 })
        const ext = path.extname(p).toLowerCase()
        const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
        return new Response(fs.createReadStream(p), {
          headers: { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' }
        })
      }

      // 远程图片代理：ncm-audio://img?url=<远程图片>，用 Node http 请求（剥离系统代理，
      // 避免 Chromium 网络栈被代理软件拦截导致封面/头像加载失败 ERR_BLOCKED_BY_CLIENT）
      if (u.hostname === 'img') {
        const target = u.searchParams.get('url')
        if (!target || !/^https?:\/\//.test(target)) return new Response('invalid url', { status: 400 })
        const upstream = await fetchUpstream(target, {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Referer: 'https://music.163.com/'
        })
        if (upstream.statusCode >= 400) {
          upstream.resume()
          return new Response('upstream ' + upstream.statusCode, { status: upstream.statusCode })
        }
        const headers = {
          'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'max-age=86400'
        }
        if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length']
        return new Response(Readable.toWeb(upstream), { status: 200, headers })
      }

      const target = u.searchParams.get('url')
      if (!target || !/^https?:\/\//.test(target)) {
        return new Response('invalid url', { status: 400 })
      }
      // 白名单校验取 pathname（排除查询参数）：解灰地址形如
      // http://bd-er.kuwo.cn/.../xxx.flac?from=bodian，带 query 时全串正则永远匹配不上，
      // 会被误杀成 403 → 触发 ffmpeg 转码（整首下载从头播）或直接播放失败
      let targetPath = ''
      try { targetPath = new URL(target).pathname } catch { /* 上面已校验过协议 */ }
      const extOk = /\.(mp3|flac|m4a|aac|ogg|wav|mp4|m4s|m3u8|ts)$/i.test(targetPath)
      const hostOk = /netease|126\.net|music\.163/i.test(target)
      if (!extOk && !hostOk) {
        return new Response('url rejected', { status: 403 })
      }

      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Referer: 'https://music.163.com/'
      }
      if (range) headers['Range'] = range

      const upstream = await fetchUpstream(target, headers)
      if (upstream.statusCode >= 400) {
        upstream.resume()
        return new Response('upstream error ' + upstream.statusCode, { status: upstream.statusCode })
      }

      const respHeaders = {}
      for (const k of FORWARD_HEADERS) {
        const v = upstream.headers[k]
        if (v !== undefined) respHeaders[k] = v
      }
      if (upstream.statusCode === 206) respHeaders['Accept-Ranges'] = 'bytes'
      const webStream = Readable.toWeb(upstream)
      // Chromium 取消请求（切歌/seek 抛弃旧流）时同步断开上游，避免旧下载继续抢带宽
      request.signal?.addEventListener('abort', () => upstream.destroy())
      return new Response(webStream, { status: upstream.statusCode, headers: respHeaders })
    } catch (e) {
      console.error('[ncm-audio] proxy error', e.message)
      return new Response('proxy error', { status: 502 })
    }
  })
}
