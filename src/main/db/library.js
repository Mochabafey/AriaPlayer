import { getDb } from './index.js'

const COLS = 'id, filePath, title, artist, album, coverPath, duration, size, format, source, songId, addedAt'

export const libraryRepo = {
  listSongs() {
    return getDb().prepare(`SELECT ${COLS} FROM songs ORDER BY addedAt DESC`).all()
  },
  getSong(id) {
    return getDb().prepare(`SELECT ${COLS} FROM songs WHERE id = ?`).get(id) || null
  },
  hasFile(filePath) {
    return !!getDb().prepare('SELECT 1 FROM songs WHERE filePath = ?').get(filePath)
  },
  getByFile(filePath) {
    return getDb().prepare(`SELECT ${COLS} FROM songs WHERE filePath = ?`).get(filePath) || null
  },
  insertSong(s) {
    getDb().prepare(`INSERT OR REPLACE INTO songs
      (id, filePath, title, artist, album, coverPath, duration, size, format, source, songId, addedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.filePath, s.title ?? '', s.artist ?? '', s.album ?? '', s.coverPath ?? null,
        s.duration ?? 0, s.size ?? 0, s.format ?? '', s.source ?? '', s.songId ?? null, s.addedAt ?? Date.now())
  },
  updateSong(id, fields) {
    const cur = this.getSong(id)
    if (!cur) return null
    const merged = { ...cur, ...fields }
    getDb().prepare('UPDATE songs SET title = ?, artist = ?, album = ?, coverPath = ? WHERE id = ?')
      .run(merged.title, merged.artist, merged.album, merged.coverPath, id)
    return merged
  },
  removeSong(id) {
    getDb().prepare('DELETE FROM songs WHERE id = ?').run(id)
  },
  listFolders() {
    return getDb().prepare('SELECT path FROM folders').all().map((r) => r.path)
  },
  addFolder(p) {
    getDb().prepare('INSERT OR IGNORE INTO folders (path, addedAt) VALUES (?, ?)').run(p, Date.now())
  }
}
