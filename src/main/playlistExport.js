/**
 * 歌单导出的内容生成（纯函数，不依赖 electron / fs）。
 *
 * 为什么单独拆出来：
 *   导出的「内容生成」与「弹对话框 + 写文件」是两件事。混在 IPC handler 里时，
 *   内容生成逻辑无法被单测覆盖 —— 因为它总要先弹一个 dialog.showSaveDialog，
 *   无人值守环境下根本走不到生成那一步（只能靠复刻算法来「验证」，而那验证
 *   的不是真实代码）。
 *
 *   拆开后：本模块零依赖，可直接被 Node 单测 import，验证真实实现；
 *   IPC handler 只负责对话框与落盘。
 */

/** 文件名安全化：去掉 Windows 非法字符，避免导出时路径非法 */
export function safeFileName(name, fallback = 'playlist') {
  const s = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 80)
  return s || fallback
}

/** 导出格式归一化（非法值回落到 m3u） */
export function normalizeFormat(format) {
  return format === 'json' ? 'json' : format === 'txt' ? 'txt' : 'm3u'
}

export const FORMAT_LABELS = {
  m3u: 'M3U 播放列表',
  json: 'JSON 歌单',
  txt: '文本列表'
}

/**
 * 生成导出内容。
 *
 * @param {object} playlist 歌单记录（用 name/description/source）
 * @param {Array}  songs    已解析的曲目（含 title/artist/album/duration/filePath/_pid）
 * @param {string} format   m3u | json | txt
 * @returns {{content: string, skipped: number, count: number, ext: string}}
 *          skipped：因缺本地文件而被跳过的曲目数（仅 m3u 会跳过）
 */
export function buildPlaylistExport(playlist, songs, format = 'm3u') {
  const ext = normalizeFormat(format)
  const list = Array.isArray(songs) ? songs : []
  let content = ''
  let skipped = 0

  if (ext === 'm3u') {
    const lines = ['#EXTM3U']
    for (const s of list) {
      // 在线曲目没有本地路径 → 无法写进 m3u，跳过并计数（不静默丢弃，让 UI 能提示）
      if (!s.filePath) { skipped++; continue }
      const dur = Math.round(s.duration || 0)
      // EXTINF 的标题里若含逗号会破坏格式（逗号是时长与标题的分隔符）→ 替换成全角
      const label = `${s.artist || ''} - ${s.title || ''}`.replace(/,/g, '，')
      lines.push(`#EXTINF:${dur},${label}`)
      lines.push(s.filePath)
    }
    content = lines.join('\n')
  } else if (ext === 'json') {
    content = JSON.stringify(
      {
        name: playlist?.name || '',
        description: playlist?.description || '',
        source: playlist?.source || 'local',
        exportedAt: new Date().toISOString(),
        count: list.length,
        songs: list.map((s) => ({
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
    content = list
      .map((s, i) => `${String(i + 1).padStart(3, ' ')}. ${s.artist || '未知歌手'} - ${s.title || '未知歌曲'}`)
      .join('\n')
  }

  return { content, skipped, count: list.length - skipped, ext }
}
