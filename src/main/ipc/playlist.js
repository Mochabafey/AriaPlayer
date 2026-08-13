import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { stores } from '../store/db.js'

export function registerPlaylistIpc() {
  ipcMain.handle('ncm:playlist-list', () => stores.playlists.get('list') || [])

  ipcMain.handle('ncm:playlist-save', (_e, { id, name, songIds }) => {
    const list = stores.playlists.get('list') || []
    if (id) {
      const p = list.find((x) => x.id === id)
      if (p) {
        if (name !== undefined) p.name = name
        if (songIds !== undefined) p.songIds = songIds
        p.updatedAt = Date.now()
        stores.playlists.saveNow()
        return p
      }
    }
    const p = {
      id: crypto.randomUUID(),
      name: name || '新建歌单',
      songIds: songIds || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    list.unshift(p)
    stores.playlists.set('list', list)
    return p
  })

  ipcMain.handle('ncm:playlist-remove', (_e, id) => {
    const list = stores.playlists.get('list') || []
    stores.playlists.set('list', list.filter((p) => p.id !== id))
    return true
  })

  // 导出本地歌单为 m3u
  ipcMain.handle('ncm:playlist-export-m3u', async (_e, { id, name }) => {
    const list = stores.playlists.get('list') || []
    const songs = stores.library.get('songs') || []
    const p = list.find((x) => x.id === id)
    if (!p) return null
    const r = await dialog.showSaveDialog({
      title: '导出歌单',
      defaultPath: `${name || p.name}.m3u`,
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u'] }]
    })
    if (r.canceled || !r.filePath) return null
    const lines = ['#EXTM3U']
    for (const sid of p.songIds) {
      const s = songs.find((x) => x.id === sid)
      if (s) {
        lines.push(`#EXTINF:${Math.round(s.duration || 0)},${s.artist} - ${s.title}`)
        lines.push(s.filePath)
      }
    }
    fs.writeFileSync(r.filePath, lines.join('\n'), 'utf-8')
    return r.filePath
  })

  // 导入 m3u 为本地歌单（引用曲库内已有文件，缺失的路径跳过）
  ipcMain.handle('ncm:playlist-import-m3u', async (_e, name) => {
    const r = await dialog.showOpenDialog({
      title: '导入 M3U 歌单',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const raw = fs.readFileSync(r.filePaths[0], 'utf-8')
    const songs = stores.library.get('songs') || []
    const songIds = []
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const abs = path.isAbsolute(t) ? t : path.join(path.dirname(r.filePaths[0]), t)
      const s = songs.find((x) => x.filePath === abs)
      if (s) songIds.push(s.id)
    }
    const list = stores.playlists.get('list') || []
    const p = {
      id: crypto.randomUUID(),
      name: name || path.basename(r.filePaths[0], '.m3u'),
      songIds,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      imported: true
    }
    list.unshift(p)
    stores.playlists.set('list', list)
    return p
  })
}
