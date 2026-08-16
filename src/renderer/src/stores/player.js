import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, coverUrl } from '../api'
import { useSettingsStore } from './settings'

let audioEl = null
let playEpoch = 0      // 切歌代次号：旧请求的异步结果若晚于切歌则丢弃
let networkRetries = 0 // 断流恢复计数（成功 playing / 切歌 / 手动重试后清零）
let recoverQueued = false // error 风暴合并窗口：风暴平息后统一恢复一次
let prefetching = false   // 下一曲音源预解析进行中标记
let lastSeekAt = 0        // 最近一次 seek 时刻：快速拖动期间推迟 error 恢复
let bufferDebounce = null // waiting→buffering 防抖计时器

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

  function attachAudio(el) {
    audioEl = el
    audioEl.addEventListener('timeupdate', () => {
      currentTime.value = audioEl.currentTime
      prefetchNext()
    })
    audioEl.addEventListener('loadedmetadata', () => {
      duration.value = audioEl.duration || 0
    })
    audioEl.addEventListener('play', () => (playing.value = true))
    audioEl.addEventListener('pause', () => {
      clearTimeout(bufferDebounce)
      bufferDebounce = null
      // 切歌流程会先拆 src 再 pause（见 startCurrent）：无 src 的 pause 是程序性
      // 停流而非用户暂停，保留乐观播放态，否则播放键会闪成暂停再弹回（抽搐来源）
      if (!audioEl.src) return
      playing.value = false
    })
    audioEl.addEventListener('waiting', () => {
      // 250ms 防抖：seek 引起的瞬时 waiting 不闪转圈（快速拖动时播放键
      // 在 播放/转圈 间高频闪烁的抽搐来源）；真卡顿 250ms 后才显示缓冲
      if (bufferDebounce) return
      bufferDebounce = setTimeout(() => {
        bufferDebounce = null
        buffering.value = true
      }, 250)
    })
    audioEl.addEventListener('playing', () => {
      clearTimeout(bufferDebounce)
      bufferDebounce = null
      buffering.value = false
      networkRetries = 0
    })
    audioEl.addEventListener('seeked', () => {
      // seek 已完成但数据就位（未触发 playing，如暂停状态下拖动）：同样不显示缓冲
      if (!audioEl.ended && audioEl.readyState >= 2) {
        clearTimeout(bufferDebounce)
        bufferDebounce = null
        buffering.value = false
      }
    })
    audioEl.addEventListener('ended', () => next(true))
    audioEl.addEventListener('error', () => {
      const code = audioEl.error?.code
      if (code === 1) return // aborted：切歌/快速 seek 拆流正常现象
      // 合并 error 风暴：800ms 内连续 error 只在平息后统一恢复一次。
      // 逐个响应会让 playing 高频震荡 → 播放键在 播放/暂停/转圈 间疯狂抽搐
      if (recoverQueued) return
      recoverQueued = true
      scheduleRecover()
    })
    audioEl.volume = volume.value
  }

  /** error 恢复调度：合并风暴 + 等用户停止快速拖动。
   *  拖动中途的错误多半是 seek 中间态（旧请求被拆/新请求在途），
   *  停手后大多自愈；此刻重置 src 恢复反而会把位置跳回旧处（可见抽搐） */
  function scheduleRecover() {
    const wait = Math.max(800, lastSeekAt + 1200 - Date.now())
    setTimeout(() => {
      if (Date.now() - lastSeekAt < 800) return scheduleRecover() // 还在拖，继续等
      recoverQueued = false
      if (!audioEl?.error) return
      if (!current.value || current.value.fromLocal) return
      recoverPlayback(audioEl.error.code)
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
  async function recoverPlayback(code) {
    const epoch = playEpoch
    const song = current.value
    if (!song || song.fromLocal || !audioEl) return
    const t = audioEl.currentTime || 0

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
    if (audioEl) {
      // 先拆 src 再 pause：pause 监听器据「无 src」识别这是切歌程序性停流，
      // 不会把乐观播放态闪回暂停（异步 pause 事件晚于同步赋值到达）
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

  function seek(t) {
    if (audioEl && isFinite(t)) {
      lastSeekAt = Date.now()
      audioEl.currentTime = t
    }
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
