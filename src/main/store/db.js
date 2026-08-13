// 直接 require('electron') 取 app，绕开 rollup 对 `import { app }` 的
// __toESM 命名空间 interop 陷阱（electron 模块的 app 走 getter，
// 命名空间复制时丢失，导致 electron.app 为 undefined）。
import fs from 'fs'
import path from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { app } = require('electron')

class JsonStore {
  constructor(name, defaults = {}) {
    this.name = name
    this.defaults = defaults
    this.data = null
    this.timer = null
  }

  file() {
    return path.join(app.getPath('userData'), 'ncm-store', `${this.name}.json`)
  }

  load() {
    if (this.data !== null) return this.data
    try {
      const raw = fs.readFileSync(this.file(), 'utf-8')
      this.data = { ...this.defaults, ...JSON.parse(raw) }
    } catch {
      this.data = { ...this.defaults }
    }
    return this.data
  }

  get(key) {
    const d = this.load()
    return key === undefined ? d : d[key]
  }

  set(key, value) {
    this.load()[key] = value
    this.scheduleSave()
  }

  update(fn) {
    fn(this.load())
    this.scheduleSave()
  }

  scheduleSave() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 300)
  }

  saveNow() {
    clearTimeout(this.timer)
    try {
      const dir = path.dirname(this.file())
      fs.mkdirSync(dir, { recursive: true })
      const tmp = this.file() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.file())
    } catch (e) {
      console.error('[store] save failed', this.name, e)
    }
  }
}

export const stores = {
  library: new JsonStore('library', { songs: [], folders: [] }),
  playlists: new JsonStore('playlists', { list: [] }),
  downloads: new JsonStore('downloads', { tasks: [] }),
  settings: new JsonStore('settings', {
    downloadDir: app.getPath('music'),
    quality: '320000',
    enableUnblock: true,
    enableFlac: true,
    volume: 0.8,
    playMode: 'list'
  })
}

export function flushAll() {
  Object.values(stores).forEach((s) => s.saveNow())
}

export const QUALITY_MAP = {
  '128000': { ext: 'mp3', br: 128000 },
  '320000': { ext: 'mp3', br: 320000 },
  lossless: { ext: 'flac', br: 999000 }
}
