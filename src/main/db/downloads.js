import { getDb } from './index.js'

const COLS = 'id, songId, title, artist, url, quality, ext, path, status, received, total, error, createdAt, cover'

export const downloadsRepo = {
  list() {
    return getDb().prepare(`SELECT ${COLS} FROM downloads ORDER BY createdAt DESC`).all()
  },
  get(id) {
    return getDb().prepare(`SELECT ${COLS} FROM downloads WHERE id = ?`).get(id) || null
  },
  getBySongId(songId) {
    return getDb().prepare(`SELECT ${COLS} FROM downloads WHERE songId = ?`).get(songId) || null
  },
  insert(t) {
    getDb().prepare(`INSERT INTO downloads (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.songId ?? null, t.title, t.artist, t.url, t.quality, t.ext, t.path ?? null, t.status,
        t.received ?? 0, t.total ?? 0, t.error ?? null, t.createdAt, t.cover ?? null)
  },
  update(t) {
    getDb().prepare(`UPDATE downloads SET songId = ?, title = ?, artist = ?, url = ?, quality = ?, ext = ?,
      path = ?, status = ?, received = ?, total = ?, error = ?, cover = ? WHERE id = ?`)
      .run(t.songId ?? null, t.title, t.artist, t.url, t.quality, t.ext, t.path ?? null, t.status,
        t.received ?? 0, t.total ?? 0, t.error ?? null, t.cover ?? null, t.id)
  },
  remove(id) {
    getDb().prepare('DELETE FROM downloads WHERE id = ?').run(id)
  },
  /** 启动恢复：上次未完成（pending/downloading）一律降级为 paused，避免假活跃 */
  pauseAllActive() {
    getDb().prepare(`UPDATE downloads SET status = 'paused' WHERE status IN ('pending', 'downloading')`).run()
  }
}
