import { ipcMain, dialog, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { playlistsRepo, normalizeName } from '../db/playlists.js'
import { libraryRepo } from '../db/library.js'

/**
 * 本地歌单 IPC。
 *
 * ## 为什么需要主进程做这些事
 *
 * 渲染层拿不到 fs，也无法访问曲库的完整记录（只有 store 里已加载的列表）。
 * 导出要写文件、导入要读文件、把 songIds 还原成可播放对象要查曲库 ——
 * 都放在这里做，渲染层只负责 UI。
 *
 * ## 「可播放对象」的统一形状
 *
 * 本地曲库歌曲（songs 表）与在线曲目快照（playlists.tracks）字段名不同：
 *   曲库：{ id, filePath, title, artist, album, duration, coverPath }
 *   在线：{ id, name, ar:[{name}], al:{name}, dt, ... }（网易云原始结构）
 *
 * 导出的 m3u 只需要 filePath（本地）或无法导出（在线）；
 * 而「加入播放队列」需要统一成播放器认识的形状。故本文件提供
 * `resolvePlaylistSongs` 输出统一结构，由渲染层决定怎么用。
 */

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.opus'])

/**
 * 把歌单解析成统一的「可播放曲目」数组。
 *
 * 本地歌单：按 songIds 查曲库，**保持歌单顺序**，悬空 id 跳过并计数。
 * 快照歌单：直接用 tracks，并补上 filePath（若恰好曲库里有同 id 的下载歌曲，
 * 就能本地播放而不用走网络 —— 这是「下载过的歌优先本地」的关键优化）。
 */
function resolvePlaylistSongs(p) {
  const byId = new Map(libraryRepo.listSongs().map((s) => [String(s.id), s]))
  const out = []
  let missing = 0

  if (Array.isArray(p.tracks) && p.tracks.length) {
    for (const t of p.tracks) {
      if (!t) continue
      const local = byId.get(String(t.id))
      out.push({
        // 保留原始在线字段（播放器解析音源需要），同时补本地信息
        ...t,
        _pid: String(t.id),
        title: t.title || t.name || '未知歌曲',
        artist: t.artist || (Array.isArray(t.ar) ? t.ar.map((a) => a.name).filter(Boolean).join(' / ') : '') || '未知歌手',
        album: t.album || t.al?.name || '',
        duration: t.duration || (t.dt ? Math.round(t.dt / 1000) : 0),
        coverPath: t.coverPath || local?.coverPath || null,
        // 本地命中 → 直接本地播，省一次音源解析与网络请求
        filePath: local?.filePath || null,
        fromLocal: !!local
      })
    }
    return { songs: out, missing }
  }

  for (const sid of p.songIds || []) {
    const s = byId.get(String(sid))
    if (!s) { missing++; continue }
    out.push({ ...s, _pid: String(s.id), fromLocal: true })
  }
  return { songs: out, missing }
}

/** 文件名安全化：去掉 Windows 非法字符，避免导出时路径非法 */
function safeFileName(name, fallback = 'playlist') {
  const s = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 80)
  return s || fallback
}

export function registerPlaylistIpc({ notifyUpdate = () => {}, apiCall = null } = {}) {
  const notify = () => { try { notifyUpdate() } catch { /* ignore */ } }

  // ---- 列表 / 详情 ----
  ipcMain.handle('ncm:playlist-list', () => playlistsRepo.list())

  /**
   * 歌单详情：返回歌单本身 + 解析好的可播放曲目 + 悬空引用数。
   * 渲染层不必自己拼装，避免两边字段映射逻辑不一致。
   */
  ipcMain.handle('ncm:playlist-detail', (_e, id) => {
    const p = playlistsRepo.get(id)
    if (!p) return null
    const { songs, missing } = resolvePlaylistSongs(p)
    return { playlist: p, songs, missing }
  })

  // ---- 增删改 ----
  ipcMain.handle('ncm:playlist-create', (_e, { name, songIds } = {}) => {
    const p = playlistsRepo.save({ name: normalizeName(name), songIds: songIds || [], source: 'local' })
    notify()
    return p
  })

  ipcMain.handle('ncm:playlist-save', (_e, { id, name, songIds }) => {
    const p = playlistsRepo.save({ id, name, songIds })
    notify()
    return p
  })

  ipcMain.handle('ncm:playlist-rename', (_e, { id, name }) => {
    const p = playlistsRepo.rename(id, name)
    notify()
    return p
  })

  ipcMain.handle('ncm:playlist-remove', (_e, id) => {
    playlistsRepo.remove(id)
    notify()
    return true
  })

  // ---- 曲目增删 ----
  ipcMain.handle('ncm:playlist-add-songs', (_e, { id, songIds }) => {
    const r = playlistsRepo.addSongs(id, songIds)
    if (r.added) notify()
    return r
  })

  ipcMain.handle('ncm:playlist-remove-songs', (_e, { id, songIds }) => {
    const r = playlistsRepo.removeSongs(id, songIds)
    if (r.removed) notify()
    return r
  })

  ipcMain.handle('ncm:playlist-reorder', (_e, { id, orderedIds }) => {
    const p = playlistsRepo.reorder(id, orderedIds)
    notify()
    return p
  })

  // ---- 导出 ----
  /**
   * 导出歌单。
   *
   * 三种格式：
   *   m3u  —— 通用播放列表，只有本地文件能导出（在线曲目没有路径，跳过并计数）
   *   json —— 完整快照，含在线曲目信息，可用于备份/迁移
   *   txt  —— 纯歌名列表，方便分享/贴给别人
   */
  ipcMain.handle('ncm:playlist-export', async (_e, { id, format = 'm3u' }) => {
    const p = playlistsRepo.get(id)
    if (!p) return { ok: false, reason: 'not found' }
    const { songs } = resolvePlaylistSongs(p)

    const ext = format === 'json' ? 'json' : format === 'txt' ? 'txt' : 'm3u'
    const filterName = { m3u: 'M3U 播放列表', json: 'JSON 歌单', txt: '文本列表' }[ext]
    const r = await dialog.showSaveDialog({
      title: '导出歌单',
      defaultPath: `${safeFileName(p.name)}.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }

    let content = ''
    let skipped = 0

    if (ext === 'm3u') {
      const lines = ['#EXTM3U']
      for (const s of songs) {
        if (!s.filePath) { skipped++; continue }
        const dur = Math.round(s.duration || 0)
        // EXTINF 的标题里若含逗号会破坏格式（逗号是时长与标题的分隔符）→ 替换掉
        const label = `${s.artist || ''} - ${s.title || ''}`.replace(/,/g, '，')
        lines.push(`#EXTINF:${dur},${label}`)
        lines.push(s.filePath)
      }
      content = lines.join('\n')
    } else if (ext === 'json') {
      content = JSON.stringify(
        {
          name: p.name,
          description: p.description || '',
          source: p.source,
          exportedAt: new Date().toISOString(),
          count: songs.length,
          songs: songs.map((s) => ({
            id: s._pid,
            title: s.title,
            artist: s.artist,
            album: s.album,
            duration: s.duration,
            filePath: s.filePath || null
          }))
        },
        null,
        2
      )
    } else {
      content = songs.map((s, i) => `${String(i + 1).padStart(3, ' ')}. ${s.artist || '未知歌手'} - ${s.title || '未知歌曲'}`).join('\n')
    }

    try {
      fs.writeFileSync(r.filePath, content, 'utf-8')
      return { ok: true, path: r.filePath, count: songs.length - skipped, skipped }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  })

  // 兼容旧通道（曲库页原来用这个）
  ipcMain.handle('ncm:playlist-export-m3u', async (e, { id, name }) => {
    const p = playlistsRepo.get(id)
    if (!p) return null
    const { songs } = resolvePlaylistSongs(p)
    const r = await dialog.showSaveDialog({
      title: '导出歌单',
      defaultPath: `${safeFileName(name || p.name)}.m3u`,
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u'] }]
    })
    if (r.canceled || !r.filePath) return null
    const lines = ['#EXTM3U']
    for (const s of songs) {
      if (!s.filePath) continue
      lines.push(`#EXTINF:${Math.round(s.duration || 0)},${s.artist} - ${s.title}`)
      lines.push(s.filePath)
    }
    fs.writeFileSync(r.filePath, lines.join('\n'), 'utf-8')
    return r.filePath
  })

  // ---- 导入 M3U ----
  ipcMain.handle('ncm:playlist-import-m3u', async (_e, name) => {
    const r = await dialog.showOpenDialog({
      title: '导入 M3U 歌单',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u', 'm3u8'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const file = r.filePaths[0]
    const raw = fs.readFileSync(file, 'utf-8')
    const songIds = []
    let missing = 0
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const abs = path.isAbsolute(t) ? t : path.join(path.dirname(file), t)
      const s = libraryRepo.getByFile(abs)
      if (s) songIds.push(s.id)
      else missing++
    }
    const p = playlistsRepo.saveImported({
      id: crypto.randomUUID(),
      name: normalizeName(name || path.basename(file, path.extname(file))),
      songIds,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    notify()
    return { playlist: p, total: songIds.length + missing, matched: songIds.length, missing }
  })

  /**
   * 导入**曲库清单**（m3u/json）里的歌曲到曲库。
   *
   * 与上面 playlist-import-m3u 的区别：
   *   上面那个 → 建歌单，只收录「曲库里已有」的文件
   *   这个     → 直接把文件加入曲库（会解析元数据、抽封面），随后可自由建歌单
   */
  ipcMain.handle('ncm:playlist-import-file', async (_e, { targetPlaylistId } = {}) => {
    const r = await dialog.showOpenDialog({
      title: '导入歌单文件',
      filters: [{ name: '歌单文件', extensions: ['m3u', 'm3u8', 'json'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    const file = r.filePaths[0]
    const ext = path.extname(file).toLowerCase()

    const paths = []
    if (ext === '.json') {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
        // 兼容两种 json：导出的歌单快照 { songs:[...] } 与曲库清单 [...]
        const arr = Array.isArray(data) ? data : data.songs || []
        for (const s of arr) if (s && s.filePath) paths.push(s.filePath)
      } catch (e) {
        return { ok: false, reason: 'JSON 解析失败：' + e.message }
      }
    } else {
      const raw = fs.readFileSync(file, 'utf-8')
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        paths.push(path.isAbsolute(t) ? t : path.join(path.dirname(file), t))
      }
    }

    // 已在曲库的 + 需要新导入的
    const songIds = []
    let missing = 0
    const toImport = []
    for (const p of paths) {
      if (!AUDIO_EXTS.has(path.extname(p).toLowerCase())) { missing++; continue }
      if (!fs.existsSync(p)) { missing++; continue }
      const existing = libraryRepo.getByFile(p)
      if (existing) songIds.push(existing.id)
      else toImport.push(p)
    }

    // 复用曲库的导入能力（含元数据解析与封面抽取）
    let imported = 0
    if (toImport.length) {
      imported = await importFilesToLibrary(toImport)
      for (const p of toImport) {
        const s = libraryRepo.getByFile(p)
        if (s) songIds.push(s.id)
      }
    }

    // 可选：直接塞进指定歌单
    let added = 0
    if (targetPlaylistId && songIds.length) {
      added = playlistsRepo.addSongs(targetPlaylistId, songIds).added
    }
    notify()
    return {
      ok: true,
      file,
      name: path.basename(file, ext),
      matched: songIds.length,
      imported,
      added,
      missing
    }
  })

  /**
   * 导入**网易云歌单**。
   *
   * 曲目通过 ncmServer 的 playlist_detail + playlist_track_all 拿（后者才能
   * 突破默认只返回前若干首的限制），然后快照入库。
   *
   * @param apiCall 由 ipc/api.js 注入的「调用网易云接口」函数 ——
   *   避免本模块直接依赖 ncmServer 实例（那样会形成循环依赖）
   */
  ipcMain.handle('ncm:playlist-import-netease', async (_e, { id, name } = {}) => {
    const pid = String(id || '').trim()
    if (!/^\d+$/.test(pid)) return { ok: false, reason: '歌单 ID 无效（应为纯数字）' }
    if (typeof apiCall !== 'function') return { ok: false, reason: '服务未就绪' }

    try {
      const detail = await apiCall('playlist_detail', { id: pid })
      const pl = detail?.playlist
      if (!pl) return { ok: false, reason: '歌单不存在或未公开' }

      // 先取详情里带的曲目；不足总数时用 track_all 补齐（网易云对非会员
      // 只返回前 10 首 trackIds，playlist_detail 的 tracks 往往是残缺的）
      let tracks = Array.isArray(pl.tracks) ? pl.tracks.slice() : []
      const total = pl.trackCount || pl.tracks?.length || 0
      if (tracks.length < total) {
        try {
          const all = await apiCall('playlist_track_all', { id: pid, limit: 1000 })
          if (Array.isArray(all?.songs) && all.songs.length > tracks.length) {
            tracks = all.songs
          }
        } catch (e) {
          console.warn('[playlist] track_all failed, 使用详情页曲目', e.message)
        }
      }
      if (!tracks.length) return { ok: false, reason: '歌单为空或曲目不可见（可能需要登录）' }

      const p = playlistsRepo.importOnline({
        name: normalizeName(name || pl.name),
        tracks,
        cover: pl.coverImgUrl || null,
        description: pl.description || '',
        source: 'netease',
        sourceId: pid
      })
      notify()
      return { ok: true, playlist: p, count: tracks.length }
    } catch (e) {
      return { ok: false, reason: e.message || '导入失败' }
    }
  })
}

/**
 * 把文件批量加入曲库（解析元数据 + 抽封面）。
 *
 * 这段逻辑与 ipc/library.js 的 importOne 重复 —— 但那边是闭包内的私有函数。
 * 抽公共模块会牵动 library.js 的较大改动，而本次改动范围已经不小；
 * 故此处保留一份精简实现（只做导入，不做扫描去重策略）。
 */
async function importFilesToLibrary(files) {
  const { app } = await import('electron')
  const crypto = await import('crypto')
  let mm = null
  try { mm = await import('music-metadata') } catch { return 0 }
  const coversDir = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(coversDir, { recursive: true })

  let added = 0
  for (const filePath of files) {
    if (libraryRepo.hasFile(filePath)) continue
    try {
      const meta = await mm.parseFile(filePath, { duration: true })
      const st = fs.statSync(filePath)
      const id = crypto.createHash('md5').update(`${filePath}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
      const pic = meta.common.picture?.[0]
      let coverPath = null
      if (pic) {
        const ext = pic.format.includes('png') ? 'png' : 'jpg'
        coverPath = path.join(coversDir, `${id}.${ext}`)
        fs.writeFileSync(coverPath, pic.data)
      }
      libraryRepo.insertSong({
        id,
        filePath,
        title: meta.common.title || path.basename(filePath, path.extname(filePath)),
        artist: meta.common.artist || '未知歌手',
        album: meta.common.album || '',
        coverPath,
        duration: Math.round(meta.format.duration || 0),
        size: meta.format.size || st.size,
        format: path.extname(filePath).slice(1).toLowerCase(),
        source: 'import',
        songId: null,
        addedAt: Date.now()
      })
      added++
    } catch (e) {
      console.error('[playlist] import failed', filePath, e.message)
    }
  }
  return added
}
