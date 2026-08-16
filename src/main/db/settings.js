import { app } from 'electron'
import { getDb } from './index.js'

const DEFAULTS = {
  downloadDir: app.getPath('music'),
  quality: '320000',
  enableUnblock: true,
  enableFlac: true,
  volume: 0.8,
  playMode: 'list'
}

export const settingsRepo = {
  getAll() {
    const out = { ...DEFAULTS }
    for (const row of getDb().prepare('SELECT key, value FROM settings').all()) {
      try { out[row.key] = JSON.parse(row.value) } catch { out[row.key] = row.value }
    }
    return out
  },
  get(key) {
    return this.getAll()[key]
  },
  set(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }
}
