/**
 * lrcSync.js — 歌词自动对轨
 *
 * ## 问题
 *
 * 歌词（LRC）的时间戳是相对**歌曲**的，而 MV 的播放时间是相对**视频**的。
 * MV 常带额外前奏/尾奏（实测某 MV 317s vs 原曲 269s，差 48s），
 * 直接套用会导致歌词与画面错位（用户看到「00:34 显示开头的歌词」）。
 *
 * ## 思路
 *
 * B 站 MV 常有 UP 主上传的 CC 字幕，**它与视频天然同步**。
 * 把 CC 字幕的文本与歌词文本做匹配，同一句在两个源里的时间差就是偏移量：
 *
 *     offset = CC时间 - 歌词时间
 *
 * 取多句差值的**中位数**作为最终偏移（抗离群）。
 *
 * ## 为什么要抗离群
 *
 * 歌词常有重复段落（副歌），文本匹配会把 CC 的「第二段副歌」匹配到歌词的
 * 「第一段副歌」，产生巨大偏差（实测范围 -89.8s ~ 183.5s）。
 * 处理：
 *   1. 只取相似度高的匹配（>= 0.6）
 *   2. 取中位数而非平均值
 *   3. 剔除偏离中位数过大的样本后重算（迭代收紧）
 *   4. 用「落在中位数 ±1.5s 内的样本比例」作为置信度
 */

/** 文本归一化：去装饰符、标点、空白，英文转小写 */
function norm(s) {
  return String(s || '')
    .replace(/[♪♫♬\s]/g, '')
    .replace(/[，。！？、；：""''（）《》【】,.!?;:'"()[\]]/g, '')
    .toLowerCase()
    .trim()
}

/** 最长公共子串长度（短句场景足够，O(n·m)） */
function lcsLen(a, b) {
  if (!a || !b) return 0
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  let best = 0
  for (let i = 0; i < short.length; i++) {
    for (let j = i + best + 1; j <= short.length; j++) {
      if (long.includes(short.slice(i, j))) best = j - i
      else break
    }
  }
  return best
}

/** 相似度 = 最长公共子串 / 较长串长度 */
function similarity(a, b) {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return 0
  const longer = Math.max(na.length, nb.length)
  return lcsLen(na, nb) / longer
}

/**
 * 计算歌词相对视频的偏移量。
 *
 * @param {Array<{time:number,text:string}>} ccLines    B 站 CC 字幕（与视频同步）
 * @param {Array<{time:number,text:string}>} lyricLines 歌词（相对歌曲）
 * @param {object} opts
 *   - minScore?: number  相似度阈值，默认 0.6
 *   - minSamples?: number 最少匹配句数，默认 4
 * @returns {{
 *   ok: boolean,
 *   offset: number,       偏移秒数（歌词时间 + offset = 视频时间）
 *   confidence: number,   0~1，一致性比例
 *   samples: number,      参与计算的匹配句数
 *   reason?: string
 * }}
 */
export function computeOffset(ccLines, lyricLines, opts = {}) {
  const minScore = opts.minScore ?? 0.6
  const minSamples = opts.minSamples ?? 4

  if (!ccLines?.length || !lyricLines?.length) {
    return { ok: false, offset: 0, confidence: 0, samples: 0, reason: 'no-data' }
  }

  // 1) 每句 CC 找最相似的歌词句
  const diffs = []
  for (const c of ccLines) {
    const cn = norm(c.text)
    if (cn.length < 4) continue // 太短（如 "♪ 我四岁 ♪"）不可靠
    let best = null
    let bestScore = 0
    for (const l of lyricLines) {
      const s = similarity(c.text, l.text)
      if (s > bestScore) {
        bestScore = s
        best = l
      }
    }
    if (best && bestScore >= minScore) {
      diffs.push({ diff: c.time - best.time, score: bestScore })
    }
  }

  if (diffs.length < minSamples) {
    return { ok: false, offset: 0, confidence: 0, samples: diffs.length, reason: 'too-few-samples' }
  }

  /**
   * 2) 迭代收紧：取中位数 → 剔除偏离 >3s 的 → 重算，最多 3 轮。
   * 重复段落（副歌）产生的巨大偏差会在第一轮被剔掉。
   */
  let pool = diffs
  let median = 0
  for (let round = 0; round < 3; round++) {
    const sorted = pool.map((d) => d.diff).sort((a, b) => a - b)
    median = sorted[Math.floor(sorted.length / 2)]
    const kept = pool.filter((d) => Math.abs(d.diff - median) <= 3)
    if (kept.length === pool.length || kept.length < minSamples) break
    pool = kept
  }

  // 3) 置信度 = 落在中位数 ±1.5s 内的比例
  const near = pool.filter((d) => Math.abs(d.diff - median) <= 1.5).length
  const confidence = pool.length ? near / pool.length : 0

  return {
    ok: true,
    offset: Math.round(median * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    samples: pool.length,
    // 供 UI 提示：置信度低时建议手动微调
    reliable: confidence >= 0.6 && pool.length >= minSamples
  }
}

/**
 * 对歌词行施加偏移（返回新数组，不改原数据）。
 * 偏移后时间 <0 的行保留（其 time 置 0），避免开头歌词丢失。
 */
export function applyOffset(lines, offset) {
  if (!offset) return lines
  return lines.map((l) => ({ ...l, time: Math.max(0, l.time + offset) }))
}
