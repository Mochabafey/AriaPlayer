import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, coverUrl } from '../api'
import { useSettingsStore } from './settings'

let audioEl = null     // audio 元素（PlayerBar 挂载，事件只认它）
let playEpoch = 0      // 切歌代次号：旧请求的异步结果若晚于切歌则丢弃
let networkRetries = 0 // 断流恢复计数（成功 playing / 切歌 / 手动重试后清零）
let recoverQueued = false // error 风暴合并窗口：风暴平息后统一恢复一次
let prefetching = false   // 下一曲音源预解析进行中标记
let lastSeekAt = 0        // 最近一次 seek 时刻：快速拖动期间推迟 error 恢复
let bufferDebounce = null // waiting→buffering 防抖计时器
let seekGuard = null      // seek 卡死看门狗：5s 未完成强制换源恢复，绝不无限卡死
let recovering = false    // recoverPlayback 互斥锁：error 调度与 seek() 直接调用并发触发时，
                          // 两个 recover 都会重置 src → 新请求互相取消 → 恢复死循环
let pendingRecoverAt = null // error 态 seek 的目标位置：调度器恢复时用它，而不是回退旧 currentTime
// 诊断日志开关：开发模式自动开；生产在控制台执行
// localStorage.setItem('ncm-debug','1') 后刷新可临时打开（排障用）
const DIAG =
  import.meta.env.DEV ||
  (typeof localStorage !== 'undefined' && localStorage.getItem('ncm-debug') === '1')

function levelOf(q) {
  return q === 'lossless' ? 'lossless' : q === '320000' ? 'exhigh' : 'standard'
}

/**
 * 全局播放器单例。audio 元素挂载在 PlayerBar，
 * 通过 audioUrl()（ncm-audio:// 协议）播放，绕开 CORS。
 */
export const usePlayerStore = defineStore('player', () => {
  const queue = ref([])
  const currentIndex = ref(-1)
  const playing = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(0.8)
  const lyrics = ref([])
  const showLyrics = ref(false)
  const buffering = ref(false)
  const playError = ref('')
  let errorTimer = null

  const current = computed(() => queue.value[currentIndex.value] || null)

  function setPlayError(msg) {
    playError.value = msg
    clearTimeout(errorTimer)
    errorTimer = setTimeout(() => (playError.value = ''), 6000)
  }

  /** 事件绑定：handler 只响应 audioEl 元素的事件 */
  function bindAudioEvents(el) {
    // 诊断时间线：audio 元素事件序列（协议层日志见 [audio-diag]，DIAG 开关门控）
    const evLog = (ev, e) => {
      if (!DIAG || e.target !== audioEl) return
      console.log(
        `[audio-ev] ${(performance.now() / 1000).toFixed(2)}s ${ev.padEnd(9)} rs=${el.readyState} net=${el.networkState} ct=${el.currentTime?.toFixed?.(2) ?? '-'}${el.error ? ' ERR=' + el.error.code : ''}`
      )
    }
    ;['loadstart', 'seeking', 'seeked', 'waiting', 'playing', 'canplay', 'stalled', 'suspend', 'emptied', 'error'].forEach((ev) =>
      el.addEventListener(ev, (e) => evLog(ev, e))
    )
    el.addEventListener('timeupdate', (e) => {
      if (e.target !== audioEl) return
      // seek 在途：保留乐观目标位置，不让旧位置的 timeupdate 把进度条拉回去
      if (el.seeking) return
      currentTime.value = el.currentTime
      prefetchNext()
    })
    el.addEventListener('loadedmetadata', (e) => {
      if (e.target !== audioEl) return
      duration.value = el.duration || 0
    })
    el.addEventListener('play', (e) => {
      if (e.target !== audioEl) return
      playing.value = true
    })
    el.addEventListener('pause', (e) => {
      if (e.target !== audioEl) return
      clearTimeout(bufferDebounce)
      bufferDebounce = null
      // 切歌流程会先拆 src 再 pause（见 startCurrent）：无 src 的 pause 是程序性
      // 停流而非用户暂停，保留乐观播放态，否则播放键会闪成暂停再弹回（抽搐来源）
      if (!el.src) return
      playing.value = false
    })
    el.addEventListener('waiting', (e) => {
      if (e.target !== audioEl) return
      // 250ms 防抖：seek 引起的瞬时 waiting 不闪转圈（快速拖动时播放键
      // 在 播放/转圈 间高频闪烁的抽搐来源）；真卡顿 250ms 后才显示缓冲
      if (bufferDebounce) return
      bufferDebounce = setTimeout(() => {
        bufferDebounce = null
        buffering.value = true
      }, 250)
    })
    el.addEventListener('playing', (e) => {
      if (e.target !== audioEl) return
      clearTimeout(bufferDebounce)
      bufferDebounce = null
      buffering.value = false
      networkRetries = 0
    })
    el.addEventListener('seeked', (e) => {
      if (e.target !== audioEl) return
      clearTimeout(seekGuard) // seek 已完成：撤看门狗
      seekGuard = null
      // seek 已完成但数据就位（未触发 playing，如暂停状态下拖动）：同样不显示缓冲
      if (!el.ended && el.readyState >= 2) {
        clearTimeout(bufferDebounce)
        bufferDebounce = null
        buffering.value = false
      }
    })
    el.addEventListener('canplay', (e) => {
      if (e.target !== audioEl) return
      // 暂停状态下拖动：数据就位即可收起缓冲（不会有 playing 事件来清）
      clearTimeout(bufferDebounce)
      bufferDebounce = null
      buffering.value = false
    })
    el.addEventListener('ended', (e) => {
      if (e.target !== audioEl) return
      next(true)
    })
    el.addEventListener('error', (e) => {
      if (e.target !== audioEl) return
      const code = el.error?.code
      if (code === 1) return // aborted：切歌/快速 seek 拆流正常现象
      // 合并 error 风暴：800ms 内连续 error 只在平息后统一恢复一次。
      // 逐个响应会让 playing 高频震荡 → 播放键在 播放/暂停/转圈 间疯狂抽搐
      if (recoverQueued) return
      recoverQueued = true
      scheduleRecover()
    })
  }

  function attachAudio(el) {
    audioEl = el
    bindAudioEvents(el)
    el.volume = volume.value
  }

  /** error 恢复调度：合并风暴 + 等用户停止快速拖动。
   *  拖动中途的错误多半是 seek 中间态（旧请求被拆/新请求在途），
   *  停手后大多自愈；此刻重置 src 恢复反而会把位置跳回旧处（可见抽搐）。
   *  总等待上限 3s：不能无限等——用户持续操作时一直拖就一直不恢复 = 卡死 */
  function scheduleRecover() {
    const deadline = Date.now() + 3000
    const wait = Math.max(800, lastSeekAt + 1200 - Date.now())
    setTimeout(() => {
      if (Date.now() - lastSeekAt < 800 && Date.now() < deadline) return scheduleRecover() // 还在拖，继续等（不超上限）
      recoverQueued = false
      if (!audioEl?.error) return
      if (!current.value || current.value.fromLocal) return
      // 用用户最后一次拖到的位置恢复（error 态 currentTime 是旧位置，丢了会跳回老地方）
      const at = pendingRecoverAt
      pendingRecoverAt = null
      recoverPlayback(audioEl.error.code, at ?? undefined)
    }, wait)
  }

  /** 恢复播放后跳回中断位置（epoch 保护：中途切歌则丢弃，防误 seek 到新歌） */
  function seekBack(t) {
    if (!(t > 1)) return
    const epoch = playEpoch
    const onMeta = () => {
      audioEl.removeEventListener('loadedmetadata', onMeta)
      if (epoch !== playEpoch) return
      if (audioEl.duration && t < audioEl.duration - 0.5) audioEl.currentTime = t
    }
    audioEl.addEventListener('loadedmetadata', onMeta)
  }

  /**
   * 播放失败统一恢复：优先刷新音源地址（解灰地址时效短，复用死地址只会
   * 立即再失败 → error 循环）。重试上限 2 次；到顶后解码类错误（3/4，
   * 很多 403/损坏流会被 Chromium 归到 4）走 ffmpeg 转码兜底，再不行明确报错。
   */
  async function recoverPlayback(code, targetAt) {
    // 互斥锁：error 事件调度与 seek() 直接调用可能并发进入（networkRetries < 2
    // 是同步检查，await api() 期间另一个 recover 也能通过），两个 recover 都会
    // 重置 src → 新加载互相取消 → 恢复死循环且恢复预算被快速耗尽。加锁串行化。
    if (recovering) return
    recovering = true
    try {
      const epoch = playEpoch
      const song = current.value
      if (!song || song.fromLocal || !audioEl) return
      clearTimeout(seekGuard) // 恢复流程接管，撤 seek 看门狗防误判
      seekGuard = null
      // error 状态下 seek 传入目标位置；否则回到中断位置
      const t = targetAt ?? (audioEl.currentTime || 0)
      if (DIAG) {
        console.log(
          `[audio-ev] recoverPlayback code=${code} at=${t.toFixed(2)} retries=${networkRetries} src=${(audioEl.src || '').slice(0, 60)} err=${audioEl.error?.code}`
        )
      }

      if (networkRetries < 2) {
        networkRetries++
        buffering.value = true
        setPlayError('播放异常，正在恢复…')
        try {
          // 跳过缓存拿最新音源：第三方解灰地址几分钟就失效，旧地址复活不了。
          // 第二次重试降级标准音质：换一条不同的 CDN 文件路径，绕开坏地址
          const settings = useSettingsStore()
          const level = networkRetries >= 2 ? 'standard' : levelOf(settings.settings.quality)
          const res = await api('song_url_v1', { id: song.id, level }, { noCache: true })
          if (epoch !== playEpoch) return
          const fresh = res.data?.[0]?.url
          if (fresh) song.audioUrl = fresh
        } catch { /* 拿不到新地址就用旧地址再连一次 */ }
        if (epoch !== playEpoch) return
        audioEl.src = audioUrl(song)
        seekBack(t)
        audioEl.play().catch(() => {})
        return
      }

      if ((code === 3 || code === 4) && !song._transcodeTried) return fallbackTranscode()

      playing.value = false
      buffering.value = false
      setPlayError('当前音源不稳定，播放已中断，可稍后重试或切换其他歌曲')
    } finally {
      recovering = false
    }
  }

  /** 音频格式不支持时，用 ffmpeg 转码为 wav 再播（每首歌只尝试一次，防死循环） */
  async function fallbackTranscode() {
    const song = current.value
    if (!song || song.fromLocal || song._transcoding || song._transcodeTried || !song.audioUrl) return
    const epoch = playEpoch
    song._transcoding = true
    song._transcodeTried = true
    buffering.value = true
    setPlayError('当前音频无法直接播放，正在转码…')
    try {
      const outPath = await window.ncm.invoke('ncm:ffmpeg-transcode', {
        url: song.audioUrl,
        format: 'wav'
      })
      if (epoch !== playEpoch) return
      if (outPath) {
        audioEl.src = `ncm-audio://local?path=${encodeURIComponent(outPath)}`
        await audioEl.play()
        setPlayError('')
      } else {
        playing.value = false
        buffering.value = false
        setPlayError(`无法播放「${song.name || ''}」：没有可用音源（可能无版权）`)
      }
    } catch (e) {
      if (epoch === playEpoch) {
        playing.value = false
        buffering.value = false
        setPlayError(`无法播放「${song.name || ''}」：${e.message}`)
      }
    } finally {
      song._transcoding = false
    }
  }

  function audioUrl(song) {
    if (song.fromLocal && song.localPath) {
      return `ncm-audio://local?path=${encodeURIComponent(song.localPath)}`
    }
    const raw = song?.audioUrl || song?.url
    if (!raw) return ''
    return `ncm-audio://stream?url=${encodeURIComponent(raw)}`
  }

  function normalizeSong(song) {
    const ar = (song.ar || song.artists || []).map((a) => (typeof a === 'string' ? a : a.name)).join('/')
    return {
      id: song.id,
      name: song.name || song.title || '未知歌曲',
      artist: ar || song.artist || '未知歌手',
      album: (song.al && song.al.name) || song.album || '',
      pic: (song.al && song.al.picUrl) || song.pic || coverUrl(song.picId),
      duration: song.dt ? Math.round(song.dt / 1000) : song.duration || 0,
      audioUrl: song.url || null,
      fromLocal: song.fromLocal || false,
      localPath: song.filePath || null
    }
  }

  /** 播放一组歌曲（替换队列）。歌词并行加载，不阻塞起播 */
  function playList(list, index = 0) {
    queue.value = list.map(normalizeSong)
    currentIndex.value = index
    startCurrent(queue.value[index])
    return playCurrent()
  }

  /** 将歌曲加入队列并播放 */
  function playNext(song) {
    const n = normalizeSong(song)
    queue.value.push(n)
    currentIndex.value = queue.value.length - 1
    startCurrent(n)
    return playCurrent()
  }

  function enqueue(songs) {
    for (const s of songs) queue.value.push(normalizeSong(s))
  }

  /**
   * 切歌的公共入口：先拆掉旧音频流（停声 + 断开协议层上游连接，
   * 新旧流不再抢带宽，切歌跟手），乐观置播放态，歌词并行加载。
   */
  function startCurrent(song) {
    playEpoch++
    networkRetries = 0
    pendingRecoverAt = null
    clearTimeout(seekGuard) // 切歌重置：旧 seek 的看门狗不再有效
    seekGuard = null
    // 先拆 src 再 pause：pause 监听器据「无 src」识别这是切歌程序性停流，
    // 不会把乐观播放态闪回暂停（异步 pause 事件晚于同步赋值到达）
    if (audioEl) {
      audioEl.removeAttribute('src')
      try { audioEl.pause() } catch { /* noop */ }
      try { audioEl.load() } catch { /* noop */ }
    }
    currentTime.value = 0
    duration.value = 0
    playing.value = true
    buffering.value = true
    loadLyrics(song)
  }

  async function playCurrent() {
    const epoch = playEpoch
    const song = current.value
    if (!song || !audioEl) return
    const settings = useSettingsStore()
    const q = settings.settings.quality
    if (song.fromLocal) {
      if (epoch !== playEpoch) return
      audioEl.src = audioUrl(song)
    } else {
      if (!song.audioUrl) {
        try {
          const level = levelOf(q)
          const res = await api('song_url_v1', { id: song.id, level })
          // 等地址期间用户已切歌：丢弃本次结果，避免「界面是新歌、声音是旧歌」
          if (epoch !== playEpoch) return
          let url = res.data?.[0]?.url
          // 无损/极高无权限时常返回空 url：降级标准音质再试一次
          if (!url && level !== 'standard') {
            const std = await api('song_url_v1', { id: song.id, level: 'standard' })
            if (epoch !== playEpoch) return
            url = std.data?.[0]?.url
          }
          if (!url) throw new Error('无可用播放地址（可能无版权，已尝试解灰失败）')
          song.audioUrl = url
        } catch (e) {
          if (epoch !== playEpoch) return
          playing.value = false
          buffering.value = false
          setPlayError(`无法播放「${song.name || ''}」：${e.message}`)
          return e
        }
      }
      if (epoch !== playEpoch) return
      audioEl.src = audioUrl(song)
    }
    audioEl.volume = volume.value
    await audioEl.play().catch((e) => {
      console.error('play error', e)
      // AbortError：src 被新的切歌请求替换所致，属正常现象，交给新请求接管
      if (epoch !== playEpoch || e?.name === 'AbortError') return
      playing.value = false
      buffering.value = false
      setPlayError(`播放失败：${e.message || '未知错误'}`)
    })
  }

  /** 冗余预热：当前曲临近结束（剩 30s 内）预解析下一曲音源地址。
   *  切歌时 playCurrent 直接命中已备好的 URL，免去 1-2s 接口往返，
   *  连播不再在两首之间卡一下 */
  function prefetchNext() {
    if (prefetching || !audioEl || !audioEl.duration) return
    const remain = audioEl.duration - audioEl.currentTime
    if (remain > 30) return
    const settings = useSettingsStore()
    if (settings.settings.playMode === 'loop') return // 单曲循环不会切歌
    const len = queue.value.length
    if (!len) return
    const ni = currentIndex.value + 1 >= len ? 0 : currentIndex.value + 1
    const nxt = queue.value[ni]
    if (!nxt || nxt.fromLocal || nxt.audioUrl) return
    prefetching = true
    api('song_url_v1', { id: nxt.id, level: levelOf(settings.settings.quality) })
      .then((res) => {
        const url = res.data?.[0]?.url
        if (url) nxt.audioUrl = url
      })
      .catch(() => {})
      .finally(() => { prefetching = false })
  }

  async function loadLyrics(song) {
    const epoch = playEpoch
    lyrics.value = []
    if (!song || song.fromLocal) return
    try {
      const res = await api('lyric', { id: song.id })
      if (epoch !== playEpoch) return
      const lrc = res.lrc?.lyric || ''
      const { parseLrc } = await import('../utils/lrc')
      if (epoch !== playEpoch) return
      lyrics.value = parseLrc(lrc, res.tlyric?.lyric || '')
    } catch {
      if (epoch === playEpoch) lyrics.value = []
    }
  }

  function toggle() {
    if (!audioEl || !current.value) return
    if (audioEl.paused) {
      networkRetries = 0 // 手动点击视为重试：重给恢复预算
      audioEl.play().catch(() => {})
    } else audioEl.pause()
  }

  /** seek 卡死看门狗：demuxer 卡住时不触发 error 事件（数据充足却挂死，
   *  表现为 readyState=4 / NETWORK_IDLE 的静默卡死）。5s 仍未 seek 完成或
   *  播放头没到目标位置，强制换源恢复——宁可闪一下也不能无限卡死 */
  function armSeekGuard(t) {
    clearTimeout(seekGuard)
    const epoch = playEpoch
    seekGuard = setTimeout(() => {
      if (epoch !== playEpoch || !audioEl || !current.value) return
      const stuck = audioEl.seeking || Math.abs((audioEl.currentTime || 0) - t) > 1
      if (stuck && !audioEl.ended) {
        if (DIAG) console.log(`[audio-ev] seek guard fired: target=${t.toFixed(2)} cur=${audioEl.currentTime?.toFixed?.(2) ?? '-'} seeking=${audioEl.seeking}`)
        recoverPlayback(audioEl.error?.code || 2, t)
      }
    }, 5000)
  }

  function seek(t) {
    if (!audioEl || !isFinite(t)) return
    if (DIAG) console.log(`[audio-ev] seek(${t.toFixed(2)}) err=${audioEl.error ? 'Y' : 'N'} src=${(audioEl.src || '').slice(0, 60)}`)
    lastSeekAt = Date.now()
    networkRetries = 0 // 手动 seek 视为用户重试：恢复预算重置，别直接跳到报错
    // 乐观收起缓冲指示：真缺数据 waiting 会在 250ms 后重新显示
    clearTimeout(bufferDebounce)
    bufferDebounce = null
    buffering.value = false

    const dur = duration.value || audioEl.duration
    if (isFinite(dur) && dur > 0) t = Math.max(0, Math.min(t, dur - 0.05))

    // 元素已处 error 状态：设 currentTime 无效（规范要求必须 load 重置），
    // 用户此刻的拖动就是「给我恢复到这」——立即刷新音源从目标位置重播。
    // 但恢复已在 error 调度链（recoverQueued）或进行中（recovering）时只更新
    // 目标位置，避免并发 recover 互相重置 src 导致死循环
    if (audioEl.error) {
      currentTime.value = t
      lastSeekAt = Date.now()
      pendingRecoverAt = t
      if (!recoverQueued && !recovering) recoverPlayback(audioEl.error.code, t)
      return
    }

    // 单元素直接 seek：协议层对 Range 一律回 206（seek 数据按需区间拉取），
    // 乐观更新进度条，timeupdate 在 seeking 期间不回写旧位置
    audioEl.currentTime = t
    currentTime.value = t
    armSeekGuard(t)
  }

  function setVolume(v) {
    volume.value = v
    if (audioEl) audioEl.volume = v
    const settings = useSettingsStore()
    settings.set('volume', v)
  }

  /**
   * 切歌。auto=true 表示由「播放结束」触发：
   * 单曲循环模式下重播当前曲；手动点击下一首始终切歌。
   */
  async function next(auto = false) {
    const settings = useSettingsStore()
    const mode = settings.settings.playMode
    const len = queue.value.length
    if (!len) return
    if (auto && mode === 'loop') {
      seek(0)
      audioEl?.play().catch(() => {})
      return
    }
    let idx
    if (mode === 'shuffle') idx = Math.floor(Math.random() * len)
    else idx = currentIndex.value + 1 >= len ? 0 : currentIndex.value + 1
    currentIndex.value = idx
    startCurrent(queue.value[idx])
    await playCurrent()
  }

  /** 跳到队列中指定下标播放（播放列表点击切歌） */
  function playAt(index) {
    if (index < 0 || index >= queue.value.length) return
    currentIndex.value = index
    startCurrent(queue.value[index])
    return playCurrent()
  }

  async function prev() {
    const len = queue.value.length
    if (!len) return
    if (currentTime.value > 3) {
      seek(0)
      return
    }
    currentIndex.value = currentIndex.value - 1 < 0 ? len - 1 : currentIndex.value - 1
    startCurrent(queue.value[currentIndex.value])
    await playCurrent()
  }

  async function removeFromQueue(idx) {
    queue.value.splice(idx, 1)
    if (idx < currentIndex.value) currentIndex.value--
    else if (idx === currentIndex.value) {
      if (queue.value.length) {
        currentIndex.value = Math.min(currentIndex.value, queue.value.length - 1)
        startCurrent(queue.value[currentIndex.value])
        await playCurrent()
      } else {
        currentIndex.value = -1
        playing.value = false
        if (audioEl) audioEl.pause()
      }
    }
  }

  function clearQueue() {
    queue.value = []
    currentIndex.value = -1
    playing.value = false
    if (audioEl) audioEl.pause()
  }

  return {
    queue,
    currentIndex,
    current,
    playing,
    currentTime,
    duration,
    volume,
    lyrics,
    showLyrics,
    buffering,
    playError,
    attachAudio,
    playList,
    playNext,
    playAt,
    enqueue,
    toggle,
    seek,
    setVolume,
    next,
    prev,
    removeFromQueue,
    clearQueue
  }
})
