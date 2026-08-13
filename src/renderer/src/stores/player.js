import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, coverUrl } from '../api'
import { useSettingsStore } from './settings'

let audioEl = null

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

  const current = computed(() => queue.value[currentIndex.value] || null)

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
    audioEl.addEventListener('playing', () => (buffering.value = false))
    audioEl.addEventListener('ended', () => next())
    audioEl.addEventListener('error', () => {
      playing.value = false
      buffering.value = false
    })
    audioEl.volume = volume.value
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

  /** 播放一组歌曲（替换队列） */
  async function playList(list, index = 0) {
    queue.value = list.map(normalizeSong)
    currentIndex.value = index
    await loadLyrics(queue.value[index])
    await playCurrent()
  }

  /** 将歌曲加入队列并播放 */
  async function playNext(song) {
    const n = normalizeSong(song)
    queue.value.push(n)
    currentIndex.value = queue.value.length - 1
    await loadLyrics(n)
    await playCurrent()
  }

  function enqueue(songs) {
    for (const s of songs) queue.value.push(normalizeSong(s))
  }

  async function playCurrent() {
    const song = current.value
    if (!song || !audioEl) return
    const settings = useSettingsStore()
    const q = settings.settings.quality
    if (song.fromLocal) {
      audioEl.src = audioUrl(song)
    } else {
      if (!song.audioUrl) {
        try {
          const res = await api('song_url_v1', { id: song.id, level: q === 'lossless' ? 'lossless' : q === '320000' ? 'exhigh' : 'standard' })
          const url = res.data?.[0]?.url
          if (!url) throw new Error('无可用播放地址（可能无版权，可开启全局解灰）')
          song.audioUrl = url
        } catch (e) {
          playing.value = false
          return e
        }
      }
      audioEl.src = audioUrl(song)
    }
    audioEl.volume = volume.value
    await audioEl.play().catch((e) => {
      console.error('play error', e)
      playing.value = false
    })
  }

  async function loadLyrics(song) {
    lyrics.value = []
    if (!song || song.fromLocal) return
    try {
      const res = await api('lyric', { id: song.id })
      const lrc = res.lrc?.lyric || ''
      const { parseLrc } = await import('../utils/lrc')
      lyrics.value = parseLrc(lrc)
    } catch {
      lyrics.value = []
    }
  }

  function toggle() {
    if (!audioEl || !current.value) return
    if (audioEl.paused) audioEl.play()
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

  async function next() {
    const settings = useSettingsStore()
    const mode = settings.settings.playMode
    const len = queue.value.length
    if (!len) return
    let idx
    if (mode === 'shuffle') idx = Math.floor(Math.random() * len)
    else idx = currentIndex.value + 1 >= len ? 0 : currentIndex.value + 1
    currentIndex.value = idx
    await loadLyrics(queue.value[idx])
    await playCurrent()
  }

  async function prev() {
    const len = queue.value.length
    if (!len) return
    if (currentTime.value > 3) {
      seek(0)
      return
    }
    currentIndex.value = currentIndex.value - 1 < 0 ? len - 1 : currentIndex.value - 1
    await loadLyrics(queue.value[currentIndex.value])
    await playCurrent()
  }

  async function removeFromQueue(idx) {
    queue.value.splice(idx, 1)
    if (idx < currentIndex.value) currentIndex.value--
    else if (idx === currentIndex.value) {
      if (queue.value.length) {
        currentIndex.value = Math.min(currentIndex.value, queue.value.length - 1)
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
    attachAudio,
    playList,
    playNext,
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
