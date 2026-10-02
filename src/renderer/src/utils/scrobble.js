import { api } from '../api'

/**
 * 网易云播放记录同步（听歌打卡）。
 *
 * 背景：本项目此前从未调用过 scrobble，所以用咏叹调听的歌在网易云
 * 客户端/网页的「最近播放」与「听歌排行」里完全看不到——不是接口缺失，
 * 而是前端根本没上报。
 *
 * 用 scrobble/v1（仿桌面客户端的 NCBL 加密上报，见 server/util/ncbl.js），
 * 比旧的 scrobble 更接近官方客户端行为；需要登录态（MUSIC_U）。
 *
 * 上报时机（对齐网易云官方规则，避免刷量被风控）：
 *   - 播放时长 ≥ 30s，或
 *   - 播放时长 ≥ 歌曲总时长的 50%（短歌/试听片段）
 *   满足其一即上报一次；同一首歌在一次播放中只上报一次。
 */

/** 最短上报时长（秒），对齐网易云官方 30s 规则 */
const MIN_PLAY_SEC = 30
/** 或播放过半即上报 */
const HALF_RATIO = 0.5

/** 已上报过的歌曲 id（每次切歌清空），防重复上报 */
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
  reportedForEpoch = null
  listenedSec = 0
  lastTickAt = 0
}

/**
 * 判断是否达到上报门槛并上报。
 * @param {object} song    当前歌曲（需 id / name / artist / duration / source）
 * @param {number} position 当前播放位置（秒）
 * @param {number} duration 总时长（秒）
 * @returns {Promise<boolean>} 是否真正发起了上报
 */
export async function maybeScrobble(song, position, duration) {
  if (!song || song.fromLocal) return false
  // 只上报网易云曲目：QQ 源是 songmid（含字母），QQ 音乐有自己的记录体系
  if (!/^\d+$/.test(String(song.id ?? ''))) return false
  // 本次播放已上报过 → 跳过
  const key = `${reportEpoch}:${song.id}`
  if (reportedForEpoch === key) return false

  const played = Math.min(listenedSec, position || 0)
  const total = duration || song.duration || 0
  const reachedMin = played >= MIN_PLAY_SEC
  const reachedHalf = total > 0 && played >= total * HALF_RATIO
  if (!reachedMin && !reachedHalf) return false

  reportedForEpoch = key
  const epoch = reportEpoch
  try {
    await api('scrobble_v1', {
      id: song.id,
      sourceid: song.id,
      time: Math.round(played),
      total: Math.round(total) || undefined,
      name: song.name || '',
      artist: song.artist || '',
      source: 'list'
    })
    return true
  } catch (e) {
    // 未登录（401）/服务未就绪：静默失败，不影响播放。
    // 允许下次 timeupdate 重试（不占 reported 标记）
    if (epoch === reportEpoch) reportedForEpoch = null
    return false
  }
}

export { tick }
