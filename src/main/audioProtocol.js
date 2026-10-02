import { protocol } from 'electron'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { openAudioSource, createRangeStream, sessionInfo, toWeb } from './audioCache'
import { UA, HDRS, fetchUpstream, parseSafeHttpUrl, headersFor } from './upstream.js'
import { hlsDirOf } from './biliStream.js'

const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'content-encoding',
  'etag',
  'last-modified'
]

let diagSeq = 0
// 诊断日志开关：NCM_DEBUG=1 或开发模式（ELECTRON_RENDERER_URL 存在）才打
// [audio-diag]，生产环境每个请求 4-6 行日志纯属刷屏
const DIAG_ENABLED = !!process.env.NCM_DEBUG || !!process.env.ELECTRON_RENDERER_URL
const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  // HLS：B 站实时合流产出 m3u8 播放列表 + m4s 分片（fMP4）。
  // 缺这两个类型会让 hls.js 拿到的 Content-Type 变成 octet-stream，
  // 进而误判为「不是 HLS 内容」而拒绝解析。
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4'
}

/**
 * ncm-audio:// 自定义协议：
 *  - ncm-audio://stream?url=<真实地址>  远程音频代理（绕开 CORS，透传 Range 支持 seek）
 *  - ncm-audio://local?path=<本地路径>  本地曲库播放（读文件流）
 */
export function registerAudioProtocol() {
  protocol.handle('ncm-audio', async (request) => {
    // 诊断日志：定位 seek 断流的真实环节。日志开头带序号，便于关联同一请求
    const diagId = ++diagSeq
    const t0 = Date.now()
    const diag = DIAG_ENABLED
      ? (msg) => console.log(`[audio-diag #${diagId}] +${Date.now() - t0}ms ${msg}`)
      : () => {}
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
          // CORS：页面在 file:// 下，fetch/XHR 访问自定义协议需要该头
          //（见 hls 分支的详细说明）。媒体元素不受限，但统一加上更省心。
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
        }
        // 客户端带 Range 一律回 206（Chromium media 初始请求就带 bytes=0-，
        // 回 200 会导致 seek 时 200/206 实体冲突 → ERR=2；规范也禁止 200 带 CR）
        let status = 200
        if (range) {
          status = 206
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
        }
        const body = fs.createReadStream(p, { start, end })
        return new Response(body, { status, headers })
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

      /**
       * HLS 目录通道：ncm-audio://hls/<file>?dir=<编码后的目录>
       *
       * 为什么需要它：B 站实时合流产出 m3u8 + 多个 .m4s 分片，
       * m3u8 内部用**相对路径**引用分片（seg00000.m4s）。hls.js 会基于
       * m3u8 自身的 URL 解析相对路径 —— 若 m3u8 通过
       * `ncm-audio://local?path=...` 提供，解析结果会变成
       * `ncm-audio://local/seg00000.m4s`（路径丢失，拿不到真实文件）。
       *
       * 这里让目录成为 URL 的**路径部分**，hls.js 的相对路径解析就能
       * 自然拼出 `ncm-audio://hls/seg00000.m4s?dir=...`，协议层据此还原
       * 真实文件路径。零 TCP 端口，符合项目设计。
       */
      /**
       * HLS 通道（路径式）：ncm-audio://hls/<sessionId>/<file>
       *
       * 为什么需要它：B 站实时合流产出 m3u8 + 多个 .m4s 分片，
       * m3u8 内部用**相对路径**引用分片（如 `seg00000.m4s`、
       * `#EXT-X-MAP:URI="init.mp4"`）。hls.js 用标准 URL 相对解析拼出分片
       * 地址 —— 而标准解析会**丢弃 base URL 的 query 部分**。
       *
       * 早期实现把目录放在 `?dir=` 里，结果分片请求变成
       * `ncm-audio://hls/seg00000.m4s`（dir 丢失）→ 全部 404。
       *
       * 改为把目录编码进**路径**：URL 形如
       *   ncm-audio://hls/<sessionId>/index.m3u8
       *   ncm-audio://hls/<sessionId>/seg00000.m4s
       * 相对解析只替换最后一段，sessionId 得以保留，协议层据此定位会话目录。
       * 零 TCP 端口，符合项目设计。
       */
      if (u.hostname === 'hls') {
        const segs = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
        const sessionId = segs[0]
        const file = decodeURIComponent(segs.slice(1).join('/'))
        if (!sessionId || !file) return new Response('bad hls request', { status: 400 })
        const dir = hlsDirOf(sessionId)
        if (!dir) return new Response('unknown hls session', { status: 404 })
        // 防目录穿越：解析后的绝对路径必须在会话目录之内
        const baseDir = path.resolve(dir)
        const target = path.resolve(baseDir, file)
        if (!target.startsWith(baseDir + path.sep)) {
          return new Response('forbidden', { status: 403 })
        }
        if (!fs.existsSync(target)) return new Response('not found', { status: 404 })
        const stat = fs.statSync(target)
        const mime = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
        return new Response(fs.createReadStream(target), {
          headers: {
            'Content-Type': mime,
            'Content-Length': String(stat.size),
            'Accept-Ranges': 'bytes',
            /**
             * CORS 头：页面运行在 file:// 协议下（打包版 loadFile），
             * hls.js 用 fetch/XHR 加载 m3u8 与分片 —— 跨源请求需要该头。
             * 另外还需在 registerSchemesAsPrivileged 里开 corsEnabled，
             * 否则 Chromium 在发出请求前就以 CORS 拒绝（响应头无效）。
             */
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Range',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
            // 实时合流期间列表与分片都在变，禁止缓存以免拿到旧内容
            'Cache-Control': 'no-store'
          }
        })
      }

      // 远程图片代理：ncm-audio://img?url=<远程图片>，用 Node http 请求（剥离系统代理，
      // 避免 Chromium 网络栈被代理软件拦截导致封面/头像加载失败 ERR_BLOCKED_BY_CLIENT）。
      // parseSafeHttpUrl：只放行公网 http(s)，堵 SSRF 内网探测
      if (u.hostname === 'img') {
        const target = u.searchParams.get('url')
        const safe = parseSafeHttpUrl(target)
        if (!safe) return new Response('invalid url', { status: 400 })
        const upstream = await fetchUpstream(
          safe.toString(),
          { 'User-Agent': UA, Referer: 'https://music.163.com/' },
          request.signal
        )
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
      // 安全校验：解析真实 URL 后判协议 + 非内网（堵 SSRF）。旧实现对整个
      // URL 串做子串匹配，`http://evil.com/?x=netease` 即可绕过
      const safe = parseSafeHttpUrl(target)
      if (!safe) return new Response('invalid url', { status: 400 })
      // hostname 白名单（基于解析后的真实域名，非子串匹配）：网易系 CDN +
      // 常见解灰源；否则回退看路径是否为音频文件后缀
      const hostOk = /(\.|^)(music\.163\.com|126\.net|netease\.com|163\.com|kuwo\.cn|kugou\.com|migu\.cn|qq\.com)$/i.test(
        safe.hostname
      )
      const extOk = /\.(mp3|flac|m4a|aac|ogg|wav|mp4|m4s|m3u8|ts)$/i.test(safe.pathname)
      if (!extOk && !hostOk) {
        return new Response('url rejected', { status: 403 })
      }

      /**
       * 上游请求头：Referer 按目标域名推断，而非全局写死网易云。
       *
       * 各家 CDN 都校验防盗链，用错域名直接 403：
       *   - B 站视频流用网易云 Referer → 实测 "proxy ERROR: upstream 403"
       *   - B 站边缘节点域名五花八门（xxx.edge.mountaintoys.cn、
       *     upos-sz-estgcos.bilivideo.com），无法靠白名单穷举，
       *     故由 refererFor 按域名后缀推断。
       * 也支持调用方用 ?ref= 显式覆盖（渲染层已知来源时更可靠）。
       */
      const refOverride = u.searchParams.get('ref')
      const upstreamHeaders = refOverride
        ? { ...HDRS, Referer: refOverride }
        : headersFor(safe.hostname)

      /* —— 磁盘预缓冲播放 ——
       * 起播即后台整曲下载到临时文件，播放读本地文件：
       * 网络抖动/上游限速不影响播放，seek 本地化，上游字节只拉一次。
       * 超出下载进度的 seek / 后缀 Range → 直连上游立即服务（不等顺序下载追赶）。
       * 上游停滞由 Session 内置看门狗熔断 → 播放器报网络错误 → 渲染层换源重连。 */
      let start = 0
      let end = -1
      let rawRange = null
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/)
        if (m) {
          if (m[1] === '' && m[2] !== '') {
            // 后缀 Range（bytes=-N，取文件末尾 N 字节）：Chromium 探测 M4A/MP4
            // 尾部元数据（moov atom）必发。误解析成 bytes=0-N 会拿文件头冒充尾部，
            // 解码器拿到垃圾数据 → 卡死。原样透传给上游解析
            rawRange = range
          } else {
            if (m[1] !== '') start = parseInt(m[1], 10)
            if (m[2] !== '') end = parseInt(m[2], 10)
          }
        }
      }

      const source = await openAudioSource(target, start, end, rawRange, request.signal, upstreamHeaders)
      diag(`open kind=${source.kind} start=${start} end=${end} range="${range}"`)

      // 等待音源期间请求已被取消（快速拖动 seek 时极常见）：AbortSignal 一旦
      // 已 aborted，后续 addEventListener('abort') 永远不会触发——若不在此处
      // 显式清理，直连上游连接会僵死泄漏（占带宽 → 越拖越卡）
      if (request.signal?.aborted) {
        diag('ABORTED while opening source')
        if (source.kind === 'direct') {
          try { source.res.destroy() } catch { /* ignore */ }
        } else if (source.sess?.ownsFd) {
          // 持久缓存会话：fd 已打开但无人消费，直接关掉防泄漏
          source.sess.destroy()
        }
        return new Response(null, { status: 499 })
      }

      // 直连通道：单连接透传，不落盘。挂停滞看门狗防上游静默僵死（无 error 事件
      // 的卡死），熔断后 Chromium 收到网络错误 → 渲染层恢复链接手
      if (source.kind === 'direct') {
        const { res, total, contentType } = source
        diag(`direct upstream=${res.statusCode} total=${total} cl=${res.headers['content-length'] || '-'} cr=${res.headers['content-range'] || '-'}`)
        const headers = {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes'
        }
        // 铁律：发给 Chromium 的头必须与实际转发的字节数严格一致。差一个字节，
        // Chromium 都会挂在等数据上——readyState=4 / NETWORK_IDLE 的静默卡死
        let status = res.statusCode
        let skip = 0   // 上游 200 忽略 Range（body 从 0 开始）时需丢弃的头部字节数
        let limit = -1 // 至多转发的字节数（-1 = 到上游 EOF）

        if (rawRange) {
          // 后缀 Range（bytes=-N）：Chromium 探测 M4A/MP4 尾部元数据（moov atom）
          // 必发，seek 到后面高发。body 实际只有末尾 N 字节——若按「0 到 total」
          // 改写（旧 bug），声明与实体不符 → demuxer 拿错数据 → 拖后必卡死。
          // 上游 206 时区间/长度以上游为准原样透传
          if (res.statusCode === 206 || res.headers['content-range']) {
            status = 206
            if (res.headers['content-range']) headers['Content-Range'] = res.headers['content-range']
            if (res.headers['content-length']) {
              headers['Content-Length'] = res.headers['content-length']
              limit = parseInt(res.headers['content-length'], 10) || -1
            }
          } else if (total) {
            // 上游 200 忽略后缀 Range（body 是整个文件）：丢弃头部对齐末尾 N 字节
            const n = parseInt(rawRange.match(/bytes=-(\d+)/)?.[1] || '0', 10) || 0
            const s0 = Math.max(0, total - n)
            skip = s0
            limit = total - s0
            status = 206
            headers['Content-Length'] = String(limit)
            headers['Content-Range'] = `bytes ${s0}-${total - 1}/${total}`
          } else if (res.headers['content-length']) {
            headers['Content-Length'] = res.headers['content-length'] // 长度未知：透传
          }
        } else if (range && total) {
          // 规范化响应：统一改写为与请求对齐的 206 + Content-Range + 区间
          // Content-Length，否则 Chromium media cache 按 200 完整实体管理 →
          // seek 时 200/206 实体冲突 → ERR=2。上游忽略 Range 回 200 时 body
          // 从 0 开始：skip 丢头部对齐；声明了 end 的请求 limit 截断——多发
          // 越界字节会污染连接，Chromium 实体解析错乱
          const last = end === -1 ? total - 1 : Math.min(end, total - 1)
          skip = res.statusCode === 200 ? start : 0
          limit = last - start + 1
          status = 206
          headers['Content-Length'] = String(limit)
          headers['Content-Range'] = `bytes ${start}-${last}/${total}`
        } else {
          // 无 Range / 长度未知：透传上游头
          if (res.headers['content-length']) headers['Content-Length'] = res.headers['content-length']
          if (res.headers['content-range']) headers['Content-Range'] = res.headers['content-range']
        }

        const body = new Readable({
          read() {
            flowPaused = false
            res.resume() // 下游消费恢复时继续拉上游
          }
        })
        let lastData = Date.now()
        let flowPaused = false // 下游背压主动暂停（健康），区别于上游僵死（要杀）
        let cut = false // 已按声明区间截断（正常收尾，非上游故障）
        let served = 0  // 已向 Chromium 转发的字节数
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearInterval(stall)
          diag('direct upstream end')
          try { body.push(null) } catch { /* ignore */ }
          if (cut) {
            try { res.destroy() } catch { /* ignore */ }
          }
        }
        res.on('data', (c) => {
          lastData = Date.now()
          if (skip > 0) {
            if (c.length <= skip) {
              skip -= c.length
              return
            }
            c = c.subarray(skip)
            skip = 0
          }
          if (limit !== -1 && served + c.length >= limit) {
            c = c.subarray(0, limit - served)
            cut = true
          }
          served += c.length
          if (c.length && !body.push(c)) {
            flowPaused = true
            res.pause() // 缓冲满：暂停上游防内存堆积
          }
          if (cut) return finish() // 声明区间发满：立即收尾，别让多余字节泄漏
        })
        const stall = setInterval(() => {
          // 仅在「下游在拉、上游却 10s 零字节」时熔断：背压暂停的连接是健康的
          if (!flowPaused && Date.now() - lastData > 10000) {
            clearInterval(stall)
            res.destroy(new Error('upstream stalled'))
          }
        }, 2000)
        res.on('close', () => {
          clearInterval(stall)
          diag(`direct upstream closed${request.signal?.aborted ? ' [aborted]' : ''}`)
        })
        res.on('end', finish)
        res.on('error', (e) => {
          clearInterval(stall)
          // 截断收尾触发的 destroy 不是故障：body 已正常结束，别把它毁掉
          if (cut) return
          diag(`direct upstream ERROR: ${e.message}`)
          body.destroy(new Error('upstream failed'))
        })
        request.signal?.addEventListener('abort', () => {
          clearInterval(stall)
          res.destroy()
          body.destroy()
        })
        diag(`respond status=${status} cl=${headers['Content-Length'] || '-'}`)
        return new Response(Readable.toWeb(body), { status, headers })
      }

      const sess = source.sess
      const { total, contentType } = sessionInfo(sess)
      const stream = createRangeStream(sess, start, end)
      diag(`session total=${total} downloaded=${sess.downloaded} done=${sess.done}`)

      stream.on('error', (e) => diag(`session stream ERROR: ${e.message}`))

      const respHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      }
      let status = start > 0 ? 206 : 200
      if (total) {
        const last = end === -1 ? total - 1 : Math.min(end, total - 1)
        respHeaders['Content-Length'] = String(last - start + 1)
        // 关键修复：Chromium media 管线初始请求就带 Range: bytes=0-。
        // 若返回 200（忽略 Range），media cache 把响应当「单一完整流实体」，
        // seek 时发的 Range 请求收到 206 与 200 实体冲突 → 管线判资源损坏
        // → ERR=2 网络错误（快速拖动高发）。客户端带 Range 一律回 206 +
        // Content-Range（HTTP 规范：200 不允许带 Content-Range）
        if (range) {
          status = 206
          respHeaders['Content-Range'] = `bytes ${start}-${last}/${total}`
        }
      }
      // Chromium 取消请求（切歌/seek 抛弃旧流）时结束读取流（下载会话由 LRU 管理）
      request.signal?.addEventListener('abort', () => {
        diag('ABORTED (client canceled)')
        stream.destroy()
      })
      return new Response(toWeb(stream), { status, headers: respHeaders })
    } catch (e) {
      console.error(`[audio-diag #${diagId}] +${Date.now() - t0}ms proxy ERROR: ${e.message}`)
      return new Response('proxy error', { status: 502 })
    }
  })
}
