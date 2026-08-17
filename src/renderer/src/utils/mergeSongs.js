/**
 * 多音源歌曲匹配合并工具。
 * 归一化歌名/歌手名，把网易云和 QQ 音乐的双源搜索结果按同名歌曲折叠，
 * 不同内容各自保留，前面加平台标记。
 */

/**
 * 归一化：去括号内容、去空格、全小写、去标点。
 * 让 "告白气球（Live）" 和 "告白气球" 视为同一首歌。
 */
export function normalize(s) {
  return (s || '')
    .replace(/[（(][^)）]*[)）]/g, '') // 去括号内容（含中英文括号）
    .replace(/[^\w\u4e00-\u9fff]/g, '') // 只保留中文/英文/数字
    .toLowerCase()
    .trim()
}

/** 取第一个歌手名归一化 */
export function firstArtist(song) {
  // 网易云用 ar，QQ音乐用 artists
  const a = song.ar || song.artists || []
  if (Array.isArray(a) && a.length) return normalize(typeof a[0] === 'object' ? a[0].name : a[0])
  const s = song.artist || ''
  return normalize(s.split('/')[0] || s.split(',')[0] || '')
}

/** 判断两首歌是否同名匹配（歌名相似 + 歌手一致） */
export function isSameSong(a, b) {
  const na = normalize(a.name), nb = normalize(b.name)
  const aa = firstArtist(a), ab = firstArtist(b)
  // 歌名完全一致 OR 包含关系（如 "七里香" vs "七里香 (Live)"）
  const nameMatch = na === nb || (na && nb && (na.includes(nb) || nb.includes(na)))
  // 歌手必须一致
  const artistMatch = aa === ab
  return nameMatch && artistMatch
}

/**
 * 合并网易云和 QQ 音乐搜索结果。
 * 返回 { merged, unmatched }：
 *   - merged: 同名折叠的歌曲列表，含 sources 字段
 *   - unmatched: 只在单一平台出现的歌曲，含 source 标记
 */
export function mergeSearchResults(neteaseSongs, qqSongs) {
  const neSongs = (neteaseSongs || []).map((s) => ({
    ...s,
    source: 'netease',
    // 网易云 cloudsearch 返回的歌曲用 ar 存歌手列表，没有 artist 字段；
    // 补齐 artist 方便后续统一展示
    artist: s.artist || (s.ar || []).map((a) => (typeof a === 'object' ? a.name : a)).join(' / ') || '未知歌手'
  }))
  const qSongs = (qqSongs || []).map((s) => ({ ...s, source: 'qq' }))

  const merged = []
  const usedQQ = new Set()

  for (const ne of neSongs) {
    let found = false
    for (let j = 0; j < qSongs.length; j++) {
      if (usedQQ.has(j)) continue
      if (isSameSong(ne, qSongs[j])) {
        usedQQ.add(j)
        found = true
        merged.push({
          ...ne, // 以网易云字段为主
          name: ne.name,
          artist: ne.artist,
          album: ne.album || (ne.al?.name || ''),
          duration: ne.duration || qSongs[j].duration,
          coverUrl: ne.coverUrl || '',
          merged: true,
          // 网易云用 id（数字），QQ音乐用 songmid（字符串）
          id: ne.id,
          _qqId: qSongs[j].id,
          sources: {
            netease: { ...ne, available: true },
            qq: { ...qSongs[j], available: true }
          }
        })
        break
      }
    }
    if (!found) {
      // 只在网易云有
      merged.push({
        ...ne,
        merged: false,
        sources: { netease: { ...ne, available: true }, qq: null }
      })
    }
  }

  // 只在 QQ 音乐有的歌曲
  const unmatched = qSongs.filter((_, i) => !usedQQ.has(i)).map((s) => ({
    ...s,
    merged: false,
    sources: { netease: null, qq: { ...s, available: true } }
  }))

  return { merged, unmatched }
}

/** 平台 Logo SVG（内联） */
export const PLATFORM_LOGOS = {
  netease: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><circle cx="12" cy="12" r="11" stroke="#EC4141" stroke-width="1.5"/><path d="M12 6c-2.5 0-4.5 1.5-5 3.5 1-.5 2-.5 3 0 .5.3 1 .6 1.5 1 .5.4 1 .7 1.5.7 1.5 0 2.5-1.5 2.5-1.5S14 6 12 6z" fill="#EC4141"/><path d="M7 13c0 2.5 2 4.5 4.5 4.5 1.5 0 2.8-.7 3.7-1.8-.8 0-1.5-.3-2.2-.8-.7-.5-1.3-1.1-1.8-1.8-.4-.5-.7-1.1-.7-1.6 0-1 1-1.5 1-1.5s-2.5-.5-4.5 3z" fill="#EC4141"/></svg>`,
  qq: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><circle cx="12" cy="12" r="11" stroke="#31C27C" stroke-width="1.5"/><path d="M7 18c1-2 2-4 3-6 1-2 2-4 3-6" stroke="#31C27C" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="8" r="2" fill="#31C27C"/><circle cx="16" cy="16" r="2" fill="#31C27C"/></svg>`
}

/** 歌名归一化去括号（用于展示时的短名称） */
export function shortName(name) {
  return (name || '').replace(/[（(][^)）]*[)）]/g, '').trim() || name
}