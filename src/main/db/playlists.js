import crypto from 'crypto'
import { getDb } from './index.js'

function rowToPlaylist(r) {
  let songIds = []
  try { songIds = JSON.parse(r.songIds) } catch { /* ignore */ }
  return { ...r, songIds }
}

export const playlistsRepo = {
  list() {
    return getDb().prepare('SELECT * FROM playlists ORDER BY createdAt DESC').all().map(rowToPlaylist)
  },
  get(id) {
    const r = getDb().prepare('SELECT * FROM playlists WHERE id = ?').get(id)
    return r ? rowToPlaylist(r) : null
  },
  /** 新建或更新（id 命中则更新） */
  save({ id, name, songIds }) {
    if (id) {
      const cur = this.get(id)
      if (cur) {
        getDb().prepare('UPDATE playlists SET name = ?, songIds = ?, updatedAt = ? WHERE id = ?')
          .run(name ?? cur.name, JSON.stringify(songIds ?? cur.songIds), Date.now(), id)
        return this.get(id)
      }
    }
    const nid = id || crypto.randomUUID()
    const now = Date.now()
    getDb().prepare('INSERT INTO playlists (id, name, songIds, imported, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
      .run(nid, name || '新建歌单', JSON.stringify(songIds || []), now, now)
    return this.get(nid)
  },
  saveImported(p) {
    getDb().prepare('INSERT INTO playlists (id, name, songIds, imported, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
      .run(p.id, p.name, JSON.stringify(p.songIds), p.createdAt, p.updatedAt)
    return this.get(p.id)
  },
  remove(id) {
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(id)
  }
}
