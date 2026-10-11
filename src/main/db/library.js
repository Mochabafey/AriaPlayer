import path from 'path'
import { getDb } from './index.js'

const COLS = 'id, filePath, title, artist, album, coverPath, duration, size, format, source, songId, addedAt'

/**
 * 路径规范化：统一分隔符、折叠 `..`/`.`/重复分隔符。
 *
 * ## 为什么读写都要规范化
 *
 * 曲库用 `filePath` 做**精确字符串匹配**查重（hasFile / getByFile）。
 * 而同一个文件可能以不同写法出现：
 *   - 扫描目录 → `path.join` → `D:\Music\a.mp3`（反斜杠）
 *   - M3U 导入 → 播放器导出的文本 → `D:/Music/a.mp3`（正斜杠，跨平台惯例）
 *
 * 这两串字符串不相等，于是「文件明明在曲库，导入却说找不到」。
 * 在仓储层统一规范化，写入与查询两侧就都对齐了 —— 无论调用方怎么写路径。
 *
 * 幂等：已规范化的路径再规范化仍是自身（老数据不受影响）。
 */
function normPath(p) {
  if (!p || typeof p !== 'string') return p
  try {
    return path.normalize(p)
  } catch {
    return p
  }
}

export const libraryRepo = {
  listSongs() {
    return getDb().prepare(`SELECT ${COLS} FROM songs ORDER BY addedAt DESC`).all()
  },
  getSong(id) {
    return getDb().prepare(`SELECT ${COLS} FROM songs WHERE id = ?`).get(id) || null
  },
  hasFile(filePath) {
    return !!getDb().prepare('SELECT 1 FROM songs WHERE filePath = ?').get(normPath(filePath))
  },
  getByFile(filePath) {
    return getDb().prepare(`SELECT ${COLS} FROM songs WHERE filePath = ?`).get(normPath(filePath)) || null
  },
  insertSong(s) {
    getDb().prepare(`INSERT OR REPLACE INTO songs
      (id, filePath, title, artist, album, coverPath, duration, size, format, source, songId, addedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, normPath(s.filePath), s.title ?? '', s.artist ?? '', s.album ?? '', s.coverPath ?? null,
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
  },
  /**
   * 移除监控文件夹。
   *
   * 只删 folders 表里的记录，**不删 songs 表里已扫描到的歌** ——
   * 用户想「不再自动扫描这个目录」，而不是「把这些歌从曲库丢掉」。
   * 真要清歌走 removeSong（右键「从曲库移除」）。
   */
  removeFolder(p) {
    getDb().prepare('DELETE FROM folders WHERE path = ?').run(p)
  }
}
