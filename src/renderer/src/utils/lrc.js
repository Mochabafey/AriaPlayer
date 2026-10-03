/**
 * LRC 歌词解析：返回 [{time, text, trans?}]，并按时间排序。
 * 空行（纯音乐/前奏间奏占位）被丢弃：期间高亮自然停留在上一句。
 * tRaw 为翻译歌词（网易云 tlyric），按时间就近匹配（容差 0.6s）。
 */
export function parseLrc(raw, tRaw) {
  const base = parseSingle(raw)
  if (!base.length) return []
  if (!tRaw) return base
  const trans = parseSingle(tRaw)
  for (const line of base) {
    let best = null
    let bestDiff = Infinity
    for (const t of trans) {
      const diff = Math.abs(t.time - line.time)
      if (diff < bestDiff) {
        bestDiff = diff
        best = t
      }
    }
    if (best && bestDiff <= 0.6 && best.text) line.trans = best.text
  }
  return base
}

/** 解析单条 LRC：多时间标签展开、去掉空文本行 */
function parseSingle(raw) {
  if (!raw || typeof raw !== 'string') return []
  const lines = raw.split(/\r?\n/)
  const out = []
  const timeRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  /**
   * 元信息行过滤：网易云歌词头部常带制作人员名单（作词/作曲/制作人…），
   * 这些不是歌词，作为字幕显示会很突兀（且会占掉三行里的位置）。
   * 形如：「作词 : Freddie Mercury」「制作人 : Roy Thomas Baker/Queen」
   */
  const META_RE = /^(作词|作曲|编曲|制作人|出品|监制|录音|混音|母带|吉他|贝斯|鼓|键盘|和声|配唱|统筹|企划|发行|OP|SP|词|曲|演唱|原唱|翻唱)\s*[:：]/
  for (const line of lines) {
    const tags = [...line.matchAll(timeRe)]
    if (!tags.length) continue
    const text = line.replace(timeRe, '').trim()
    // 空行与 QQ 歌词的占位行（内容只有 //，表示前奏/间奏）都丢弃，避免界面出现孤零零的 //
    if (!text || /^\/{2,}$/.test(text)) continue
    // 过滤制作人员元信息行
    if (META_RE.test(text)) continue
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
