/**
 * SQLite 数据层（node:sqlite，Electron/Node 22.5+ 内置，零原生编译依赖）。
 * - 单文件 ntr.db 存于 userData/ncm-store/
 * - 所有表结构集中在 SCHEMA，后续加表只需追加
 * - 启动时自动把旧 JsonStore（*.json / session.enc）一次性迁入，原文件改名 .migrated 保留备查
 */
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS folders (
  path    TEXT PRIMARY KEY,
  addedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS songs (
  id        TEXT PRIMARY KEY,
  filePath  TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL DEFAULT '',
  artist    TEXT NOT NULL DEFAULT '',
  album     TEXT,
  coverPath TEXT,
  duration  INTEGER DEFAULT 0,
  size      INTEGER DEFAULT 0,
  format    TEXT,
  source    TEXT,
  songId    TEXT,
  addedAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_songs_added ON songs(addedAt);
CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  songIds     TEXT NOT NULL DEFAULT '[]',
  tracks      TEXT,
  cover       TEXT,
  description TEXT,
  source      TEXT DEFAULT 'local',
  sourceId    TEXT,
  imported    INTEGER DEFAULT 0,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS downloads (
  id        TEXT PRIMARY KEY,
  songId    TEXT,
  title     TEXT,
  artist    TEXT,
  url       TEXT,
  quality   TEXT,
  ext       TEXT,
  path      TEXT,
  status    TEXT,
  received  INTEGER DEFAULT 0,
  total     INTEGER DEFAULT 0,
  error     TEXT,
  createdAt INTEGER,
  cover     TEXT
);
CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(createdAt);
CREATE TABLE IF NOT EXISTS session (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS api_cache (
  key       TEXT PRIMARY KEY,
  payload   TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_cache (
  key          TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  file         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  contentType  TEXT,
  createdAt    INTEGER NOT NULL,
  lastAccessAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_cache_lru ON audio_cache(lastAccessAt);
`

let db = null

export function dbFile() {
  return path.join(app.getPath('userData'), 'ncm-store', 'ntr.db')
}

export function getDb() {
  if (!db) throw new Error('db not initialized')
  return db
}

export function initDb() {
  if (db) return db
  fs.mkdirSync(path.dirname(dbFile()), { recursive: true })
  db = new DatabaseSync(dbFile())
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  migrateColumns()
  migrateFromJson()
  return db
}

/**
 * 追加式列迁移。
 *
 * SCHEMA 里全是 `CREATE TABLE IF NOT EXISTS` —— 对**已存在**的表不会补新列。
 * 所以每次给旧表加字段，都要在这里补一条幂等的 ALTER TABLE。
 *
 * 用 PRAGMA table_info 先查现有列，缺哪列补哪列：重复启动安全，
 * 且比 try/catch 吞掉 "duplicate column name" 错误更明确（不会掩盖其它失败）。
 */
function migrateColumns() {
  const addColumns = (table, columns) => {
    let existing
    try {
      existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
    } catch (e) {
      console.error('[db] table_info failed', table, e.message)
      return
    }
    for (const [name, ddl] of Object.entries(columns)) {
      if (existing.has(name)) continue
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
        console.log(`[db] migrated column ${table}.${name}`)
      } catch (e) {
        console.error(`[db] add column failed ${table}.${name}`, e.message)
      }
    }
  }

  // 歌单扩展：在线导入的曲目快照 + 封面/描述/来源标记
  addColumns('playlists', {
    tracks: 'TEXT',
    cover: 'TEXT',
    description: 'TEXT',
    source: "TEXT DEFAULT 'local'",
    sourceId: 'TEXT'
  })
}

export function closeDb() {
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = null
  }
}

/* ---- 旧 JsonStore 一次性迁移：导入后原文件改名 .migrated，不删除 ---- */
function migrateFromJson() {
  const dir = path.dirname(dbFile())
  const readJson = (name) => {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) return null
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      fs.renameSync(p, p + '.migrated')
      return data
    } catch (e) {
      console.error('[db] migrate read failed', name, e.message)
      return null
    }
  }

  const settings = readJson('settings.json')
  if (settings) {
    const ins = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) ins.run(k, JSON.stringify(v))
    }
    console.log('[db] migrated settings:', Object.keys(settings).length, 'keys')
  }

  const library = readJson('library.json')
  if (library) {
    const insFolder = db.prepare('INSERT OR IGNORE INTO folders (path, addedAt) VALUES (?, ?)')
    for (const f of library.folders || []) insFolder.run(f, Date.now())
    const insSong = db.prepare(`INSERT OR IGNORE INTO songs
      (id, filePath, title, artist, album, coverPath, duration, size, format, source, songId, addedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const s of library.songs || []) {
      if (!s || !s.id || s.id === '__pending__' || !s.filePath) continue
      insSong.run(s.id, s.filePath, s.title ?? '', s.artist ?? '', s.album ?? '', s.coverPath ?? null,
        s.duration ?? 0, s.size ?? 0, s.format ?? '', s.source ?? '', s.songId ?? null, s.addedAt ?? Date.now())
    }
    console.log('[db] migrated library:', (library.songs || []).length, 'songs,', (library.folders || []).length, 'folders')
  }

  const playlists = readJson('playlists.json')
  if (playlists) {
    const ins = db.prepare(`INSERT OR IGNORE INTO playlists (id, name, songIds, imported, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)`)
    for (const p of playlists.list || []) {
      ins.run(p.id, p.name || '未命名歌单', JSON.stringify(p.songIds || []), p.imported ? 1 : 0,
        p.createdAt || Date.now(), p.updatedAt || Date.now())
    }
    console.log('[db] migrated playlists:', (playlists.list || []).length)
  }

  const downloads = readJson('downloads.json')
  if (downloads) {
    const ins = db.prepare(`INSERT OR IGNORE INTO downloads
      (id, songId, title, artist, url, quality, ext, path, status, received, total, error, createdAt, cover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const t of downloads.tasks || []) {
      ins.run(t.id, t.songId ?? null, t.title, t.artist, t.url, t.quality, t.ext, t.path, t.status,
        t.received ?? 0, t.total ?? 0, t.error ?? null, t.createdAt, t.cover ?? null)
    }
    console.log('[db] migrated downloads:', (downloads.tasks || []).length)
  }

  // session.enc（加密 cookie 二进制）→ session 表，加密格式不变
  const encPath = path.join(dir, 'session.enc')
  if (fs.existsSync(encPath)) {
    try {
      const blob = fs.readFileSync(encPath)
      db.prepare('INSERT OR REPLACE INTO session (key, value) VALUES (?, ?)').run('main', blob)
      fs.renameSync(encPath, encPath + '.migrated')
      console.log('[db] migrated session.enc')
    } catch (e) {
      console.error('[db] migrate session failed', e.message)
    }
  }
}
