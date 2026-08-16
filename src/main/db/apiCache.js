import { getDb } from './index.js'

/** API 响应缓存（song_url / lyric / song_detail 等），带 TTL，命中免走子进程 */
export const apiCacheRepo = {
  get(key) {
    const r = getDb().prepare('SELECT payload, expiresAt FROM api_cache WHERE key = ?').get(key)
    if (!r) return null
    if (r.expiresAt < Date.now()) {
      getDb().prepare('DELETE FROM api_cache WHERE key = ?').run(key)
      return null
    }
    try { return JSON.parse(r.payload) } catch { return null }
  },
  set(key, payload, ttlMs) {
    getDb().prepare('INSERT OR REPLACE INTO api_cache (key, payload, expiresAt) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(payload), Date.now() + ttlMs)
  },
  purgeExpired() {
    getDb().prepare('DELETE FROM api_cache WHERE expiresAt < ?').run(Date.now())
  }
}
