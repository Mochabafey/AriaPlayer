import { api, bili } from '../api'

/**
 * 播放记录同步（双上报）。
 *
 * ## 网易云（听歌打卡）—— 两个接口都用
 *
 * 背景：本项目此前从未调用过 scrobble，所以用咏叹调听的歌在网易云
 * 客户端/网页的「最近播放」与「听歌足迹」里完全看不到——不是接口缺失，
 * 而是前端根本没上报。
 *
 * ### 两个接口的分工
 *
 * | 接口 | 作用 | 实现 |
 * |---|---|---|
 * | `scrobble`（weblog: startplay + play） | 写「播放记录」，语义明确 | 同步两次请求 |
 * | `scrobble_v1`（NCBL clientlog 上传 PLV/PLD） | 写「听歌时长」，贴近官方客户端 | 异步日志管道 |
 *
 * **两者都会写记录**（实测：只用 `scrobble_v1` 上报一首新歌，
 * 21 秒后「今日收听」与「播放记录」都能查到）。
 *
 * 都调的原因：`scrobble` 的语义更直白，`scrobble_v1` 的时长字段更完整。
 * 代价只是多一次请求。
 *
 * ### 上报语义：对齐官方「一次播放片段 = 一条日志」
 *
 * 官方客户端的模型（见参考实现 `src/mobile/modules/ua/pld.ts`）：
 *
 *     logtime: startTime + played * 1000     // 日志时间 = 播放开始 + 已播时长
 *     time: played                           // 本次片段实际播放时长
 *     realtime: played
 *
 * 即**每次播放（一个片段）只发一条 PLD**，`time` 是该次真实播放的秒数。
 * 用户确认的官方行为：
 *   - 听一半就切走 → 也计入（按实际播放时长）
 *   - 同一首歌反复听 → 每遍都累加
 *
 * 所以正确做法是「**每次播放结束时上报一条，time = 本次实际播放秒数**」，
 * 而不是「播放中周期性补报递增的累计值」——
 * 后者在累加模型下会把同一段时间重复计入（听 5 分钟报 30+90+150+210+270+300
 * = 1050 秒，虚增 3.5 倍）。
 *
 * ### 曾经的误判（记录以免重犯）
 *
 * 一度认为「`scrobble_v1` 不写播放记录」，依据是「连报 3 首只进去 1 首」。
 * 该证据**不成立**：`record/recent/song` 是**按歌去重**的列表，
 * 当时报的 3 首里有 2 首是重复的 Killer Queen，去重后自然只剩 1 条。
 *
 * 「刚听完查不到、过会儿又出现」也不是丢记录，而是**服务端 2 分钟缓存**
 * （见 src/main/ipc/api.js 的 FORCE_FETCH_RE，已把 listen_data 加入白名单）。
 *
 * ## B 站（观看历史）
 *
 * MV 播放同样从未上报，所以在 B 站 App/网页的「历史记录」里看不到。
 * 用 /x/click-interface/web/heartbeat 上报播放位置（见 biliClient.reportProgress）。
 *
 * ## 上报门槛
 *
 *   - 播放时长 ≥ 30s，或
 *   - 播放时长 ≥ 总时长的 50%（短歌/试听片段）
 *   满足其一即在该次播放结束时上报一条。
 */

/** 最短上报时长（秒），对齐网易云官方 30s 规则 */
const MIN_PLAY_SEC = 30
/** 或播放过半即上报 */
const HALF_RATIO = 0.5
/** 单次上报的时长上限（秒）：超过一首歌的长度没有意义，防止异常值 */
const MAX_REPORT_SEC = 3600
/**
 * 「确实听完了」的判定容差。
 *
 * `ended` 事件触发时，只有实际累计播放时长 ≥ 曲长 × 该比例，才认为真的听完，
 * 按整曲时长上报；否则按真实播放时长报。
 *
 * 取 0.9 的理由：
 *   - `listenedSec` 按墙上时间累加，遇卡顿/暂停会略小于曲长（少几秒），
 *     需要容差才不会把听完的歌少报
 *   - 又要挡住「只听一小段就 ended」的虚增（实测踩过：听 15 秒报 210 秒）
 */
const FINISH_TOLERANCE = 0.9

/** 本次播放是否已达上报门槛（达门槛后不再变化） */
let qualified = false
/** 已上报过的标识（`epoch:songId`），防止同一次播放重复上报 */
let reportedForEpoch = null
/** 当前这次播放的累计有效播放秒数（暂停不计） */
let listenedSec = 0
/** 上一次 timeupdate 的时间戳，用于累加真实播放时长（而非音频位置差） */
let lastTickAt = 0
/** 播放代次号：切歌后旧的上报请求作废 */
let reportEpoch = 0

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
  qualified = false
  reportedForEpoch = null
  listenedSec = 0
  lastTickAt = 0
}

/** 当前累计的有效播放秒数（供 MV 上报用） */
export function listenedSeconds() {
  return listenedSec
}

/**
 * 向网易云上报**一次播放片段**（双接口）。
 *
 * ## ⚠️ 两个接口都会计入听歌时长 —— 只让一个带 time（实测踩过）
 *
 * 服务端 `server/module/scrobble.js` 的 `play` 日志：
 *
 *     { action: 'play', json: { ..., time: query.time, ... } }
 *
 * 即旧版 `scrobble` 接口**也把 time 写进日志**。而 `scrobble_v1` 的 PLD
 * 同样带 time。若两边都传，服务端很可能**双重计入时长**。
 *
 * 实测症状：用户用秒表计时 10 分钟，网易云「听歌时长」涨了 36 分钟，
 * 而歌曲数只增加 3 首（约 10 分钟的量）—— 涨幅是实际的 3 倍以上。
 *
 * 现在改为：
 *   - `scrobble_v1`  → 带 time（**唯一**负责累计时长的接口）
 *   - `scrobble`     → **不带 time**（只负责把歌写进「最近播放」）
 *
 * `scrobble` 不传 time 时，服务端 `query.time` 为 undefined，
 * JSON.stringify 会把它丢掉，日志里就没有 time 字段。
 *
 * @param {object} song  歌曲对象
 * @param {number} sec   本次片段实际播放时长（秒）
 * @param {number} total 歌曲总时长（秒）
 */
async function reportToNetease(song, sec, total) {
  const results = await Promise.allSettled([
    // 唯一负责「听歌时长」的接口
    api('scrobble_v1', {
      id: song.id,
      sourceid: song.id,
      time: sec,
      total: Math.round(total) || undefined,
      name: song.name || '',
      artist: song.artist || '',
      source: 'list'
    }),
    // 只负责写「最近播放」，**不传 time**（避免与上面双重计入）
    api('scrobble', {
      id: song.id,
      sourceid: song.id,
      source: 'list'
    })
  ])
  const ok = results.some((r) => r.status === 'fulfilled')
  if (!ok) {
    const msg = results.map((r) => r.reason?.message).filter(Boolean).join(' | ')
    throw new Error(msg || '上报失败')
  }
  return true
}

/**
 * 记录本次播放的进度并判断是否达到上报门槛（**不发网络请求**）。
 *
 * 由 `player.js` 的 timeupdate 高频调用，所以这里只做纯计算 ——
 * 上报统一放在 `flushScrobble`（切歌/播完时）执行一次。
 *
 * 这样做的原因见文件头：官方是「一次播放发一条日志」，
 * 若在播放过程中周期性上报递增的累计值，累加模型下会重复计入。
 *
 * @param {object} song     当前歌曲
 * @param {number} position 当前播放位置（秒）
 * @param {number} duration 总时长（秒）
 * @returns {boolean} 当前是否已达上报门槛
 */
export function maybeScrobble(song, position, duration) {
  if (!song || song.fromLocal) return false
  // 只上报网易云曲目：QQ 源是 songmid（含字母），QQ 音乐有自己的记录体系
  if (!/^\d+$/.test(String(song.id ?? ''))) return false

  if (!qualified) {
    const total = duration || song.duration || 0
    // 可上报时长：min(累计真实播放, 当前播放位置)，避免 seek 后虚报
    const played = Math.max(0, Math.min(listenedSec, position || 0))
    const reachedMin = played >= MIN_PLAY_SEC
    const reachedHalf = total > 0 && played >= total * HALF_RATIO
    if (reachedMin || reachedHalf) qualified = true
  }
  return qualified
}

/**
 * 收尾上报：本次播放结束（切歌 / 播完）时上报**一条**记录。
 *
 * 调用时机：`player.js` 的 startCurrent（切歌）与 ended（播完）里，
 * **在 resetScrobble() 之前**调用。
 *
 * ## ⚠️ 播完时不能无条件报整曲时长（实测踩过）
 *
 * 原实现：`finished === true` 就直接取 `total`（整曲时长）。
 * 但 `ended` 事件**不一定意味着真的听完了** —— 流被截断、seek 到结尾、
 * 音频元数据时长有误，都会触发 `ended`。
 *
 * 实测：只听 15 秒就触发 ended → 上报 210 秒（**虚增 14 倍**）。
 *
 * 现在加**完整度校验**：只有实际播放时长达到曲长的 `FINISH_TOLERANCE`
 * 才按整曲上报，否则按真实播放时长报。
 *
 * 为什么保留「报整曲」这个分支：`listenedSec` 按墙上时间累加，
 * 遇卡顿/暂停会略小于曲长（例如 4:20 的歌累计 4:17），
 * 不加容差会把听完的歌少报几秒。容差取 90% 既能吸收这种误差，
 * 又能挡住「只听一小段就 ended」的虚增。
 *
 * @param {object} song 当前歌曲
 * @param {number} position 当前播放位置（秒）
 * @param {number} duration 总时长（秒）
 * @param {boolean} finished 是否由 `ended` 事件触发
 * @returns {Promise<boolean>} 是否发起了上报
 */
export async function flushScrobble(song, position, duration, finished = false) {
  if (!song || song.fromLocal) return false
  if (!/^\d+$/.test(String(song.id ?? ''))) return false

  const total = duration || song.duration || 0
  /** 实际累计播放时长（墙上时间，暂停/卡顿不计） */
  const actualPlayed = listenedSec

  /**
   * 上报时长：
   *   ended 且确实听满（≥90% 曲长）→ 取整曲时长（吸收卡顿导致的少算）
   *   其余情况 → 取 min(累计播放, 当前播放位置)，不虚报
   */
  const trulyFinished = finished && total > 0 && actualPlayed >= total * FINISH_TOLERANCE
  const played = trulyFinished
    ? total
    : Math.max(0, Math.min(actualPlayed, position || 0))

  // 未达门槛（听太短）→ 不上报。与官方「听一半也计入」一致：
  // 门槛只有 30s 或过半，正常收听都会满足。
  const reachedMin = played >= MIN_PLAY_SEC
  const reachedHalf = total > 0 && played >= total * HALF_RATIO
  if (!reachedMin && !reachedHalf) return false

  const reportSec = Math.round(
    Math.min(played, total > 0 ? total : MAX_REPORT_SEC, MAX_REPORT_SEC)
  )
  if (reportSec <= 0) return false

  // 防重复：同一次播放（同一 epoch）只上报一条
  const key = `${reportEpoch}:${song.id}`
  if (reportedForEpoch === key) return false
  reportedForEpoch = key

  try {
    await reportToNetease(song, reportSec, total)
    return true
  } catch {
    // 静默失败：不阻塞切歌。允许下次（同 epoch 内不会再有下次）重试
    if (reportedForEpoch === key) reportedForEpoch = null
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
