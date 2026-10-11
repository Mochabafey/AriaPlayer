import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ipcMain, dialog } from 'electron'
import { libraryRepo } from '../db/library.js'
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
  const notify = () => notifyUpdate()

  ipcMain.handle('ncm:library-list', () => libraryRepo.listSongs())

  ipcMain.handle('ncm:library-folders', () => libraryRepo.listFolders())

  // 移除监控文件夹（保留已入库的歌曲记录，只是不再自动扫描）
  ipcMain.handle('ncm:library-remove-folder', (_e, folder) => {
    libraryRepo.removeFolder(folder)
    notify()
    return true
  })

  ipcMain.handle('ncm:library-add-folder', async (_e, folder) => {
    libraryRepo.addFolder(folder)
    const added = await scanDir(folder)
    notify()
    return added
  })

  ipcMain.handle('ncm:library-scan', async () => {
    let added = 0
    for (const f of libraryRepo.listFolders()) {
      added += await scanDir(f)
    }
    notify()
    return added
  })

  ipcMain.handle('ncm:library-edit', async (_e, id, fields) => {
    const song = libraryRepo.getSong(id)
    if (!song) return { ok: false, reason: 'not found' }

    const { title, artist, album, cover } = fields || {}
    const merged = { title, artist, album }
    if (cover !== undefined) merged.coverPath = cover
    libraryRepo.updateSong(id, merged)

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
    const song = libraryRepo.getSong(id)
    if (song) {
      if (deleteFile && fs.existsSync(song.filePath)) {
        try { fs.unlinkSync(song.filePath) } catch { /* ignore */ }
      }
      libraryRepo.removeSong(id)
    }
    notify()
    return true
  })

  // 导出曲库清单 JSON 或 m3u
  ipcMain.handle('ncm:library-export', async (_e, type = 'json') => {
    const songs = libraryRepo.listSongs()
    const r = await dialog.showSaveDialog({
      title: '导出曲库',
      defaultPath: `咏叹调-曲库.${type}`,
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
    // SQLite 同步写入天然原子：insert 前查一次即可防并发重复，无需占位标记
    if (libraryRepo.hasFile(filePath)) return false
    try {
      const m = await loadMeta()
      const meta = await m.parseFile(filePath, { duration: true })
      if (libraryRepo.hasFile(filePath)) return false // 解析 await 间隙可能已被其他 worker 插入
      const id = hashFile(filePath)
      const pic = meta.common.picture?.[0]
      let coverPath = null
      if (pic) {
        const ext = pic.format.includes('png') ? 'png' : 'jpg'
        coverPath = path.join(coversDir(), `${id}.${ext}`)
        fs.writeFileSync(coverPath, pic.data)
      }
      libraryRepo.insertSong({
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
      })
      return true
    } catch (e) {
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
    const targets = files.filter((f) => !libraryRepo.hasFile(f))

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
