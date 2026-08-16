import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, coverUrl } from '../api'
import { useSettingsStore } from './settings'

let audioEl = null
let playEpoch = 0      // 切歌代次号：旧请求的异步结果若晚于切歌则丢弃
let networkRetries = 0 // 断流轻量重试计数（成功 playing 后清零）

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
    })
    audioEl.addEventListener('loadedmetadata', () => {
      duration.value = audioEl.duration || 0
    })
    audioEl.addEventListener('play', () => (playing.value = true))
    audioEl.addEventListener('pause', () => (playing.value = false))
    audioEl.addEventListener('waiting', () => (buffering.value = true))
    audioEl.addEventListener('playing', () => {
      buffering.value = false
      networkRetries = 0
    })
    audioEl.addEventListener('ended', () => next(true))
    audioEl.addEventListener('error', () => {
      playing.value = false
      buffering.value = false
      const code = audioEl.error?.code
      // 4=音源格式不支持 / 3=解码错误 → ffmpeg 转码回退；
      // 2=网络错误 → 轻量重连续传（转码会把整首歌下完从头播，正是「卡住重播」的元凶）；
      // 1=aborted（切歌正常现象）忽略
      if (code === 4 || code === 3) fallbackTranscode()
      else if (code === 2) recoverNetwork()
    })
    audioEl.volume = volume.value
  }

  /** 网络断流恢复：重拉音源并跳回中断位置，最多重试 2 次 */
  function recoverNetwork() {
    const song = current.value
    if (!song || song.fromLocal || !song.audioUrl) return
    if (networkRetries >= 2) {
      setPlayError('网络不稳定，播放已中断，请稍后重试')
      return
    }
    networkRetries++
    const t = audioEl.currentTime || 0
    setPlayError('网络波动，正在恢复播放…')
    audioEl.src = audioUrl(song)
    if (t > 1) {
      const onReady = () => {
        audioEl.removeEventListener('loadedmetadata', onReady)
        if (audioEl.duration && t < audioEl.duration - 0.5) audioEl.currentTime = t
      }
      audioEl.addEventListener('loadedmetadata', onReady)
    }
    audioEl.play().catch(() => {})
  }

  /** 音频格式不支持时，用 ffmpeg 转码为 wav 再播（每首歌只尝试一次，防死循环） */
  async function fallbackTranscode() {
    const song = current.value
    if (!song || song.fromLocal || song._transcoding || song._transcodeTried || !song.audioUrl) return
    song._transcoding = true
    song._transcodeTried = true
    setPlayError('当前音频无法直接播放，正在转码…')
    try {
      const outPath = await window.ncm.invoke('ncm:ffmpeg-transcode', {
        url: song.audioUrl,
        format: 'wav'
      })
      if (outPath) {
        audioEl.src = `ncm-audio://local?path=${encodeURIComponent(outPath)}`
        await audioEl.play()
        setPlayError('')
      } else {
        setPlayError(`无法播放「${song.name || ''}」：没有可用音源（可能无版权）`)
      }
    } catch (e) {
      setPlayError(`无法播放「${song.name || ''}」：${e.message}`)
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
    if (audioEl) {
      try { audioEl.pause() } catch { /* noop */ }
      audioEl.removeAttribute('src')
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
          const res = await api('song_url_v1', { id: song.id, level: q === 'lossless' ? 'lossless' : q === '320000' ? 'exhigh' : 'standard' })
          // 等地址期间用户已切歌：丢弃本次结果，避免「界面是新歌、声音是旧歌」
          if (epoch !== playEpoch) return
          const url = res.data?.[0]?.url
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
    if (audioEl.paused) audioEl.play().catch(() => {})
    else audioEl.pause()
  }

  function seek(t) {
    if (audioEl && isFinite(t)) audioEl.currentTime = t
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
