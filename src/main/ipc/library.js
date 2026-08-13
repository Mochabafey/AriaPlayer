import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ipcMain, dialog } from 'electron'
import { stores } from '../store/db.js'
import { writeFileTags } from '../tags/writeTags.mjs'

// music-metadata 在主进程运行时加载（外部依赖，不打进 renderer bundle）
let mm = null
async function loadMeta() {
  mm ??= await import('music-metadata')
  return mm
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.opus'])

function coversDir() {
  const d = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function hashFile(p) {
  const s = fs.statSync(p)
  return crypto.createHash('md5').update(`${p}|${s.size}|${s.mtimeMs}`).digest('hex').slice(0, 16)
}

export function registerLibraryIpc(notifyUpdate) {
  const notify = () => {
    notifyUpdate()
    stores.library.saveNow()
  }

  ipcMain.handle('ncm:library-list', () => stores.library.get('songs') || [])

  ipcMain.handle('ncm:library-folders', () => stores.library.get('folders') || [])

  ipcMain.handle('ncm:library-add-folder', async (_e, folder) => {
    const folders = stores.library.get('folders') || []
    if (!folders.includes(folder)) {
      folders.push(folder)
      stores.library.set('folders', folders)
    }
    const added = await scanDir(folder)
    notify()
    return added
  })

  ipcMain.handle('ncm:library-scan', async () => {
    const folders = stores.library.get('folders') || []
    const added = []
    for (const f of folders) {
      added.push(...(await scanDir(f)))
    }
    notify()
    return added.length
  })

  ipcMain.handle('ncm:library-edit', async (_e, id, fields) => {
    const songs = stores.library.get('songs') || []
    const song = songs.find((s) => s.id === id)
    if (!song) return { ok: false, reason: 'not found' }

    const { title, artist, album, cover } = fields || {}
    Object.assign(song, { title, artist, album })
    if (cover !== undefined) song.coverPath = cover

    // 写回文件标签：mp3(ID3v2)/flac(vorbis)/m4a(ilst)；失败仅记日志，不影响库内记录
    const tags = {}
    if (title !== undefined) tags.title = title
    if (artist !== undefined) tags.artist = artist
    if (album !== undefined) tags.album = album
    let wroteTag = false
    try {
      wroteTag = writeFileTags(song.filePath, tags)
    } catch (e) {
      console.error('[library] tag write failed', e)
    }
    notify()
    return { ok: true, wroteTag }
  })

  ipcMain.handle('ncm:library-remove', (_e, id, { deleteFile = false } = {}) => {
    const songs = stores.library.get('songs') || []
    const song = songs.find((s) => s.id === id)
    if (song) {
      if (deleteFile && fs.existsSync(song.filePath)) {
        try { fs.unlinkSync(song.filePath) } catch { /* ignore */ }
      }
      stores.library.set('songs', songs.filter((s) => s.id !== id))
    }
    notify()
    return true
  })

  // 导出曲库清单 JSON 或 m3u
  ipcMain.handle('ncm:library-export', async (_e, type = 'json') => {
    const songs = stores.library.get('songs') || []
    const r = await dialog.showSaveDialog({
      title: '导出曲库',
      defaultPath: `网易牛具-曲库.${type}`,
      filters: [{ name: type === 'm3u' ? 'M3U 播放列表' : 'JSON 清单', extensions: [type] }]
    })
    if (r.canceled || !r.filePath) return null
    if (type === 'm3u') {
      const lines = ['#EXTM3U', ...songs.map((s) => `#EXTINF:${Math.round(s.duration || 0)},${s.artist} - ${s.title}\n${s.filePath}`)]
      fs.writeFileSync(r.filePath, lines.join('\n'), 'utf-8')
    } else {
      fs.writeFileSync(r.filePath, JSON.stringify(songs, null, 2), 'utf-8')
    }
    return r.filePath
  })

  // 导入 m3u/json
  ipcMain.handle('ncm:library-import', async () => {
    const r = await dialog.showOpenDialog({
      title: '导入曲库清单',
      filters: [{ name: '播放清单', extensions: ['m3u', 'json'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return 0
    const file = r.filePaths[0]
    const ext = path.extname(file).toLowerCase()
    const paths = []
    if (ext === '.m3u') {
      const raw = fs.readFileSync(file, 'utf-8')
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim()
        if (t && !t.startsWith('#')) paths.push(t)
      }
    } else {
      const arr = JSON.parse(fs.readFileSync(file, 'utf-8'))
      for (const s of arr) if (s.filePath) paths.push(s.filePath)
    }
    let added = 0
    for (const p of paths) {
      if (fs.existsSync(p) && AUDIO_EXTS.has(path.extname(p).toLowerCase())) {
        added += (await importOne(p)) ? 1 : 0
      }
    }
    notify()
    return added
  })

  async function importOne(filePath) {
    // 同步去重：先标记后解析，防止并发重复
    const songs = stores.library.get('songs') || []
    if (songs.some((s) => s.filePath === filePath)) return false
    const placeholder = { id: '__pending__', filePath }
    songs.push(placeholder)
    stores.library.set('songs', songs)
    try {
      const m = await loadMeta()
      const meta = await m.parseFile(filePath, { duration: true })
      const id = hashFile(filePath)
      const pic = meta.common.picture?.[0]
      let coverPath = null
      if (pic) {
        const ext = pic.format.includes('png') ? 'png' : 'jpg'
        coverPath = path.join(coversDir(), `${id}.${ext}`)
        fs.writeFileSync(coverPath, pic.data)
      }
      const song = {
        id,
        filePath,
        title: meta.common.title || path.basename(filePath, path.extname(filePath)),
        artist: meta.common.artist || '未知歌手',
        album: meta.common.album || '',
        coverPath,
        duration: Math.round(meta.format.duration || 0),
        size: meta.format.size || 0,
        format: path.extname(filePath).slice(1).toLowerCase(),
        source: 'import',
        songId: null,
        addedAt: Date.now()
      }
      const cur = stores.library.get('songs') || []
      const idx = cur.indexOf(placeholder)
      if (idx >= 0) cur[idx] = song
      stores.library.set('songs', cur)
      return true
    } catch (e) {
      // 解析失败：移除占位
      const cur = stores.library.get('songs') || []
      stores.library.set('songs', cur.filter((s) => s !== placeholder))
      console.error('[library] parse failed', filePath, e.message)
      return false
    }
  }

  async function collectAudioFiles(dir, out) {
    if (!fs.existsSync(dir)) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      try {
        if (ent.isDirectory()) {
          if (full.includes('node_modules') || full.includes('\\.git')) continue
          await collectAudioFiles(full, out)
        } else if (AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
          out.push(full)
        }
      } catch { /* ignore */ }
    }
  }

  async function scanDir(dir) {
    const files = []
    await collectAudioFiles(dir, files)
    const songs = stores.library.get('songs') || []
    const known = new Set(songs.filter((s) => s.id !== '__pending__').map((s) => s.filePath))
    const targets = files.filter((f) => !known.has(f))

    // 有界并发 4
    let added = 0
    let i = 0
    const workers = Array.from({ length: 4 }, async () => {
      while (i < targets.length) {
        const f = targets[i++]
        const ok = await importOne(f)
        if (ok) added++
      }
    })
    await Promise.all(workers)
    return added
  }
}
