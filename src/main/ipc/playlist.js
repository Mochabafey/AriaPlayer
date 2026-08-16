import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { playlistsRepo } from '../db/playlists.js'
import { libraryRepo } from '../db/library.js'

export function registerPlaylistIpc() {
  ipcMain.handle('ncm:playlist-list', () => playlistsRepo.list())

  ipcMain.handle('ncm:playlist-save', (_e, { id, name, songIds }) => {
    return playlistsRepo.save({ id, name, songIds })
  })

  ipcMain.handle('ncm:playlist-remove', (_e, id) => {
    playlistsRepo.remove(id)
    return true
  })

  // 导出本地歌单为 m3u
  ipcMain.handle('ncm:playlist-export-m3u', async (_e, { id, name }) => {
    const p = playlistsRepo.get(id)
    if (!p) return null
    const r = await dialog.showSaveDialog({
      title: '导出歌单',
      defaultPath: `${name || p.name}.m3u`,
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u'] }]
    })
    if (r.canceled || !r.filePath) return null
    const byId = new Map(libraryRepo.listSongs().map((s) => [s.id, s]))
    const lines = ['#EXTM3U']
    for (const sid of p.songIds) {
      const s = byId.get(sid)
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
    const songIds = []
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const abs = path.isAbsolute(t) ? t : path.join(path.dirname(r.filePaths[0]), t)
      const s = libraryRepo.getByFile(abs)
      if (s) songIds.push(s.id)
    }
    return playlistsRepo.saveImported({
      id: crypto.randomUUID(),
      name: name || path.basename(r.filePaths[0], '.m3u'),
      songIds,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  })
}
