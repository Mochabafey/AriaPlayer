import { app } from 'electron'
import fs from 'fs'
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import { settingsRepo } from './db/settings.js'
import { downloadsRepo } from './db/downloads.js'
import { QUALITY_MAP } from './constants.js'

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
 * 任务状态持久化在 SQLite downloads 表（重启自动恢复）。
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

  init() {
    if (this.initialized) return
    this.initialized = true
    // 恢复上次未完成任务为 paused
    downloadsRepo.pauseAllActive()
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

  async add({ songId, title, artist, url, quality = '320000', cover }) {
    // songId 去重：已存在则拒绝
    if (songId) {
      const existing = downloadsRepo.getBySongId(songId)
      if (existing && existing.status !== 'failed' && existing.status !== 'paused') {
        return { ok: false, reason: 'duplicated', message: '该歌曲已在下载列表中', task: existing }
      }
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

  async run(task) {
    const dir = settingsRepo.get('downloadDir') || app.getPath('music')
    fs.mkdirSync(dir, { recursive: true })

    const dest = path.join(dir, `${sanitize(task.artist)} - ${sanitize(task.title)}.${task.ext}`)
    task.path = dest
    task.status = 'downloading'
    task.error = null
    this.persist(task)

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
          this.persist(task)
        }
        if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
      }
      stream.end()
      await new Promise((r) => stream.on('finish', r))

      task.status = 'done'
      this.send('ncm:download-progress', { ...task })
      this.send('ncm:download-done', { ...task })
      this.persist(task)
    } catch (e) {
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
      this.persist(task)
    }
  }

  async retry(id) {
    const task = this.find(id)
    if (!task || task.status === 'downloading' || task.status === 'pending') return
    task.status = 'pending'
    task.error = null
    task.received = 0
    task.total = 0
    this.persist(task)
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
      downloadsRepo.remove(id)
    }
  }

  persist(task) {
    if (task) downloadsRepo.update(task)
  }
}
