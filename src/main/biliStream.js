/**
 * biliStream.js — B 站播放流管理
 *
 * 职责：把 B 站的两类流统一成「一个本地可播的地址」给渲染层。
 *
 * 两条路径：
 *   durl（单文件 mp4）→ 直接交给 ncm-audio:// 代理播放，零 ffmpeg 开销、秒开
 *   dash（音视频分离）→ ffmpeg 合流成本地 mp4，再播放
 *
 * 合流结果的缓存策略：
 *   合流成本高（要下完整个视频），所以按 bvid+cid+quality 缓存到磁盘，
 *   二次播放直接命中。缓存上限与 LRU 复用 audioCache 的思路，但独立目录
 *   （视频文件大，混在一起会把音频缓存的 LRU 挤爆）。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { mergeDashStreams } from './ffmpeg.js'
import { settingsRepo } from './db/settings.js'

/** 合流任务表：key → { promise, output, percent, speed, error } */
const jobs = new Map()

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

/** 启动清理：删掉半成品（.part.mp4），并按上限淘汰 */
export function initBiliCache() {
  try {
    const d = ensureDir()
    for (const name of fs.readdirSync(d)) {
      // 半成品命名：<key>.part.mp4（见 partOf 的说明）
      if (!name.endsWith(PART_SUFFIX)) continue
      try { fs.rmSync(path.join(d, name), { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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
