import { getDb } from './index.js'

const KEY = 'main'

/** 加密登录会话（BLOB）。加密算法在 ipc/api.ts（safeStorage/AES-GCM），此处只管存取。 */
export const sessionRepo = {
  load() {
    const r = getDb().prepare('SELECT value FROM session WHERE key = ?').get(KEY)
    return r ? Buffer.from(r.value) : null
  },
  save(buf) {
    getDb().prepare('INSERT OR REPLACE INTO session (key, value) VALUES (?, ?)').run(KEY, buf)
  },
  clear() {
    getDb().prepare('DELETE FROM session WHERE key = ?').run(KEY)
  }
}
