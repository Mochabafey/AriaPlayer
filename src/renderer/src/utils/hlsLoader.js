// hls.js 自定义 loader：把 HLS 的清单/分片请求全部走 ncm-audio:// 主进程代理，
// 绕开网易云 CDN 的 CORS 限制，同时由主进程补 UA/Referer 防盗链头。
// 实现 hls.js Loader 接口：load()/abort()/destroy()。

export class NcmProxyLoader {
  constructor(config) {
    this.config = config
    this.context = null
    this.stats = {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 }
    }
    this._ctrl = null
  }

  destroy() {
    if (this._ctrl) this._ctrl.abort()
    this._ctrl = null
  }

  abort() {
    if (this._ctrl) this._ctrl.abort()
    this._ctrl = null
    this.stats.aborted = true
  }

  async load(context, config, callbacks) {
    this.context = context
    this.stats.loading.start = performance.now()

    const url = new URL(context.url)
    const proxied = `ncm-audio://stream?url=${encodeURIComponent(context.url)}`
    const headers = {}
    if (context.rangeStart != null && context.rangeEnd != null) {
      headers['Range'] = `bytes=${context.rangeStart}-${context.rangeEnd}`
    }

    this._ctrl = new AbortController()
    const signal = this._ctrl.signal

    try {
      const resp = await fetch(proxied, { signal, headers })
      if (!resp.ok) {
        this.stats.loading.end = performance.now()
        callbacks.onError({ code: resp.status, text: resp.statusText }, context, null, this.stats)
        return
      }

      const buf = await resp.arrayBuffer()
      const total = buf.byteLength
      this.stats.loaded = total
      this.stats.total = total
      this.stats.chunkCount = 1
      this.stats.loading.end = performance.now()

      callbacks.onSuccess(
        { url: context.url, data: buf, code: resp.status },
        this.stats,
        context,
        null
      )
    } catch (e) {
      if (e.name === 'AbortError') {
        callbacks.onAbort && callbacks.onAbort(this.stats, context, null)
      } else {
        this.stats.loading.end = performance.now()
        callbacks.onError({ code: -1, text: e.message }, context, null, this.stats)
      }
    }
  }
}
