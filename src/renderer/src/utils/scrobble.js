import { api, bili } from '../api'

/**
 * 播放记录同步（双上报）。
 *
 * ## 网易云（听歌打卡）—— 需要**两个接口配合**
 *
 * 背景：本项目此前从未调用过 scrobble，所以用咏叹调听的歌在网易云
 * 客户端/网页的「最近播放」与「听歌排行」里完全看不到——不是接口缺失，
 * 而是前端根本没上报。
 *
 * ### 两个接口分工不同（实测确认，缺一不可）
 *
 * | 接口 | 写入「最近播放」 | 写入「听歌时长」 |
 * |---|---|---|
 * | `scrobble`（weblog startplay+play） | ✅ 确定生效 | 部分 |
 * | `scrobble_v1`（NCBL clientlog） | ❌ **不可靠** | ✅ 是 |
 *
 * 实测证据：连续用 `scrobble_v1` 上报 3 首，只有 1 首进了「最近播放」；
 * 而用 `scrobble` 上报后，歌曲**立刻**出现在「最近播放」最前面。
 * 这正是「歌曲记录丢了好几首」的根因 —— clientlog 是异步日志管道，
 * 不保证每条都落到播放记录里。
 *
 * 所以两者都要调：
 *   - `scrobble`    → 保证「最近播放」列表完整
 *   - `scrobble_v1` → 保证「听歌时长」准确增长
 *
 * ## B 站（观看历史）
 *
 * MV 播放同样从未上报，所以在 B 站 App/网页的「历史记录」里看不到。
 * 用 /x/click-interface/web/heartbeat 上报播放位置（见 biliClient.reportProgress）。
 *
 * ## 上报时机（两个平台共用同一套门槛）
 *
 *   - 播放时长 ≥ 30s，或
 *   - 播放时长 ≥ 总时长的 50%（短歌/试听片段）
 *   满足其一即首次上报；之后每满 60 秒补报一次时长。
 */

/** 最短上报时长（秒），对齐网易云官方 30s 规则 */
const MIN_PLAY_SEC = 30
/** 或播放过半即上报 */
const HALF_RATIO = 0.5
/**
 * 二次上报（补报）间隔（秒）。
 *
 * 为什么需要：原先「一次播放只上报一次」，且报的是**门槛刚过那一刻**的
 * listenedSec（≈30s）。听 5 分钟的歌也只报 30 秒 —— 网易云的「听歌时长」
 * 因此几乎不增长（用户实测：听半小时只涨 1 分钟）。
 *
 * 现在改为**按完整播放的整分钟数补报**：每听满 60 秒就再报一次，
 * 让累计时长如实增长。B 站网页播放器的心跳也是这个思路。
 */
const REPEAT_INTERVAL_SEC = 60
/** 单次上报的时长上限（秒）：超过一首歌的长度没有意义，防止异常值 */
const MAX_REPORT_SEC = 3600

/** 已上报过的标识（每次切歌清空），防重复上报 */
let reportedForEpoch = null
/** 当前这次播放的累计有效播放秒数（暂停不计） */
let listenedSec = 0
/** 上一次 timeupdate 的时间戳，用于累加真实播放时长（而非音频位置差） */
let lastTickAt = 0
/** 播放代次号：切歌后旧的上报请求作废 */
let reportEpoch = 0
/** 本次播放已上报到的时长（秒），用于按整分钟补报 */
let reportedUpto = 0

/** 累计播放时长（只在真正播放时推进，拖动 seek 不计入） */
function tick(playing, currentTime) {
  const now = Date.now()
  if (!playing) {
    lastTickAt = 0
    return
  }
  if (lastTickAt) {
    const delta = (now - lastTickAt) / 1000
    // 单次间隔 > 2s 视为卡顿/挂起，不计入（避免把缓冲时间算成收听时长）
    if (delta > 0 && delta < 2) listenedSec += delta
  }
  lastTickAt = now
}

/** 切歌时重置统计 */
export function resetScrobble() {
  reportEpoch++
  reportedForEpoch = null
  listenedSec = 0
  lastTickAt = 0
  reportedUpto = 0
}

/** 当前累计的有效播放秒数（供 MV 上报用） */
export function listenedSeconds() {
  return listenedSec
}

/**
 * 向网易云上报一次播放（**双接口**）。
 *
 * 为什么两个都发（实测确认，见文件头注释）：
 *   - `scrobble`    → 写「最近播放」列表，**必须**发，否则歌曲记录会丢
 *   - `scrobble_v1` → 写「听歌时长」，**必须**发，否则累计时长不增长
 *
 * 两者独立发起，互不阻塞：任一失败不影响另一个，也不影响播放。
 *
 * @param {object} song   歌曲对象
 * @param {number} sec    本次上报的播放时长（秒）
 * @param {number} total  歌曲总时长（秒）
 * @param {boolean} first 是否本次播放的**首次**上报。只有首次才发旧版
 *   `scrobble` —— 它的作用是「把这首歌写进最近播放」，一首歌发一次即可；
 *   后续补报只发 `scrobble_v1` 累计时长，避免重复写记录。
 */
async function reportToNetease(song, sec, total, first = false) {
  const jobs = [
    // NCBL 客户端日志上报：写「听歌时长」
    api('scrobble_v1', {
      id: song.id,
      sourceid: song.id,
      time: sec,
      total: Math.round(total) || undefined,
      name: song.name || '',
      artist: song.artist || '',
      source: 'list'
    })
  ]
  if (first) {
    // 旧版 weblog 上报：写「最近播放」（缺它歌曲记录会丢）
    jobs.push(
      api('scrobble', {
        id: song.id,
        sourceid: song.id,
        time: sec,
        source: 'list'
      })
    )
  }

  const results = await Promise.allSettled(jobs)
  // 全部失败才算失败（否则视为成功，避免重复上报）
  const ok = results.some((r) => r.status === 'fulfilled')
  if (!ok) {
    const msg = results.map((r) => r.reason?.message).filter(Boolean).join(' | ')
    throw new Error(msg || '上报失败')
  }
  return true
}

/**
 * 收尾上报：切歌/播完前把**尚未上报的尾部时长**补上。
 *
 * 为什么需要：补报是「每满 60 秒一次」，若一首歌听了 90 秒就切走，
 * 最后那 30 秒（60→90）会随 resetScrobble() 一起丢掉 —— 累计时长会
 * 系统性偏少。这里在切歌前主动补一次，保证不丢。
 *
 * 调用时机：`player.js` 的 startCurrent（切歌）与 ended（播完）里，
 * **在 resetScrobble() 之前**调用。
 *
 * @param {object} song 当前歌曲
 * @param {number} position 当前播放位置（秒）
 * @param {number} duration 总时长（秒）
 * @param {boolean} finished 是否「整曲播完」。播完时以 duration 为准上报，
 *   因为 listenedSec 按墙上时间累加，遇卡顿/暂停会略小于实际曲长，
 *   若照它上报会少几秒（例如 4:20 的歌报成 4:17）。
 * @returns {Promise<boolean>} 是否发起了补报
 */
export async function flushScrobble(song, position, duration, finished = false) {
  if (!song || song.fromLocal) return false
  if (!/^\d+$/.test(String(song.id ?? ''))) return false

  const total = duration || song.duration || 0
  /**
   * 上报时长：
   *   播完 → 取整曲时长（真实听完）
   *   切歌 → 取 min(累计播放, 当前播放位置)，不虚报未听到的部分
   */
  const played = finished && total > 0
    ? total
    : Math.max(0, Math.min(listenedSec, position || 0))

  // 已达过门槛、且尾部还有未上报的时长（≥5 秒，太短无意义）
  if (reportedForEpoch !== `${reportEpoch}:${song.id}`) return false
  if (played - reportedUpto < 5) return false

  const reportSec = Math.round(
    Math.min(played, total > 0 ? total : MAX_REPORT_SEC, MAX_REPORT_SEC)
  )
  if (reportSec <= reportedUpto) return false

  reportedUpto = reportSec
  try {
    // 补报只发 scrobble_v1（累计时长）；「最近播放」在首次上报时已写过，
    // 无需重复（重复发旧版接口只会重复往列表里塞记录）
    await reportToNetease(song, reportSec, total, false)
    return true
  } catch {
    // 静默失败：不阻塞切歌
    return false
  }
}

/**
 * 判断是否达到上报门槛并上报。
 *
 * ## 上报策略（修复「听歌时长几乎不增长」）
 *
 * 原实现：一次播放**只上报一次**，且报的是门槛刚过那一刻的 listenedSec
 *（约 30s）。听 5 分钟的歌也只报 30 秒 —— 网易云累计时长因此几乎不动。
 *
 * 现实现分两阶段：
 *   1. **首次上报**：有效播放 ≥30s 或过半时触发（对齐官方门槛）
 *   2. **后续补报**：之后每听满 60 秒再报一次，累计时长如实增长
 *
 * 上报的 `time` 取「已完整播放的时长」，而不是门槛瞬间值 ——
 * 参考实现（folltoshe/netease-report-listen-song）用的就是
 * `Math.floor(song.time / 2)`（歌长的一半），本实现更精确：
 * 用真实累计播放秒数，且随播放推进持续补报。
 *
 * @param {object} song    当前歌曲（需 id / name / artist / duration / source）
 * @param {number} position 当前播放位置（秒）
 * @param {number} duration 总时长（秒）
 * @returns {Promise<boolean>} 是否真正发起了上报
 */
export async function maybeScrobble(song, position, duration) {
  if (!song || song.fromLocal) return false
  // 只上报网易云曲目：QQ 源是 songmid（含字母），QQ 音乐有自己的记录体系
  if (!/^\d+$/.test(String(song.id ?? ''))) return false

  const total = duration || song.duration || 0
  /**
   * 可上报的时长：取「累计真实播放秒数」与「当前播放位置」的较小值。
   *
   * 为什么要 min：listenedSec 是墙上时间累加，seek 到后面时 position
   * 会跳变，而 listenedSec 不会 —— 取 min 保证不会报出超过实际播放量的值。
   */
  const played = Math.max(0, Math.min(listenedSec, position || 0))

  const key = `${reportEpoch}:${song.id}`

  // ---- 阶段 1：首次上报（需达门槛）----
  const isFirst = reportedForEpoch !== key
  if (isFirst) {
    const reachedMin = played >= MIN_PLAY_SEC
    const reachedHalf = total > 0 && played >= total * HALF_RATIO
    if (!reachedMin && !reachedHalf) return false
  } else {
    // ---- 阶段 2：后续补报（每满 REPEAT_INTERVAL_SEC 一次）----
    // 以「已上报到的时长」为基准，避免同一秒内被多次触发
    if (played - reportedUpto < REPEAT_INTERVAL_SEC) return false
  }

  // 上报值：整秒，且不超过单曲时长（防异常值）
  const reportSec = Math.round(
    Math.min(played, total > 0 ? total : MAX_REPORT_SEC, MAX_REPORT_SEC)
  )
  if (reportSec <= 0) return false

  reportedForEpoch = key
  reportedUpto = reportSec
  const epoch = reportEpoch
  try {
    // first=true 时额外调用旧版 scrobble 写「最近播放」
    await reportToNetease(song, reportSec, total, isFirst)
    return true
  } catch (e) {
    // 未登录（401）/服务未就绪：静默失败，不影响播放。
    // 允许下次 timeupdate 重试（回退已上报标记）
    if (epoch === reportEpoch) {
      reportedForEpoch = null
      reportedUpto = 0
    }
    return false
  }
}

export { tick }

/* ---------------- B 站 MV 观看上报 ---------------- */

/**
 * B 站 MV 上报状态（与歌曲上报分开维护）。
 *
 * 为什么分开：歌曲与 MV 可能同时存在（MV 播放时底部条接管，但歌曲状态
 * 仍在 store 里），共用一套计数会互相干扰。
 */
const biliReport = {
  /** 已上报的次数（用于判断是否达到首次上报门槛） */
  count: 0,
  /** 上次上报时的播放位置，避免重复上报同一位置 */
  lastPos: 0,
  /** 上次上报的时间戳（节流：至少间隔 20s） */
  lastAt: 0,
  /** 当前视频标识（bvid|cid），变化时重置 */
  key: '',
  /** 本次会话累计的有效播放秒数 */
  listened: 0,
  /** 上次 tick 的时间戳 */
  tickAt: 0,
  /** 是否已标记看完 */
  finished: false
}

/** MV 切换时重置上报状态 */
export function resetBiliReport() {
  biliReport.count = 0
  biliReport.lastPos = 0
  biliReport.lastAt = 0
  biliReport.key = ''
  biliReport.listened = 0
  biliReport.tickAt = 0
  biliReport.finished = false
}

/** MV 播放时长累加（暂停不计，与歌曲上报同一套逻辑） */
export function tickBili(playing) {
  const now = Date.now()
  if (!playing) {
    biliReport.tickAt = 0
    return
  }
  if (biliReport.tickAt) {
    const delta = (now - biliReport.tickAt) / 1000
    // 单次间隔 > 2s 视为卡顿/挂起，不计入
    if (delta > 0 && delta < 2) biliReport.listened += delta
  }
  biliReport.tickAt = now
}

/** 两次上报的最小间隔（秒）—— B 站网页播放器约 15s 一次，这里放宽到 20s */
const BILI_REPORT_INTERVAL = 20
/** 首次上报的门槛（秒），对齐网易云的 30s 规则 */
const BILI_FIRST_MIN = 30

/**
 * 按需上报 B 站观看进度。
 *
 * 上报策略（对齐 B 站网页播放器的行为，避免刷量）：
 *   - 首次：有效播放 ≥ 30s 或过半 才上报
 *   - 之后：每 ≥ 20s 上报一次（心跳），让历史记录里的进度持续更新
 *   - 播完：调用 reportFinished 标记看完（在 onEnded 里触发）
 *
 * @param {object} p
 *   - bvid, cid, aid
 *   - position: 当前播放位置（秒）
 *   - duration: 总时长（秒）
 *   - playing:  是否正在播放
 * @returns {Promise<boolean>} 是否发起了上报
 */
export async function maybeReportBili({ bvid, cid, aid, position, duration, playing }) {
  if (!bvid || !cid) return false
  const key = `${bvid}|${cid}`
  if (biliReport.key !== key) {
    // 换了视频：重置（保留 key 以便后续判断）
    resetBiliReport()
    biliReport.key = key
  }

  const pos = position || 0
  const total = duration || 0
  const now = Date.now()

  // 首次上报门槛
  if (biliReport.count === 0) {
    const reachedMin = biliReport.listened >= BILI_FIRST_MIN
    const reachedHalf = total > 0 && biliReport.listened >= total * HALF_RATIO
    if (!reachedMin && !reachedHalf) return false
  } else {
    // 后续心跳：距上次至少 20s，且位置确实前进了
    if (now - biliReport.lastAt < BILI_REPORT_INTERVAL * 1000) return false
    if (Math.abs(pos - biliReport.lastPos) < 5) return false
  }

  // 记录本次（先记录，避免并发重复）
  biliReport.count++
  biliReport.lastPos = pos
  biliReport.lastAt = now

  try {
    const r = await bili.reportProgress({
      aid,
      cid,
      bvid,
      playedTime: Math.round(pos),
      realtime: Math.round(biliReport.listened),
      duration: Math.round(total)
    })
    // 未登录（-101）：静默失败，不影响播放；回退计数以便登录后能重试
    if (!r?.ok && r?.code === -101) {
      biliReport.count = Math.max(0, biliReport.count - 1)
      biliReport.lastAt = 0
    }
    return !!r?.ok
  } catch {
    // 网络异常：回退，下次重试
    biliReport.count = Math.max(0, biliReport.count - 1)
    biliReport.lastAt = 0
    return false
  }
}

/** 视频播完：标记看完（B 站历史记录里进度打满） */
export async function reportBiliFinished({ bvid, cid, aid, duration }) {
  if (!bvid || !cid || biliReport.finished) return false
  biliReport.finished = true
  try {
    const r = await bili.reportFinished({
      aid,
      cid,
      bvid,
      duration: Math.round(duration || 0)
    })
    return !!r?.ok
  } catch {
    return false
  }
}
