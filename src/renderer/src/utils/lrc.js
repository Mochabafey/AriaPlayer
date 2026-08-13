/**
 * LRC 歌词解析：返回 [{time, text}]，并按时间排序。
 */
export function parseLrc(raw) {
  if (!raw || typeof raw !== 'string') return []
  const lines = raw.split(/\r?\n/)
  const out = []
  const timeRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const line of lines) {
    const tags = [...line.matchAll(timeRe)]
    if (!tags.length) continue
    const text = line.replace(timeRe, '').trim()
    for (const t of tags) {
      const min = parseInt(t[1], 10)
      const sec = parseInt(t[2], 10)
      const frac = t[3] ? parseInt(t[3].padEnd(3, '0'), 10) : 0
      const time = min * 60 + sec + frac / 1000
      out.push({ time, text })
    }
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/** 根据当前播放时间返回当前行索引 */
export function activeIndex(lines, time) {
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time + 0.35) idx = i
    else break
  }
  return idx
}
