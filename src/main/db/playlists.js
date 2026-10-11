import crypto from 'crypto'
import { getDb } from './index.js'

/**
 * 歌单仓储。
 *
 * ## 两种歌单形态
 *
 *  - **local**（本地歌单）：`songIds` 引用曲库（songs 表）里的 id。
 *    曲库移除某首歌后，歌单里的引用会成为悬空 id —— 读取时按曲库现状过滤，
 *    所以不需要级联清理，删歌不会破坏歌单结构（重新加回同一文件即可复原）。
 *
 *  - **imported / netease**（导入歌单）：`tracks` 存**曲目快照**（完整歌曲对象）。
 *    网易云歌单里的歌通常不在本地磁盘上，无法用 songIds 引用，
 *    因此导入时把歌名/歌手/专辑/时长/id 快照下来，播放时走在线音源。
 *    快照与上游不再同步（上游改歌单不会影响本地副本），这是刻意的：
 *    用户导入即「拿走一份」，不应因上游变动而丢失。
 *
 * `imported` 是历史字段（1 = 来自 m3u 导入），保留以兼容旧数据；
 * 新代码用 `source` 判断：'local' | 'netease' | 'qq' | 'm3u'。
 */

const MAX_NAME_LEN = 60

function parseJson(text, fallback) {
  if (!text) return fallback
  try {
    const v = JSON.parse(text)
    return v ?? fallback
  } catch {
    return fallback
  }
}

function rowToPlaylist(r) {
  if (!r) return null
  return {
    ...r,
    songIds: parseJson(r.songIds, []),
    tracks: parseJson(r.tracks, null),
    // 兼容旧数据：imported=1 但没有 source 的，视为 m3u 导入
    source: r.source || (r.imported ? 'm3u' : 'local')
  }
}

/** 歌单名清洗：去首尾空白、压缩内部空白、限长、空则给默认名 */
export function normalizeName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN)
  return s || '新建歌单'
}

export const playlistsRepo = {
  list() {
    return getDb()
      .prepare('SELECT * FROM playlists ORDER BY createdAt DESC')
      .all()
      .map(rowToPlaylist)
  },

  get(id) {
    return rowToPlaylist(getDb().prepare('SELECT * FROM playlists WHERE id = ?').get(id))
  },

  /** 新建或更新（id 命中则更新）。只覆盖显式传入的字段，避免误清空。 */
  save({ id, name, songIds, tracks, cover, description, source, sourceId }) {
    const db = getDb()
    if (id) {
      const cur = this.get(id)
      if (cur) {
        db.prepare(
          `UPDATE playlists SET name = ?, songIds = ?, tracks = ?, cover = ?, description = ?,
             source = ?, sourceId = ?, updatedAt = ? WHERE id = ?`
        ).run(
          name !== undefined ? normalizeName(name) : cur.name,
          JSON.stringify(songIds !== undefined ? songIds : cur.songIds),
          tracks !== undefined ? JSON.stringify(tracks) : (cur.tracks ? JSON.stringify(cur.tracks) : null),
          cover !== undefined ? cover : cur.cover,
          description !== undefined ? description : cur.description,
          source !== undefined ? source : cur.source,
          sourceId !== undefined ? sourceId : cur.sourceId,
          Date.now(),
          id
        )
        return this.get(id)
      }
    }
    const nid = id || crypto.randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO playlists (id, name, songIds, tracks, cover, description, source, sourceId, imported, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      nid,
      normalizeName(name),
      JSON.stringify(songIds || []),
      tracks ? JSON.stringify(tracks) : null,
      cover ?? null,
      description ?? null,
      source || 'local',
      sourceId ?? null,
      now,
      now
    )
    return this.get(nid)
  },

  /** 旧接口（m3u 导入）保留：等价于 save({source:'m3u'}) */
  saveImported(p) {
    const db = getDb()
    db.prepare(
      `INSERT INTO playlists (id, name, songIds, tracks, cover, description, source, sourceId, imported, createdAt, updatedAt)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'm3u', NULL, 1, ?, ?)`
    ).run(p.id, normalizeName(p.name), JSON.stringify(p.songIds || []), p.createdAt, p.updatedAt)
    return this.get(p.id)
  },

  /**
   * 导入在线歌单（网易云等）：存曲目快照。
   *
   * 重名不合并 —— 用户可能故意导入同一歌单的不同快照版本；
   * 但会记录 sourceId，便于 UI 提示「已导入过」。
   */
  importOnline({ name, tracks, cover, description, source, sourceId }) {
    return this.save({
      name,
      songIds: [],
      tracks: tracks || [],
      cover: cover ?? null,
      description: description ?? null,
      source: source || 'netease',
      sourceId: sourceId ?? null
    })
  },

  remove(id) {
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(id)
  },

  rename(id, name) {
    const cur = this.get(id)
    if (!cur) return null
    getDb()
      .prepare('UPDATE playlists SET name = ?, updatedAt = ? WHERE id = ?')
      .run(normalizeName(name), Date.now(), id)
    return this.get(id)
  },

  /**
   * 向歌单加歌（去重，保持既有顺序，新歌追加到末尾）。
   * @returns {{added:number, skipped:number, playlist:object|null}}
   */
  addSongs(id, songIds) {
    const cur = this.get(id)
    if (!cur) return { added: 0, skipped: 0, playlist: null }
    const seen = new Set(cur.songIds)
    let added = 0
    let skipped = 0
    for (const sid of songIds || []) {
      if (!sid) continue
      if (seen.has(sid)) { skipped++; continue }
      seen.add(sid)
      cur.songIds.push(sid)
      added++
    }
    if (added) {
      getDb()
        .prepare('UPDATE playlists SET songIds = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(cur.songIds), Date.now(), id)
    }
    return { added, skipped, playlist: this.get(id) }
  },

  /**
   * 从歌单移歌。
   *
   * 对快照型歌单（tracks 有值）同时从快照里剔除 —— 否则 UI 按 tracks 渲染时
   * 会「删了还在」。用 String() 比较，因为在线曲目 id 可能是 number。
   */
  removeSongs(id, songIds) {
    const cur = this.get(id)
    if (!cur) return { removed: 0, playlist: null }
    const kill = new Set((songIds || []).map(String))
    const before = cur.songIds.length
    const kept = cur.songIds.filter((s) => !kill.has(String(s)))
    let tracks = cur.tracks
    if (Array.isArray(tracks)) {
      tracks = tracks.filter((t) => !kill.has(String(t?.id)))
    }
    getDb()
      .prepare('UPDATE playlists SET songIds = ?, tracks = ?, updatedAt = ? WHERE id = ?')
      .run(
        JSON.stringify(kept),
        Array.isArray(tracks) ? JSON.stringify(tracks) : null,
        Date.now(),
        id
      )
    return { removed: before - kept.length, playlist: this.get(id) }
  },

  /** 拖拽排序：按传入的完整 id 顺序重写（只接受与现有集合一致的排列） */
  reorder(id, orderedIds) {
    const cur = this.get(id)
    if (!cur) return null
    const want = (orderedIds || []).map(String)
    const have = new Set(cur.songIds.map(String))
    if (want.length !== have.size || !want.every((x) => have.has(x))) return cur
    // 用原始 songIds 里的真实值（保持类型），按 want 顺序重排
    const byId = new Map(cur.songIds.map((s) => [String(s), s]))
    const next = want.map((x) => byId.get(x))
    getDb()
      .prepare('UPDATE playlists SET songIds = ?, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(next), Date.now(), id)
    return this.get(id)
  }
}
