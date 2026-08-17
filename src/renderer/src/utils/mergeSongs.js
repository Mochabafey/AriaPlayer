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

/** 平台 Logo SVG（内联，来源：Simple Icons(CC0) / Arcticons(CC BY-SA)） */
export const PLATFORM_LOGOS = {
  netease: `<svg viewBox="0 0 24 24" fill="#D43C33" xmlns="http://www.w3.org/2000/svg"><path d="M13.046 9.388a3.919 3.919 0 0 0-.66.19c-.809.312-1.447.991-1.666 1.775a2.269 2.269 0 0 0-.074.81c.048.546.333 1.05.764 1.35a1.483 1.483 0 0 0 2.01-.286c.406-.531.355-1.183.24-1.636-.098-.387-.22-.816-.345-1.249a64.76 64.76 0 0 1-.269-.954zm-.82 10.07c-3.984 0-7.224-3.24-7.224-7.223 0-.98.226-3.02 1.884-4.822A7.188 7.188 0 0 1 9.502 5.6a.792.792 0 1 1 .587 1.472 5.619 5.619 0 0 0-2.795 2.462 5.538 5.538 0 0 0-.707 2.7 5.645 5.645 0 0 0 5.638 5.638c1.844 0 3.627-.953 4.542-2.428 1.042-1.68.772-3.931-.627-5.238a3.299 3.299 0 0 0-1.437-.777c.172.589.334 1.18.494 1.772.284 1.12.1 2.181-.519 2.989-.39.51-.956.888-1.592 1.064a3.038 3.038 0 0 1-2.58-.44 3.45 3.45 0 0 1-1.44-2.514c-.04-.467.002-.93.128-1.376.35-1.256 1.356-2.339 2.622-2.826a5.5 5.5 0 0 1 .823-.246l-.134-.505c-.37-1.371.25-2.579 1.547-3.007.329-.109.68-.145 1.025-.105.792.09 1.476.592 1.709 1.023.258.507-.096 1.153-.706 1.153a.788.788 0 0 1-.54-.213c-.088-.08-.163-.174-.259-.247a.825.825 0 0 0-.632-.166.807.807 0 0 0-.634.551c-.056.191-.031.406.02.595.07.256.159.597.217.82 1.11.098 2.162.54 2.97 1.296 1.974 1.844 2.35 4.886.892 7.233-1.197 1.93-3.509 3.177-5.889 3.177zM0 12c0 6.627 5.373 12 12 12s12-5.373 12-12S18.627 0 12 0 0 5.373 0 12Z"/></svg>`,
  qq: `<svg viewBox="0 0 48 48" fill="none" stroke="#31C27C" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="21.5"/><path d="M33.235 8.5c-3.736 3.173-8.608 4.076-15.715.507l9.44 10.012c4.308 4.307 4.257 8.173 4.5 12.103c.266 4.296-1.537 6.736-4.067 7.805c-3.655 1.544-9.574-.164-11.681-3.526-1.748-2.787-1.001-7.727 1.621-10.045c4.699-4.153 10.14-3.406 13.84 2.063"/></svg>`
}

/** 歌名归一化去括号（用于展示时的短名称） */
export function shortName(name) {
  return (name || '').replace(/[（(][^)）]*[)）]/g, '').trim() || name
}

/**
 * 合并非歌曲类卡片（歌手/专辑/MV）：同名去重，QQ 结果排在网易云之前。
 * 每条带 source 字段（'netease' | 'qq'），前端据此展示平台 logo。
 */
export function mergeCards(netList = [], qqList = [], nameKey = 'name') {
  const ne = (netList || []).map((x) => ({ ...x, source: x.source || 'netease' }))
  const qq = (qqList || []).map((x) => ({ ...x, source: 'qq' }))
  const seen = new Set(ne.map((x) => normalize(x[nameKey] || '')))
  const extra = qq.filter((x) => {
    const k = normalize(x[nameKey] || '')
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
  return [...extra, ...ne]
}