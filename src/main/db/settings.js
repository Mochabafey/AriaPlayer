import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { getDb } from './index.js'
import { isPortable, portableDataDir } from '../portable.js'

/**
 * 便携模式下的下载目录默认值：<数据目录>/Music。
 *
 * 不用 app.getPath('music') —— 那是**宿主系统**的音乐文件夹，
 * 便携版的下载结果会留在别人电脑上，与「便携」相悖。
 * 放在数据目录下，U 盘拔走时下载的歌一起带走。
 *
 * 目录创建失败（只读介质）时退回系统音乐目录，不让默认值本身抛错。
 */
function defaultDownloadDir() {
  if (!isPortable()) return app.getPath('music')
  try {
    const dir = path.join(portableDataDir(), 'Music')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return app.getPath('music')
  }
}

const DEFAULTS = {
  downloadDir: defaultDownloadDir(),
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
  /**
   * 启动时最小化到托盘（**独立开关**，对齐 VRCX 的「以最小化的形式启动」）。
   *
   * 默认 false —— 若默认 true，全新安装的用户双击后什么都看不到
   *（窗口直接藏进托盘），会以为程序没启动。
   *
   * 与 minimizeToTray 的区别：
   *   startMinimized —— 控制**启动那一刻**窗口是否显示
   *   minimizeToTray —— 控制**点关闭按钮时**是否驻留后台
   * 两者互不依赖。
   */
  startMinimized: false
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
  /**
   * 该键是否有**显式存储**的值（而非取自 DEFAULTS）。
   *
   * 用于一次性迁移：区分「用户明确设过 false」与「从未设置过、拿的是默认值」。
   */
  has(key) {
    try {
      const r = getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(key)
      return !!r
    } catch {
      return false
    }
  },
  set(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }
}
