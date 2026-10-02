/**
 * biliStream.js — B 站播放流管理
 *
 * 职责：把 B 站的两类流统一成「一个本地可播的地址」给渲染层。
 *
 * 三条路径：
 *   durl（单文件 mp4）  → 直接交给 ncm-audio:// 代理播放，零 ffmpeg 开销、秒开
 *   dash + HLS 实时合流 → 边合边播，首片生成即可开播（默认走这条）
 *   dash + 全量合流     → 落盘完整 mp4 后播放（用于下载 / HLS 不可用时兜底）
 *
 * 为什么默认用 HLS 实时合流：
 *   全量合流要等整个视频下完才能播，用户盯着「正在合并…」等几十秒到几分钟，
 *   体验割裂。HLS 方案下 ffmpeg 边合边切分片，渲染层用 hls.js 轮询播放列表，
 *   首帧延迟从「整片时长」降到「约 1 个分片（2 秒）」。
 *
 * 缓存策略：
 *   - 全量合流的 mp4 按 bvid+cid+quality 缓存（二次播放零网络）
 *   - HLS 会话是临时的，播放结束即清理（分片很多，长期留存太占空间）
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { mergeDashStreams, mergeDashToHls } from './ffmpeg.js'
import { settingsRepo } from './db/settings.js'

/** 合流任务表：key → { promise, output, percent, speed, error } */
const jobs = new Map()

/** HLS 实时合流会话表：sessionId → { hls, dir, key, startedAt } */
const hlsSessions = new Map()
/** HLS 会话自增 id */
let hlsSeq = 0

function cacheRoot() {
  return path.join(app.getPath('userData'), 'bili-cache')
}

function ensureDir() {
  const d = cacheRoot()
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** 缓存上限（MB）：设置项 biliCacheLimitMB，默认 2048（视频大，给宽一点） */
function limitBytes() {
  try {
    const mb = Number(settingsRepo.get('biliCacheLimitMB'))
    const use = Number.isFinite(mb) && mb >= 0 ? mb : 2048
    return use * 1024 * 1024
  } catch {
    return 2048 * 1024 * 1024
  }
}

/** 缓存键：bvid + cid + 画质 */
export function cacheKeyOf(bvid, cid, quality) {
  return crypto.createHash('sha1').update(`${bvid}|${cid}|${quality}`).digest('hex').slice(0, 24)
}

function cacheFile(key) {
  return path.join(cacheRoot(), `${key}.mp4`)
}

/** 已合流的缓存文件（存在且非空） */
export function cachedFile(key) {
  const f = cacheFile(key)
  try {
    const st = fs.statSync(f)
    if (st.isFile() && st.size > 0) {
      // 更新访问时间（LRU 依据）
      try { fs.utimesSync(f, new Date(), new Date()) } catch { /* ignore */ }
      return f
    }
  } catch { /* not cached */ }
  return null
}

/** 启动清理：删掉半成品（.part.mp4）与残留的 HLS 目录，并按上限淘汰 */
export function initBiliCache() {
  try {
    const d = ensureDir()
    for (const name of fs.readdirSync(d)) {
      // 半成品命名：<key>.part.mp4（见 partOf 的说明）
      if (!name.endsWith(PART_SUFFIX)) continue
      try { fs.rmSync(path.join(d, name), { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // 上次进程被杀时 HLS 目录不会走 stop 流程，启动时统一清掉
  cleanupHlsDirs()
  enforceLimit()
}

/** 超限淘汰：按访问时间升序删到限内 */
export function enforceLimit() {
  const limit = limitBytes()
  if (limit <= 0) return
  try {
    const d = cacheRoot()
    if (!fs.existsSync(d)) return
    const files = fs
      .readdirSync(d)
      .filter((n) => n.endsWith('.mp4'))
      .map((n) => {
        const p = path.join(d, n)
        const st = fs.statSync(p)
        return { p, size: st.size, at: st.atimeMs || st.mtimeMs }
      })
      .sort((a, b) => a.at - b.at)
    let total = files.reduce((s, f) => s + f.size, 0)
    for (const f of files) {
      if (total <= limit) break
      try { fs.rmSync(f.p, { force: true }) } catch { /* ignore */ }
      total -= f.size
    }
  } catch { /* ignore */ }
}

/** 缓存统计（设置页展示用） */
export function biliCacheStats() {
  let count = 0
  let bytes = 0
  try {
    const d = cacheRoot()
    if (fs.existsSync(d)) {
      for (const n of fs.readdirSync(d)) {
        if (!n.endsWith('.mp4')) continue
        try {
          bytes += fs.statSync(path.join(d, n)).size
          count++
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return { count, bytes, limitMB: Math.round(limitBytes() / 1024 / 1024) }
}

export function clearBiliCache() {
  try {
    const d = cacheRoot()
    if (fs.existsSync(d)) {
      for (const n of fs.readdirSync(d)) {
        try { fs.rmSync(path.join(d, n), { force: true }) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return biliCacheStats()
}

/** 合流进度查询（渲染层轮询用） */
export function jobStatus(key) {
  const j = jobs.get(key)
  if (!j) return null
  return {
    key,
    done: j.done,
    percent: j.percent,
    time: j.time,
    speed: j.speed,
    error: j.error,
    output: j.output
  }
}

/** 合流任务的临时文件后缀。
 *  注意必须是「以 .mp4 结尾」——ffmpeg 靠扩展名推断容器格式，
 *  形如 `xxx.mp4.part` 的路径会让它报 "Unable to choose an output format"。
 *  故采用 `xxx.part.mp4`：既有 .mp4 结尾，又能被 .part 规则识别为半成品。 */
const PART_SUFFIX = '.part.mp4'

function partOf(output) {
  // output 形如 <key>.mp4 → <key>.part.mp4
  return output.replace(/\.mp4$/, PART_SUFFIX)
}

/**
 * 把 DASH 流合流成本地文件（带缓存与并发去重）。
 *
 * 并发去重很关键：用户可能连点播放/切画质，同一 key 若并发跑多个 ffmpeg，
 * 会互相覆盖输出文件且浪费带宽。
 *
 * @returns {Promise<string>} 合流后的本地文件路径
 */
export function mergeToCache({ bvid, cid, quality, videoUrl, audioUrl, onProgress }) {
  const key = cacheKeyOf(bvid, cid, quality)
  const hit = cachedFile(key)
  if (hit) return Promise.resolve(hit)

  const existing = jobs.get(key)
  if (existing && !existing.error) return existing.promise

  const output = cacheFile(key)
  const tmp = partOf(output)
  const job = { done: false, percent: 0, time: '', speed: '', error: null, output }
  jobs.set(key, job)

  job.promise = (async () => {
    try {
      await mergeDashStreams(videoUrl, audioUrl, tmp, (p) => {
        job.time = p.time
        job.speed = p.speed
        if (onProgress) onProgress(p)
      })
      // 完成才改名：半成品留在 .part.mp4，启动时会被清掉
      fs.renameSync(tmp, output)
      job.done = true
      job.percent = 100
      enforceLimit()
      return output
    } catch (e) {
      job.error = e.message
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      throw e
    } finally {
      // 保留 job 记录一段时间供前端查询错误，之后清理
      setTimeout(() => jobs.delete(key), 5 * 60 * 1000)
    }
  })()

  return job.promise
}

/* ---------------- HLS 实时合流会话 ---------------- */

/** HLS 临时目录根（会话目录在其下，播放结束即删） */
function hlsRoot() {
  return path.join(app.getPath('userData'), 'bili-cache', 'hls')
}

/**
 * 启动 HLS 实时合流会话。
 *
 * @param {object} p
 *   - bvid, cid, quality
 *   - videoUrl, audioUrl
 *   - onStarted?: () => void  可开播时回调
 * @returns {{ sessionId: string, playlist: string, dir: string }}
 */
export function startHlsSession({ bvid, cid, quality, videoUrl, audioUrl, onStarted }) {
  const key = cacheKeyOf(bvid, cid, quality)
  // 同 key 的旧会话先停掉（用户可能连点画质）
  for (const [id, s] of hlsSessions) {
    if (s.key === key) stopHlsSession(id)
  }

  const sessionId = `h${++hlsSeq}-${key}`
  const dir = path.join(hlsRoot(), sessionId)
  fs.mkdirSync(dir, { recursive: true })

  const hls = mergeDashToHls(videoUrl, audioUrl, dir, {
    onStarted: () => {
      // 标记可播，并把播放列表路径回传（渲染层据此加载）
      const s = hlsSessions.get(sessionId)
      if (s) s.ready = true
      onStarted?.()
    },
    onExit: (code, err) => {
      const s = hlsSessions.get(sessionId)
      if (s) {
        s.exited = true
        s.exitCode = code
        s.exitError = err || ''
      }
      // 正常结束（code 0）时列表已完整，保留文件供播放器读完剩余分片；
      // 异常结束也保留（渲染层可能还在读），由 LRU/启动清理回收
    }
  })

  hlsSessions.set(sessionId, {
    hls,
    dir,
    key,
    ready: false,
    exited: false,
    startedAt: Date.now()
  })

  return { sessionId, playlist: hls.playlist, dir }
}

/** 查询 HLS 会话状态 */
export function hlsSessionStatus(sessionId) {
  const s = hlsSessions.get(sessionId)
  if (!s) return { exists: false }
  let segCount = 0
  try {
    segCount = fs.readdirSync(s.dir).filter((n) => n.endsWith('.m4s')).length
  } catch { /* ignore */ }
  return {
    // sessionId 必须回传：前端 waitHlsReady 轮询时用它拼
    // ncm-audio://hls/<sessionId>/index.m3u8，缺了会拼出 "undefined" 导致 404
    sessionId,
    exists: true,
    ready: s.ready,
    exited: s.exited,
    exitCode: s.exitCode ?? null,
    exitError: s.exitError || '',
    playlist: s.hls.playlist,
    dir: s.dir,
    segCount
  }
}

/**
 * 按 sessionId 取会话目录（供 ncm-audio://hls 协议定位文件）。
 * 找不到返回 null。
 */
export function hlsDirOf(sessionId) {
  const s = hlsSessions.get(sessionId)
  return s ? s.dir : null
}

/** 停止并清理 HLS 会话 */
export function stopHlsSession(sessionId) {
  const s = hlsSessions.get(sessionId)
  if (!s) return false
  try { s.hls.stop() } catch { /* ignore */ }
  hlsSessions.delete(sessionId)
  // 延迟删目录：播放器可能还在读最后几个分片，立即删会导致播放中断
  setTimeout(() => {
    try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }, 3000)
  return true
}

/** 清理所有 HLS 会话（应用退出/切换视频时） */
export function stopAllHlsSessions() {
  for (const id of [...hlsSessions.keys()]) stopHlsSession(id)
}

/** 启动清理：删掉上次残留的 HLS 目录（进程被杀时不会走 stop 流程） */
export function cleanupHlsDirs() {
  try {
    const root = hlsRoot()
    if (!fs.existsSync(root)) return
    for (const name of fs.readdirSync(root)) {
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
