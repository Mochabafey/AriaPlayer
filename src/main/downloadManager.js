import { app } from 'electron'
import fs from 'fs'
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import { settingsRepo } from './db/settings.js'
import { downloadsRepo } from './db/downloads.js'
import { QUALITY_MAP } from './constants.js'
import { copyFromCache } from './audioCache.js'

const CONCURRENCY = 2
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'

/** 未完成下载的临时后缀：完成后 rename 去掉。
 *  好处：残缺文件不会被误认为完整音频（之前下载一半失败，音乐目录里就留一个
 *  能播但截断的 mp3，播放器/扫描器都会当成正常歌曲）。 */
const PART_SUFFIX = '.part'

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * 磁盘上真实存在的字节数（不存在/不可读 → 0）。
 *
 * 断点续传一律以它为准，**不信任 DB 里的 received**：
 * 进程被强杀时 DB 可能已记录一个尚未落盘的进度，用它当 Range 起点会
 * 越界/错位写入，把文件写坏（且下次续传继续坏）。
 */
function fileSizeOf(p) {
  if (!p) return 0
  try {
    const st = fs.statSync(p)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** 目标文件对应的临时文件路径 */
function partOf(dest) {
  return dest ? dest + PART_SUFFIX : ''
}

/**
 * 下载管理器：并发池、songId 去重、断点续传（Range）、进度推送。
 * 任务状态持久化在 SQLite downloads 表（重启自动恢复）。
 *
 * 断点续传设计：
 *   - 未完成内容写在 `<目标文件>.part`，完成才 rename 成正式文件
 *   - 重试/续传保留 .part（旧实现会先删掉它，导致每次重试都从 0 开始）
 *   - 续传起点取 .part 实际大小，不用 DB 里的 received
 *   - 音源地址过期（网易云地址仅几分钟有效）→ 自动重新解析后重试
 *   - 上游不支持 Range（回 200）/ 区间错位 / 416 → 丢弃本地部分从头下
 */
export class DownloadManager {
  constructor(getWindow, getServer) {
    this.getWindow = getWindow
    this.getServer = getServer
    this.queue = []
    this.running = new Map() // id -> {task, controller}
    this.initialized = false
  }

  /** 兜底：调用方未传 url 时，主进程经私有 socket 通道向 api-enhanced 现取播放地址 */
  async resolveUrl(songId, quality = '320000') {
    const srv = this.getServer && this.getServer()
    if (!srv || srv.status !== 'ready') return null
    const level = quality === 'lossless' ? 'lossless' : quality === '320000' ? 'exhigh' : 'standard'
    return new Promise((resolve) => {
      const req = http.request({
        socketPath: srv.socketPath,
        path: `/song/url/v1?id=${encodeURIComponent(songId)}&level=${level}`,
        method: 'GET'
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            resolve(data.data?.[0]?.url || null)
          } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.setTimeout(30000, () => req.destroy(new Error('resolve timeout')))
      req.end()
    })
  }

  /**
   * 重新解析音源地址。
   * 网易云音源地址只有几分钟有效期，暂停久了再续传必然 403/404——
   * 用旧地址重试是徒劳。只对纯数字 songId（网易云）有效；
   * QQ 源 songId 形如 `qq:xxx`，其地址由 QQ 服务另行解析，此处不处理。
   */
  async refreshUrl(task) {
    const sid = String(task?.songId || '')
    if (!/^\d+$/.test(sid)) return false
    try {
      const fresh = await this.resolveUrl(sid, task.quality)
      if (fresh && fresh !== task.url) {
        task.url = fresh
        this.persist(task)
        return true
      }
    } catch { /* 解析失败：沿用旧地址，让错误照常暴露 */ }
    return false
  }

  init() {
    if (this.initialized) return
    this.initialized = true
    // 恢复上次未完成任务为 paused
    downloadsRepo.pauseAllActive()
    // 启动对账：把 paused 任务的 received 校正为磁盘上的真实大小。
    // 崩溃/强杀时 DB 记录可能超前于落盘，不校正会让续传起点越界写坏文件。
    try {
      for (const t of downloadsRepo.list()) {
        if (t.status !== 'paused') continue
        let onDisk = fileSizeOf(partOf(t.path))
        // 兼容早期版本：残缺文件直接写在目标位置（没有 .part）
        if (onDisk === 0) onDisk = fileSizeOf(t.path)
        if (onDisk !== t.received) {
          t.received = onDisk
          downloadsRepo.update(t)
        }
      }
    } catch (e) {
      console.warn('[download] 启动对账失败', e.message)
    }
  }

  send(channel, payload) {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  list() {
    return downloadsRepo.list()
  }

  find(id) {
    return downloadsRepo.get(id)
  }

  async add({ songId, title, artist, url, quality = '320000', cover, ext }) {
    if (songId) {
      const existing = downloadsRepo.getBySongId(songId)
      if (existing) {
        if (existing.status !== 'failed' && existing.status !== 'paused') {
          return { ok: false, reason: 'duplicated', message: '该歌曲已在下载列表中', task: existing }
        }
        // 已有未完成任务（失败/暂停）：复用并续传，而不是新建任务。
        // 新建会与旧任务写同一个目标文件（同歌手+歌名 → 同路径），内容必然错乱。
        await this.retry(existing.id)
        return { ok: true, task: this.find(existing.id) || existing, resumed: true }
      }
    }
    // 兜底：未传 url 时主进程现取播放地址
    if (!url && songId) {
      url = await this.resolveUrl(songId, quality)
    }
    if (!url) {
      return { ok: false, reason: 'no-url', message: '无法获取播放地址（可能无版权）' }
    }
    // ext 显式传入时优先（MV 等非音频资源走这条：mp4/mkv…）；
    // 否则按音质档位推导（音频下载）
    const q = QUALITY_MAP[quality] || QUALITY_MAP['320000']
    const task = {
      id: crypto.randomUUID(),
      songId: songId || null,
      title: title || '未知歌曲',
      artist: artist || '未知歌手',
      url,
      quality,
      ext: ext || q.ext,
      path: null,
      status: 'pending',
      received: 0,
      total: 0,
      error: null,
      createdAt: Date.now(),
      cover: cover || null
    }
    downloadsRepo.insert(task)
    this.queue.push(task)
    this.pump()
    return { ok: true, task }
  }

  async pump() {
    while (this.running.size < CONCURRENCY && this.queue.length) {
      const task = this.queue.shift()
      if (!task) break
      this.run(task).catch((e) => console.error('[download] task error', e))
    }
  }

  /**
   * 建立下载连接（含续传边界处理）。
   * 返回 { res, offset }：offset 是本次响应实际对应的起始位置，
   * 与请求值不同表示需要丢弃本地部分重写。
   *
   * 三种边界：
   *   416  → 本地偏移已 ≥ 上游文件长度（残留/损坏）→ 从头请求
   *   403/404/410 → 音源地址过期 → 刷新地址后重试一次
   *   206 但 Content-Range 起点与请求不符 → 上游给错位区间，从头请求
   *        （不校验会让文件内容整体错位，比重新下载更糟）
   */
  async openStream(task, from, signal) {
    let offset = from
    let refreshed = false
    for (let i = 0; i < 3; i++) {
      const headers = { 'User-Agent': UA }
      if (offset > 0) headers.Range = `bytes=${offset}-`
      const res = await fetch(task.url, { headers, signal })

      if (res.status === 416 && offset > 0) {
        try { res.body?.cancel?.() } catch { /* ignore */ }
        offset = 0
        continue
      }
      if ([403, 404, 410].includes(res.status) && !refreshed) {
        try { res.body?.cancel?.() } catch { /* ignore */ }
        refreshed = true
        if (await this.refreshUrl(task)) continue
      }
      if (!res.ok && res.status !== 206) {
        try { res.body?.cancel?.() } catch { /* ignore */ }
        throw new Error(`HTTP ${res.status}`)
      }
      if (res.status === 206 && offset > 0) {
        const m = /bytes\s+(\d+)-/.exec(res.headers.get('content-range') || '')
        if (m && Number(m[1]) !== offset) {
          try { res.body?.cancel?.() } catch { /* ignore */ }
          offset = 0
          continue
        }
      }
      return { res, offset }
    }
    throw new Error('无法建立下载连接')
  }

  async run(task) {
    const dir = settingsRepo.get('downloadDir') || app.getPath('music')
    fs.mkdirSync(dir, { recursive: true })

    const dest = path.join(dir, `${sanitize(task.artist)} - ${sanitize(task.title)}.${task.ext}`)
    const part = partOf(dest)
    task.path = dest
    task.status = 'downloading'
    task.error = null
    this.persist(task)

    const controller = new AbortController()
    this.running.set(task.id, { task, controller })
    this.send('ncm:download-progress', { ...task })

    try {
      // 播放缓存命中：直接拷贝本地文件（零网络，秒完成）。未命中/拷贝失败回退网络下载
      const cached = copyFromCache(task.url, dest)
      if (cached.ok) {
        try { fs.rmSync(part, { force: true }) } catch { /* ignore */ }
        task.received = cached.size
        task.total = cached.size
        task.status = 'done'
        this.send('ncm:download-progress', { ...task })
        this.send('ncm:download-done', { ...task })
        this.persist(task)
        return
      }

      // ---- 断点续传：起点取 .part 实际大小（不信任 DB 的 received）----
      let received = fileSizeOf(part)
      // 兼容早期版本遗留：没有 .part 但目标位置已有残缺文件 → 迁移为 .part 续传
      if (received === 0) {
        const legacy = fileSizeOf(dest)
        if (legacy > 0) {
          try {
            fs.renameSync(dest, part)
            received = fileSizeOf(part)
          } catch { /* 迁移失败则当作全新下载 */ }
        }
      }

      const { res, offset } = await this.openStream(task, received, controller.signal)

      // openStream 判定需要从头下（416 / 区间错位 / 地址刷新后）：清掉本地部分
      let appendFrom = offset
      if (appendFrom !== received) {
        try { fs.rmSync(part, { force: true }) } catch { /* ignore */ }
        task.received = appendFrom
        this.send('ncm:download-progress', { ...task })
      }
      // 上游忽略 Range 返回 200（完整实体）：必须从头写，追加会写坏文件
      if (appendFrom > 0 && res.status !== 206) {
        appendFrom = 0
        try { fs.rmSync(part, { force: true }) } catch { /* ignore */ }
        task.received = 0
        this.send('ncm:download-progress', { ...task })
      }

      const cl = Number(res.headers.get('content-length')) || 0
      task.total = appendFrom + cl

      const stream = fs.createWriteStream(part, { flags: appendFrom > 0 ? 'a' : 'w' })
      let lastEmit = 0
      let written = appendFrom
      for await (const chunk of res.body) {
        // 先落盘再计数：内存计数超前于落盘时，崩溃会让 DB 进度越界
        if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
        written += chunk.length
        const now = Date.now()
        if (now - lastEmit > 200) {
          lastEmit = now
          task.received = written
          this.send('ncm:download-progress', { ...task })
          this.persist(task)
        }
      }
      stream.end()
      await new Promise((r) => stream.on('finish', r))

      // 完整性校验：流提前结束（上游断连但未报错）时不能 rename 成正式文件，
      // 否则用户拿到一个能播但截断的文件，且断点续传的前提也没了
      const finalSize = fileSizeOf(part)
      if (task.total > 0 && finalSize < task.total) {
        task.received = finalSize
        throw new Error(`下载不完整（${finalSize}/${task.total} 字节），可重试续传`)
      }

      // 完成：rename 去掉 .part 后缀
      fs.renameSync(part, dest)
      task.received = finalSize
      task.total = finalSize || task.total
      task.status = 'done'
      this.send('ncm:download-progress', { ...task })
      this.send('ncm:download-done', { ...task })
      this.persist(task)
    } catch (e) {
      // 以磁盘实际大小校正进度：内存计数可能超前于落盘
      const onDisk = fileSizeOf(part)
      if (onDisk > 0) task.received = onDisk
      if (e.name === 'AbortError') {
        task.status = 'paused'
      } else {
        task.status = 'failed'
        task.error = e.message
      }
      this.send('ncm:download-progress', { ...task })
      this.persist(task)
    } finally {
      this.running.delete(task.id)
      this.pump()
    }
  }

  cancel(id) {
    const entry = this.running.get(id)
    if (entry) entry.controller.abort()
    const task = this.find(id)
    if (task && (task.status === 'pending' || task.status === 'downloading')) {
      task.status = 'paused'
      // 以磁盘实际大小校正：暂停后要能准确显示"已下载 X%"
      task.received = fileSizeOf(partOf(task.path)) || task.received
      this.persist(task)
      this.send('ncm:download-progress', { ...task })
    }
  }

  /**
   * 重试/继续下载。
   * 关键：保留 .part 从断点继续（旧实现先 unlink 残缺文件 → 每次重试都从 0 开始，
   * 那 run() 里的 Range 逻辑永远等不到 received > 0）。
   */
  async retry(id) {
    const task = this.find(id)
    if (!task || task.status === 'downloading' || task.status === 'pending') return
    const have = fileSizeOf(partOf(task.path)) || fileSizeOf(task.path)
    task.status = 'pending'
    task.error = null
    task.received = have
    if (have === 0) task.total = 0 // 无断点则重置总量，等响应头重新确定
    this.persist(task)
    // 音源地址可能已过期：重试前先刷新，避免用死地址必然失败
    await this.refreshUrl(task)
    this.queue.push(task)
    this.pump()
  }

  remove(id, { deleteFile = false } = {}) {
    this.cancel(id)
    const task = this.find(id)
    if (task) {
      if (deleteFile) {
        // 同时清掉 .part：只删正式文件会留下孤儿临时文件
        for (const p of [task.path, partOf(task.path)]) {
          if (p && fs.existsSync(p)) {
            try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
          }
        }
      }
      downloadsRepo.remove(id)
    }
  }

  persist(task) {
    if (task) downloadsRepo.update(task)
  }
}
