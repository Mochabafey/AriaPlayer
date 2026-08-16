import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { Readable } from 'stream'
import { app } from 'electron'
import { getDb } from './db/index.js'

/**
 * 音频缓存（双层）：
 *  - 持久层：完整下载的歌曲存 userData/audio-cache/，元数据入 SQLite（audio_cache 表）。
 *    再次播放同一 URL 直接读本地文件，零网络。超上限按 lastAccessAt LRU 淘汰。
 *  - 会话层：起播时后台整曲下载到 .tmp/（Spotify 式预缓冲），播放全程读本地文件；
 *    从头下载且完整的会话结束时自动转正进持久层。
 * 上游停滞 >10s 由看门狗 destroy → 播放器收到网络错误 → 渲染层换源重连。
 */

const STALL_MS = 10000
const CHUNK = 1 << 16
const MAX_SESSIONS = 6
const DEFAULT_LIMIT_MB = 2048

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const HDRS = { 'User-Agent': UA, Referer: 'https://music.163.com/' }

function cacheRoot() {
  return path.join(app.getPath('userData'), 'audio-cache')
}
function tmpDir() {
  return path.join(cacheRoot(), '.tmp')
}

/** 上限（字节）：设置 audioCacheLimitMB，0 = 禁用持久缓存（仅临时预缓冲） */
function limitBytes() {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('audioCacheLimitMB')
    const mb = row ? Number(JSON.parse(row.value)) : DEFAULT_LIMIT_MB
    return Number.isFinite(mb) ? mb * 1024 * 1024 : DEFAULT_LIMIT_MB * 1024 * 1024
  } catch {
    return DEFAULT_LIMIT_MB * 1024 * 1024
  }
}

function urlKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex')
}

/* ---- 启动初始化：建目录、清半成品、去孤儿 ---- */
export function initAudioCache() {
  try {
    fs.mkdirSync(cacheRoot(), { recursive: true })
    fs.mkdirSync(tmpDir(), { recursive: true })
    fs.rmSync(tmpDir(), { recursive: true, force: true })
    fs.mkdirSync(tmpDir(), { recursive: true })
  } catch { /* ignore */ }
  try {
    const known = new Set()
    for (const r of getDb().prepare('SELECT key, file FROM audio_cache').all()) {
      known.add(r.file)
      // 元数据指向的文件丢失/大小不符 → 删记录（下次播放重新下载）
      try {
        const st = fs.statSync(path.join(cacheRoot(), r.file))
        if (!st.isFile()) throw new Error('not file')
      } catch {
        getDb().prepare('DELETE FROM audio_cache WHERE key = ?').run(r.key)
        known.delete(r.file)
      }
    }
    // 磁盘孤儿文件（无元数据）→ 删除
    for (const name of fs.readdirSync(cacheRoot())) {
      if (!name.endsWith('.audio') || known.has(name)) continue
      try { fs.rmSync(path.join(cacheRoot(), name), { force: true }) } catch { /* ignore */ }
    }
    enforceLimit()
  } catch (e) {
    console.warn('[audio-cache] init failed', e.message)
  }
}

/* ---- 持久层 ---- */

function lookupPersisted(url) {
  const key = urlKey(url)
  let row
  try {
    row = getDb().prepare('SELECT * FROM audio_cache WHERE key = ?').get(key)
  } catch {
    return null
  }
  if (!row) return null
  const file = path.join(cacheRoot(), row.file)
  try {
    const fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size !== row.size) throw new Error('size mismatch')
    getDb().prepare('UPDATE audio_cache SET lastAccessAt = ? WHERE key = ?').run(Date.now(), key)
    return { fd, size, contentType: row.contentType, file }
  } catch {
    try { getDb().prepare('DELETE FROM audio_cache WHERE key = ?').run(key) } catch { /* ignore */ }
    try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
    return null
  }
}

/** 下载加速：URL 命中持久缓存时把本地文件直接拷到 dest（零网络）。
 *  返回 { ok: true, size }；未命中/拷贝失败返回 { ok: false }，调用方回退网络下载。 */
export function copyFromCache(url, dest) {
  const hit = lookupPersisted(url)
  if (!hit) return { ok: false }
  try {
    fs.closeSync(hit.fd) // 只拷文件不读内容
    fs.copyFileSync(hit.file, dest)
    return { ok: true, size: hit.size }
  } catch (e) {
    console.warn('[audio-cache] copy to download failed', e.message)
    try { fs.rmSync(dest, { force: true }) } catch { /* ignore */ }
    return { ok: false }
  }
}

/** 完整持久文件的伪会话：接口与下载 Session 一致，供 createRangeStream 消费。
 *  ownsFd：读取流关闭时由流自己关 fd（持久文件不进 sessions LRU） */
function persistedSession(hit) {
  return {
    fd: hit.fd,
    downloaded: hit.size,
    total: hit.size,
    contentType: hit.contentType,
    done: true,
    failed: false,
    error: null,
    watchers: new Set(),
    ownsFd: true,
    lastReadAt: Date.now(),
    touch() {
      this.lastReadAt = Date.now()
    },
    destroy() {
      try { fs.closeSync(hit.fd) } catch { /* ignore */ }
    }
  }
}

/** 超限淘汰：按 lastAccessAt 升序删到限内 */
export function enforceLimit() {
  const limit = limitBytes()
  if (limit <= 0) return
  const rows = getDb().prepare('SELECT key, file, size FROM audio_cache ORDER BY lastAccessAt ASC').all()
  let total = rows.reduce((s, r) => s + r.size, 0)
  for (const r of rows) {
    if (total <= limit) break
    try { fs.rmSync(path.join(cacheRoot(), r.file), { force: true }) } catch { /* ignore */ }
    try { getDb().prepare('DELETE FROM audio_cache WHERE key = ?').run(r.key) } catch { /* ignore */ }
    total -= r.size
  }
}

export function cacheStats() {
  let count = 0
  let bytes = 0
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM audio_cache').get()
    count = row.n
    bytes = row.b
  } catch { /* ignore */ }
  return { count, bytes, limitMB: Math.round(limitBytes() / 1024 / 1024) }
}

export function cacheClear() {
  try {
    for (const r of getDb().prepare('SELECT file FROM audio_cache').all()) {
      try { fs.rmSync(path.join(cacheRoot(), r.file), { force: true }) } catch { /* ignore */ }
    }
    getDb().exec('DELETE FROM audio_cache')
  } catch (e) {
    console.warn('[audio-cache] clear failed', e.message)
  }
  return cacheStats()
}

/* ---- 会话层（预缓冲下载） ---- */

/** 请求上游并手动跟随 3xx（Node http.get 不跟随） */
function fetchRedirect(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers }, (res) => {
      const loc = res.headers.location
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
        res.resume()
        return resolve(fetchRedirect(new URL(loc, url).toString(), headers, redirects + 1))
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('upstream timeout')))
  })
}

const sessions = new Map() // key -> Session

class Session {
  constructor(url, offset) {
    this.url = url
    this.reqOffset = offset
    this.dataStart = offset // 上游忽略 Range 返回 200 时修正为 0
    this.key = urlKey(url) + '-' + offset
    this.file = path.join(tmpDir(), this.key)
    this.fd = -1
    this.written = 0
    this.downloaded = offset // 绝对位置：已可读到的字节数（不含）
    this.total = 0 // 整个文件大小，未知为 0
    this.contentType = 'application/octet-stream'
    this.done = false
    this.failed = false
    this.persisted = false // 转正后 destroy 不删文件（归持久层管理）
    this.error = null
    this.watchers = new Set()
    this.lastReadAt = Date.now()
    this.stallTimer = null
    this.headerReady = new Promise((resolve) => {
      this._hdrResolve = resolve
    })
    sessions.set(this.key, this)
    evictOld()
    this._start()
  }

  _start() {
    try {
      this.fd = fs.openSync(this.file, 'w+') // 读写共用，供 tail 流读取
      const headers = { ...HDRS }
      if (this.reqOffset > 0) headers.Range = `bytes=${this.reqOffset}-`
      fetchRedirect(this.url, headers)
        .then((res) => {
          if (res.statusCode >= 400) {
            res.resume()
            throw new Error('upstream ' + res.statusCode)
          }
          if (res.statusCode === 200) this.dataStart = 0
          const cl = parseInt(res.headers['content-length'] || '0', 10)
          const m = String(res.headers['content-range'] || '').match(/\/(\d+)$/)
          if (m) this.total = +m[1]
          else if (cl) this.total = this.dataStart + cl
          this.contentType = res.headers['content-type'] || this.contentType
          this._hdrResolve(true)

          let lastData = Date.now()
          this.stallTimer = setInterval(() => {
            if (Date.now() - lastData > STALL_MS) {
              console.warn('[audio-cache] upstream stalled >' + STALL_MS + 'ms:', this.key)
              res.destroy(new Error('upstream stalled'))
            }
          }, 2000)
          res.on('data', (c) => {
            lastData = Date.now()
            try {
              // 同步写：回调式 fs.write 在 libuv 线程池可能乱序；音频速率下同步写无感知
              fs.writeSync(this.fd, c)
              this.written += c.length
              this.downloaded = this.dataStart + this.written
              this._notify()
            } catch (e) {
              res.destroy(e)
            }
          })
          res.on('end', () => {
            clearInterval(this.stallTimer)
            this.done = true
            this._persist()
            this._notify()
          })
          res.on('error', (e) => this._fail(e))
        })
        .catch((e) => this._fail(e))
    } catch (e) {
      this._fail(e)
    }
  }

  /** 从头下载且完整 → 转正进持久层（rename + 元数据 + LRU） */
  _persist() {
    if (this.dataStart !== 0 || this.total <= 0 || this.downloaded !== this.total) return
    if (limitBytes() <= 0) return // 持久缓存被禁用
    const key = urlKey(this.url)
    const name = key + '.audio'
    try {
      fs.closeSync(this.fd)
      fs.renameSync(this.file, path.join(cacheRoot(), name))
      getDb()
        .prepare(`INSERT OR REPLACE INTO audio_cache (key, url, file, size, contentType, createdAt, lastAccessAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(key, this.url, name, this.total, this.contentType, Date.now(), Date.now())
      // 重开只读 fd，正在播放的 tail 流无感继续
      this.fd = fs.openSync(path.join(cacheRoot(), name), 'r')
      this.persisted = true
      enforceLimit()
    } catch (e) {
      console.warn('[audio-cache] persist failed', e.message)
    }
  }

  _fail(e) {
    clearInterval(this.stallTimer)
    this.failed = true
    if (!this.error) this.error = e
    this._hdrResolve(true)
    this._notify()
  }

  _notify() {
    for (const w of this.watchers) w()
  }

  touch() {
    this.lastReadAt = Date.now()
  }

  destroy() {
    clearInterval(this.stallTimer)
    sessions.delete(this.key)
    try {
      if (this.fd >= 0) fs.closeSync(this.fd)
    } catch { /* ignore */ }
    if (!this.persisted) {
      try { fs.rmSync(this.file, { force: true }) } catch { /* ignore */ }
    }
  }
}

function evictOld() {
  while (sessions.size > MAX_SESSIONS) {
    let oldest = null
    for (const s of sessions.values()) {
      if (!oldest || s.lastReadAt < oldest.lastReadAt) oldest = s
    }
    if (!oldest) break
    oldest.destroy()
  }
}

// 完成后一段时间无人读 → 释放句柄；临时半成品删除，已转正的文件保留
setInterval(() => {
  const now = Date.now()
  for (const s of [...sessions.values()]) {
    if ((s.done || s.failed) && now - s.lastReadAt > 30000) s.destroy()
  }
}, 10000).unref()

/** 找覆盖 start 位置的会话（dataStart <= start，取最贴近者） */
function findSession(url, start) {
  let best = null
  for (const s of sessions.values()) {
    if (s.url !== url || s.failed) continue
    if (s.dataStart > start) continue
    if (!best || s.dataStart > best.dataStart) best = s
  }
  return best
}

/**
 * 打开音频读通道：持久缓存命中 → 本地文件会话；否则复用/新建下载会话。
 * 等响应头就绪后返回；失败抛错（协议层转 502 触发播放器重试）。
 */
export async function openAudioStream(url, start) {
  const hit = lookupPersisted(url)
  if (hit) return persistedSession(hit)
  let sess = findSession(url, start)
  if (!sess) sess = new Session(url, start)
  await sess.headerReady
  if (sess.failed) throw sess.error || new Error('audio cache failed')
  sess.touch()
  return sess
}

/**
 * tail -f 式范围读取：从 start 读到 end（-1 = 读到 EOF），
 * 追上下载进度时挂起等待，下载推进被唤醒。
 */
export function createRangeStream(sess, start, end) {
  let pos = start
  let waiter = null
  const onData = () => {
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }
  const cleanup = () => sess.watchers.delete(onData)
  sess.watchers.add(onData)

  const stream = new Readable({
    read() {
      const step = () => {
        if (sess.failed || sess.fd < 0) {
          cleanup()
          return this.destroy(sess.error || new Error('audio cache failed'))
        }
        const avail = sess.downloaded
        if (pos < avail) {
          const chunkEnd = end === -1 ? avail - 1 : Math.min(end, avail - 1)
          const len = Math.min(chunkEnd - pos + 1, CHUNK)
          try {
            const buf = Buffer.alloc(len)
            const n = fs.readSync(sess.fd, buf, 0, len, pos)
            if (n <= 0) {
              waiter = step
              return
            }
            pos += n
            this.push(buf.subarray(0, n))
          } catch (e) {
            cleanup()
            return this.destroy(e)
          }
        } else if (sess.done) {
          cleanup()
          this.push(null)
        } else {
          waiter = step // 等下载推进
        }
      }
      sess.touch()
      step()
    }
  })
  stream.on('close', () => {
    cleanup()
    // 持久文件会话：读取流独占 fd，流关即关 fd
    if (sess.ownsFd) sess.destroy()
  })
  stream.on('error', () => {
    cleanup()
    if (sess.ownsFd) sess.destroy()
  })
  return stream
}

export function sessionInfo(sess) {
  return { total: sess.total, contentType: sess.contentType }
}

export function toWeb(stream) {
  return Readable.toWeb(stream)
}
