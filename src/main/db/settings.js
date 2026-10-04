import { app } from 'electron'
import { getDb } from './index.js'

const DEFAULTS = {
  downloadDir: app.getPath('music'),
  quality: '320000',
  enableUnblock: true,
  enableFlac: true,
  volume: 0.8,
  playMode: 'list',
  // 启动时预加载 QQ 音乐服务（默认关闭：它冷启动约 4.9s，改为首次使用才拉起）
  qqPreload: false,
  // 关闭窗口时最小化到托盘而非退出
  minimizeToTray: false,
  // 开机自启
  autoLaunch: false,
  // 开机自启时最小化到托盘
  startMinimized: true
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
