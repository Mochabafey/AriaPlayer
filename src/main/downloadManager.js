import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { stores, QUALITY_MAP } from './store/db.js'

const CONCURRENCY = 2

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * 下载管理器：并发池、songId 去重、断点续传（Range）、进度推送。
 */
export class DownloadManager {
  constructor(getWindow, getServer) {
    this.getWindow = getWindow
    this.getServer = getServer
    this.queue = []
    this.running = new Map() // id -> {task, stream, controller}
    this.initialized = false
  }

  /** 兜底：调用方未传 url 时，主进程向 api-enhanced 现取播放地址 */
  async resolveUrl(songId, quality = '320000') {
    const srv = this.getServer && this.getServer()
    if (!srv || srv.status !== 'ready') return null
    const level = quality === 'lossless' ? 'lossless' : quality === '320000' ? 'exhigh' : 'standard'
    try {
      const res = await fetch(
        `http://127.0.0.1:${srv.port}/song/url/v1?id=${encodeURIComponent(songId)}&level=${level}`,
        { signal: AbortSignal.timeout(30000) }
      )
      const data = await res.json()
      return data.data?.[0]?.url || null
    } catch {
      return null
    }
  }

  init() {
    if (this.initialized) return
    this.initialized = true
    // 恢复上次未完成任务为 paused
    stores.downloads.update((d) => {
      d.tasks = d.tasks || []
      d.tasks.forEach((t) => {
        if (t.status === 'downloading' || t.status === 'pending') t.status = 'paused'
      })
    })
  }

  send(channel, payload) {
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  list() {
    return stores.downloads.get('tasks') || []
  }

  async add({ songId, title, artist, url, quality = '320000', cover }) {
    const tasks = stores.downloads.get('tasks') || []
    // songId 去重：已存在则拒绝
    if (songId && tasks.some((t) => t.songId === songId && t.status !== 'failed' && t.status !== 'paused')) {
      return { ok: false, reason: 'duplicated', message: '该歌曲已在下载列表中', task: tasks.find((t) => t.songId === songId) }
    }
    // 兜底：未传 url 时主进程现取播放地址
    if (!url && songId) {
      url = await this.resolveUrl(songId, quality)
    }
    if (!url) {
      return { ok: false, reason: 'no-url', message: '无法获取播放地址（可能无版权）' }
    }
    const q = QUALITY_MAP[quality] || QUALITY_MAP['320000']
    const task = {
      id: crypto.randomUUID(),
      songId: songId || null,
      title: title || '未知歌曲',
      artist: artist || '未知歌手',
      url,
      quality,
      ext: q.ext,
      path: null,
      status: 'pending',
      received: 0,
      total: 0,
      error: null,
      createdAt: Date.now(),
      cover: cover || null
    }
    stores.downloads.update((d) => {
      d.tasks = [task, ...(d.tasks || [])]
    })
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

  async run(task) {
    const settings = stores.settings.get()
    const dir = settings.downloadDir || app.getPath('music')
    fs.mkdirSync(dir, { recursive: true })

    const dest = path.join(dir, `${sanitize(task.artist)} - ${sanitize(task.title)}.${task.ext}`)
    task.path = dest
    task.status = 'downloading'
    task.error = null

    const controller = new AbortController()
    this.running.set(task.id, { task, controller })
    this.send('ncm:download-progress', { ...task })

    try {
      let received = fs.existsSync(dest) ? fs.statSync(dest).size : 0
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
      }
      if (received > 0) headers['Range'] = `bytes=${received}-`

      const res = await fetch(task.url, { headers, signal: controller.signal })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)

      // 服务器忽略 Range 返回 200：说明不支持断点续传，从头下载（否则追加会写坏文件）
      if (received > 0 && res.status !== 206) {
        received = 0
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
      }

      const total = Number(res.headers.get('content-length')) || 0
      task.total = total + received

      const stream = fs.createWriteStream(dest, { flags: received > 0 ? 'a' : 'w' })
      let lastEmit = 0
      for await (const chunk of res.body) {
        task.received += chunk.length
        const now = Date.now()
        if (now - lastEmit > 200) {
          lastEmit = now
          this.send('ncm:download-progress', { ...task })
        }
        if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
      }
      stream.end()
      await new Promise((r) => stream.on('finish', r))

      task.status = 'done'
      this.send('ncm:download-progress', { ...task })
      this.send('ncm:download-done', { ...task })
      this.persist()
    } catch (e) {
      if (e.name === 'AbortError') {
        task.status = 'paused'
      } else {
        task.status = 'failed'
        task.error = e.message
      }
      this.send('ncm:download-progress', { ...task })
      this.persist()
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
      this.persist()
    }
  }

  async retry(id) {
    const task = this.find(id)
    if (!task || task.status === 'downloading' || task.status === 'pending') return
    task.status = 'pending'
    task.error = null
    task.received = 0
    task.total = 0
    this.persist()
    // 删掉残缺文件重新下载
    if (task.path && fs.existsSync(task.path)) {
      try { fs.unlinkSync(task.path) } catch { /* ignore */ }
    }
    this.queue.push(task)
    this.pump()
  }

  remove(id, { deleteFile = false } = {}) {
    this.cancel(id)
    const task = this.find(id)
    if (task) {
      if (deleteFile && task.path && fs.existsSync(task.path)) {
        try { fs.unlinkSync(task.path) } catch { /* ignore */ }
      }
      stores.downloads.update((d) => {
        d.tasks = d.tasks.filter((t) => t.id !== id)
      })
    }
  }

  find(id) {
    return (stores.downloads.get('tasks') || []).find((t) => t.id === id)
  }

  persist() {
    stores.downloads.saveNow()
  }
}
