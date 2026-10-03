<script setup>
/**
 * BiliPlayer.vue — B 站风格播放器
 *
 * 参照 B 站网页播放器的交互：
 *   - 底部控制条：播放/暂停、下一集、进度条（含缓冲进度 + 悬停预览时间）、时间、音量、倍速、画质、网页全屏、全屏
 *   - 进度条有三层：已播放（蓝）、缓冲（半透明）、悬停位置（白点 + 时间气泡）
 *   - 控制条自动隐藏（鼠标静止 3s）
 *   - 快捷键：空格播放/暂停、←/→ 快退快进 5s、↑/↓ 音量、F 全屏、M 静音
 *
 * 播放源解析由父组件负责（拿到可播地址后传 url 进来），
 * 本组件只负责播放与交互。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Hls from 'hls.js'
import { usePlayerStore } from '../stores/player'
import { parseLrc, activeIndex } from '../utils/lrc'
import { bili } from '../api'
import BiliSubtitle from './BiliSubtitle.vue'

const props = defineProps({
  /** 可播地址（ncm-audio:// 或本地 file） */
  url: { type: String, default: '' },
  /** 标题（显示在顶部悬浮） */
  title: { type: String, default: '' },
  /** 作者 */
  author: { type: String, default: '' },
  /** 封面（未播放时显示） */
  poster: { type: String, default: '' },
  /** 可用画质列表 [{ id, name }] */
  qualities: { type: Array, default: () => [] },
  /** 当前画质 id */
  quality: { type: [Number, String], default: 0 },
  /** 合流中：显示进度而不是播放器 */
  merging: { type: Boolean, default: false },
  /** 合流进度 0-100 */
  mergePercent: { type: Number, default: 0 },
  /** 合流状态文本 */
  mergeText: { type: String, default: '' },
  /** 自动播放 */
  autoplay: { type: Boolean, default: true },
  /** B 站视频标识（用于自动匹配歌词；为空则不启用字幕） */
  bvid: { type: String, default: '' },
  /** 分P id（拉字幕需要） */
  cid: { type: [String, Number], default: '' }
})

const emit = defineEmits(['quality-change', 'ended', 'error'])

const player = usePlayerStore()
const videoRef = ref(null)
const wrapRef = ref(null)

const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const buffered = ref(0)
// 音量不再本地维护：统一读写 player store（见下方 volume/muted 计算属性）
const rate = ref(1)
/** 控制条可见性（鼠标静止后隐藏） */
const controlsVisible = ref(true)
const isFullscreen = ref(false)
const isWebFullscreen = ref(false)
/** 悬停进度条：比例 -1 表示未悬停 */
const hoverRatio = ref(-1)
const dragging = ref(false)
const dragRatio = ref(0)
/** 画质菜单 */
const qualityOpen = ref(false)
/** 倍速菜单 */
const rateOpen = ref(false)
const errorMsg = ref('')

/* ---------------- 三行字幕（叠在视频上） ----------------
 * 歌词来源优先级：
 *   1. B 站自带字幕（CC）—— 与视频天然同步，最准
 *   2. 按视频标题自动匹配网易云歌词 —— 覆盖绝大多数音乐 MV
 *   3. 手动搜索（用户改关键词）—— 前两者都失败/匹配错时的兜底
 * 只在 B 站页启用（有 bvid 时），不影响歌曲播放页的 LyricPanel。
 */
const subLines = ref([])
const subLabel = ref('')
const subLoading = ref(false)
/** 字幕搜索面板展开态 */
const subSearchOpen = ref(false)
const subKeyword = ref('')
const subResults = ref([])
const subSearching = ref(false)

/** 当前行索引（复用歌曲歌词页的算法，保证滚动时机一致） */
const subActive = computed(() => activeIndex(subLines.value, currentTime.value))

/**
 * 加载字幕。
 *
 * 两个来源**并行**取，择优使用：
 *   - B 站自带字幕（CC）：与视频天然同步，但很多视频没有；即使有，
 *     也可能只是部分翻译（实测某 MV 只有 56 句英文，而完整歌词有 100+ 句）
 *   - 网易云歌词：按视频标题自动匹配，覆盖绝大多数音乐 MV，通常最完整
 * 择优规则：两边都有时取**行数更多**的那个（更完整）；
 *          只有一边有就用它。手动搜索始终可覆盖。
 */
async function loadSubtitle() {
  if (!props.bvid) return
  subLines.value = []
  subLabel.value = ''
  subLoading.value = true
  try {
    // 并行请求两个来源（互不依赖，串行会白等）
    const [biliRes, autoRes] = await Promise.all([
      props.cid ? bili.subtitle(props.bvid, props.cid).catch(() => null) : Promise.resolve(null),
      bili.autoLyric(props.title).catch(() => null)
    ])

    // B 站自带字幕 → 统一结构
    const ccLines = (biliRes?.list || []).map((x) => ({ time: x.from, text: x.text }))

    // 网易云歌词 → 统一结构
    let ncmLines = []
    let ncmLabel = ''
    let ncmKeyword = ''
    if (autoRes?.ok) {
      ncmLines = parseLrc(autoRes.lyrics, autoRes.tlyric)
      const m = autoRes.matched
      // 置信度低时明确提示，用户可点搜索框改
      const conf =
        autoRes.confidence >= 2 ? '' : autoRes.confidence === 1 ? '（匹配度一般）' : '（匹配度低，建议手动搜）'
      ncmLabel = `网易云 · ${m?.name || ''}${m?.artist ? ' - ' + m.artist : ''}${conf}`
    }
    ncmKeyword = autoRes?.keyword || ''

    // 择优：行数多的更完整
    if (ncmLines.length >= ccLines.length && ncmLines.length > 0) {
      subLines.value = ncmLines
      subLabel.value = ncmLabel
    } else if (ccLines.length > 0) {
      subLines.value = ccLines
      subLabel.value = `B站字幕 · ${ccLines.length} 句`
    } else {
      subLabel.value = '未找到匹配歌词，可点此搜索'
    }
    // 预填关键词，方便用户直接改
    subKeyword.value = ncmKeyword || props.title || ''
  } catch {
    subLabel.value = ''
  } finally {
    subLoading.value = false
  }
}

/** 打开字幕搜索面板（并预填当前标题作为关键词） */
function openSubSearch() {
  subSearchOpen.value = true
  if (!subKeyword.value) subKeyword.value = props.title || ''
  if (subKeyword.value && !subResults.value.length) doSubSearch()
}

/** 搜网易云歌曲 */
async function doSubSearch() {
  const kw = subKeyword.value.trim()
  if (!kw || subSearching.value) return
  subSearching.value = true
  try {
    const r = await bili.searchSong(kw, 12)
    subResults.value = r.list || []
  } catch {
    subResults.value = []
  } finally {
    subSearching.value = false
  }
}

/** 选定某首歌的歌词作为字幕 */
async function pickSubtitle(song) {
  subSearching.value = true
  try {
    const r = await bili.songLyric(song.id)
    if (r?.ok) {
      subLines.value = parseLrc(r.lyrics, r.tlyric)
      subLabel.value = `网易云 · ${song.name}${song.artist ? ' - ' + song.artist : ''}`
      subSearchOpen.value = false
    } else {
      errorMsg.value = '这首歌没有歌词'
      setTimeout(() => { errorMsg.value = '' }, 2500)
    }
  } finally {
    subSearching.value = false
  }
}

/** 关闭字幕（用户不想看时） */
function clearSubtitle() {
  subLines.value = []
  subLabel.value = ''
}

const RATES = [2, 1.5, 1.25, 1, 0.75, 0.5]

/** 进度条显示比例：拖拽时用拖拽值，否则用播放位置 */
const progressPct = computed(() => {
  if (dragging.value) return dragRatio.value * 100
  if (!duration.value) return 0
  return (currentTime.value / duration.value) * 100
})
const bufferedPct = computed(() => (duration.value ? (buffered.value / duration.value) * 100 : 0))

const currentLabel = computed(() => fmt(currentTime.value))
const durationLabel = computed(() => fmt(duration.value))
/** 悬停位置的时间标签（B 站会在进度条上方显示） */
const hoverLabel = computed(() => (hoverRatio.value >= 0 && duration.value ? fmt(hoverRatio.value * duration.value) : ''))
const currentQualityName = computed(() => {
  const q = props.qualities.find((x) => x.id === props.quality)
  return q ? q.name : '画质'
})

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const p = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

/* ---------------- 播放控制 ---------------- */

function togglePlay() {
  const v = videoRef.value
  if (!v) return
  if (v.paused) v.play().catch(() => {})
  else v.pause()
}

function onVideoEvent() {
  const v = videoRef.value
  if (!v) return
  playing.value = !v.paused
  currentTime.value = v.currentTime
  duration.value = v.duration || 0
  if (v.buffered.length) {
    // 取包含当前播放位置的那段缓冲的末端
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
        buffered.value = v.buffered.end(i)
        break
      }
    }
  }
  // 同步给底部播放条（接管模式下它显示视频的进度与状态）
  player.updateVideoSession({
    currentTime: currentTime.value,
    duration: duration.value,
    paused: v.paused,
    buffered: buffered.value
  })
}

/**
 * 音量统一由 player store 掌管（底部播放条是唯一来源）。
 *
 * 原实现 BiliPlayer 自己维护一份 volume/muted ref，只作用于 video 元素，
 * 与底部条的音量完全脱节 —— 两处各调各的，用户看到两个不一致的值。
 * 现在统一读写 player.volume / player.muted：
 *   - 视频页调音量 → 写 store → store 的 videoVolumeSink 把它作用到 video
 *   - 底部条调音量 → 同样写 store → 视频同步跟随
 * 这样任意一处调整，另一处立即反映。
 *
 * 注意：player.volume 是**滑块位置**（0..1），不是振幅。
 * store 内部经 utils/volume.js 的 ampOf() 换算后才设置到媒体元素。
 */
const volume = computed(() => player.volume)
const muted = computed(() => player.muted)

function setVolume(val) {
  // 直接写 store；store 会同步到 audio 与 video 元素并持久化
  player.setVolume(Math.min(1, Math.max(0, val)))
}

function toggleMute() {
  player.toggleMute()
}

function setRate(r) {
  rate.value = r
  rateOpen.value = false
  if (videoRef.value) videoRef.value.playbackRate = r
}

/* ---------------- 进度条 ---------------- */

function ratioFromEvent(e) {
  const el = progressRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

const progressRef = ref(null)

function onProgressDown(e) {
  if (!duration.value) return
  dragging.value = true
  dragRatio.value = ratioFromEvent(e)
  window.addEventListener('pointermove', onProgressMove)
  window.addEventListener('pointerup', onProgressUp)
}

function onProgressMove(e) {
  if (!dragging.value) return
  dragRatio.value = ratioFromEvent(e)
}

function onProgressUp() {
  window.removeEventListener('pointermove', onProgressMove)
  window.removeEventListener('pointerup', onProgressUp)
  if (dragging.value && videoRef.value && duration.value) {
    videoRef.value.currentTime = dragRatio.value * duration.value
  }
  dragging.value = false
}

function onProgressHover(e) {
  hoverRatio.value = ratioFromEvent(e)
}

/* ---------------- 全屏 ---------------- */

async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  try {
    if (!document.fullscreenElement) {
      await el.requestFullscreen()
      isFullscreen.value = true
    } else {
      await document.exitFullscreen()
      isFullscreen.value = false
    }
  } catch { /* 用户拒绝或环境不支持 */ }
}

/** 网页全屏：只铺满应用内容区（不进入系统全屏） */
function toggleWebFullscreen() {
  isWebFullscreen.value = !isWebFullscreen.value
}

function onFsChange() {
  isFullscreen.value = !!document.fullscreenElement
}

/* ---------------- 控制条自动隐藏 ---------------- */

let hideTimer = null
function poke() {
  controlsVisible.value = true
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    // 播放中且没在拖拽/开菜单才隐藏
    if (playing.value && !dragging.value && !qualityOpen.value && !rateOpen.value) {
      controlsVisible.value = false
    }
  }, 3000)
}

/* ---------------- 键盘快捷键 ----------------
 * 只处理「视频独有」的键：F 全屏、M 静音。
 *
 * 空格/←→/↑↓ 交给 App.vue 的全局处理器统一负责 —— 它会在视频接管时
 * 转发给 video 元素（见 videoSession）。若这里也监听，两个 handler 会
 * 对同一次按键各响应一次（空格 toggle 两次 = 视频暂停又立刻播放，
 * 表现为「按了没反应」；同时后台音乐被 App 的旧逻辑唤起 = 两路声音打架）。
 */
function onKeydown(e) {
  const t = e.target
  if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return
  const v = videoRef.value
  if (!v) return
  switch (e.code) {
    case 'KeyF':
      e.preventDefault(); toggleFullscreen(); break
    case 'KeyM':
      e.preventDefault(); toggleMute(); break
  }
  poke()
}

/* ---------------- 外部点击关闭菜单 ---------------- */

function onDocClick(e) {
  if (qualityOpen.value && !e.target?.closest?.('.bp-quality')) qualityOpen.value = false
  if (rateOpen.value && !e.target?.closest?.('.bp-rate')) rateOpen.value = false
}

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onKeydown)
  poke()
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointermove', onProgressMove)
  window.removeEventListener('pointerup', onProgressUp)
  clearTimeout(hideTimer)
  // 销毁 HLS 实例：否则它会继续轮询播放列表（ffmpeg 已停，白耗资源）
  destroyHls()
  // 释放底部条接管，否则离开视频页后底部条仍显示视频信息却无法控制
  player.releaseVideo()
})

/**
 * HLS 实例（B 站实时合流产出的是 m3u8 + m4s 分片，<video> 不能直接播）。
 * 用 hls.js 播放本地 m3u8：它会不断重读播放列表，ffmpeg 每产出一个新分片
 * 就能被加载 —— 于是「首片生成即可开播」，无需等整片合流完成。
 */
let hls = null

/** 销毁 HLS 实例（切换源/卸载时调用，避免残留轮询与连接） */
function destroyHls() {
  if (hls) {
    try { hls.destroy() } catch { /* ignore */ }
    hls = null
  }
}

/**
 * 挂载播放源。
 * - m3u8（实时合流）→ hls.js
 * - 其他（durl mp4 / 合流后的本地 mp4）→ 直接给 video.src
 */
function attachSource(v, src) {
  destroyHls()
  const isHls = /\.m3u8(\?|$)/i.test(src) || src.includes('index.m3u8')
  if (isHls) {
    if (Hls.isSupported()) {
      hls = new Hls({
        // 本地文件由 ncm-audio:// 协议提供，无需防盗链头
        // 实时合流期间列表在增长：缩短轮询间隔让新分片更快被发现
        liveSyncDurationCount: 1,
        manifestLoadingMaxRetry: 10,
        levelLoadingMaxRetry: 10,
        fragLoadingMaxRetry: 10,
        // 列表里暂时没有分片时不报错，继续等（ffmpeg 正在生成）
        manifestLoadingTimeOut: 20000
      })
      hls.loadSource(src)
      hls.attachMedia(v)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        // 合流刚启动时列表可能还没写好分片，这类错误可自愈，不打扰用户
        if (data.type === 'networkError') {
          hls?.startLoad()
        } else {
          errorMsg.value = '播放失败：' + (data.details || data.type)
        }
      })
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari 等原生支持 HLS
      v.src = src
    } else {
      errorMsg.value = '当前环境不支持 HLS 播放'
    }
  } else {
    v.src = src
  }
}

/** url 变化：重置状态并（可选）自动播放 */
watch(
  () => props.url,
  async (u) => {
    errorMsg.value = ''
    currentTime.value = 0
    buffered.value = 0
    duration.value = 0
    if (!u) {
      // 无源（关闭播放器/切换中）：释放底部条接管
      destroyHls()
      player.releaseVideo()
      return
    }
    await nextTick()
    const v = videoRef.value
    if (!v) return
    // 接管底部播放条：让它与视频显示同一份标题/进度/音量，
    // 避免出现「视频在放 A、底部条显示 B」的割裂
    player.claimByVideo(
      {
        kind: 'video',
        title: props.title,
        artist: props.author,
        cover: props.poster,
        currentTime: 0,
        duration: 0,
        paused: !props.autoplay,
        handlers: {
          toggle: togglePlay,
          seek: seekTo
        }
      },
      {
        // store 是音量/静音的唯一来源，这两个 sink 负责把它作用到 video 元素。
        // 注意参数已是**振幅**（store 内部经 ampOf 换算过），此处直接赋值即可，
        // 不要再套一次曲线。
        setVolume: (amp) => {
          const el = videoRef.value
          if (el) el.volume = amp
        },
        setMuted: (m, amp) => {
          const el = videoRef.value
          if (!el) return
          el.muted = !!m
          if (!m && typeof amp === 'number') el.volume = amp
        }
      }
    )
    attachSource(v, u)
    if (props.autoplay) {
      // HLS 要等 MANIFEST_PARSED 才能 play，直接 play 会抛 NotSupportedError
      if (hls) {
        hls.once(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}) })
      } else {
        v.load()
        v.play().catch(() => {})
      }
    }
    poke()
    // 换源即重新匹配字幕（不同视频的歌词不同）。
    // 只在 B 站页启用（有 bvid），不影响歌曲播放页。
    if (props.bvid) loadSubtitle()
  },
  { immediate: true }
)

/** bvid 变化（切分P/切视频）时也重新匹配字幕 */
watch(
  () => [props.bvid, props.cid],
  () => {
    if (props.bvid && props.url) loadSubtitle()
  }
)

/** 供底部条接管后调用：跳转到指定秒 */
function seekTo(sec) {
  const v = videoRef.value
  if (!v) return
  const d = v.duration || 0
  v.currentTime = Math.min(Math.max(0, sec), d > 0 ? d : sec)
}

/** 标题/封面变化（切换分P等）时更新接管信息 */
watch(
  () => [props.title, props.author, props.poster],
  () => {
    if (!props.url) return
    player.updateVideoSession({
      title: props.title,
      artist: props.author,
      cover: props.poster
    })
  }
)

function onError() {
  const v = videoRef.value
  const code = v?.error?.code
  const map = {
    1: '播放被中止',
    2: '网络错误',
    3: '解码失败（可能是编码格式不支持）',
    4: '视频源不可用或格式不支持'
  }
  errorMsg.value = map[code] || '播放失败'
  emit('error', { code, message: errorMsg.value })
}
</script>

<template>
  <div
    ref="wrapRef"
    class="bp-wrap"
    :class="{ 'web-full': isWebFullscreen, 'hide-cursor': !controlsVisible && playing }"
    @mousemove="poke"
    @mouseleave="controlsVisible = false"
  >
    <!--
      video 元素始终渲染（不用 v-if 切换）：
      合流时若用 v-if 把 video 卸载，会连带丢失 videoRef、播放状态与底部条接管，
      切画质后表现为「画面回到旧档位、播放停止」。这里改为合流时用叠加层盖住。
    -->
    <video
      ref="videoRef"
      class="bp-video"
      :src="url || undefined"
      :poster="poster || undefined"
      playsinline
      @click="togglePlay"
      @play="onVideoEvent"
      @pause="onVideoEvent"
      @timeupdate="onVideoEvent"
      @progress="onVideoEvent"
      @durationchange="onVideoEvent"
      @loadedmetadata="onVideoEvent"
      @ended="emit('ended')"
      @error="onError"
    />

    <!-- 合流中：叠加进度层（不卸载 video） -->
    <div v-if="merging" class="bp-merging">
      <div class="bp-merge-box">
        <div class="bp-merge-title">正在合并音视频流…</div>
        <div class="bp-merge-bar">
          <div class="bp-merge-fill" :style="{ width: Math.max(2, mergePercent) + '%' }"></div>
        </div>
        <div class="bp-merge-meta">
          <span>{{ mergeText || 'B 站高清为音视频分离流，需先合流才能播放' }}</span>
          <span v-if="mergePercent > 0">{{ Math.round(mergePercent) }}%</span>
        </div>
      </div>
    </div>

    <!-- 三行字幕：叠在视频上、进度条上方（仅 B 站页，不影响歌曲歌词页） -->
    <BiliSubtitle
      v-if="!merging && subLines.length"
      :lines="subLines"
      :time="currentTime"
      :active-index="subActive"
      :show-trans="true"
      :source-label="subLabel"
    />

    <!-- 字幕来源 / 手动搜索入口（右下角小按钮，不抢画面） -->
    <div v-if="!merging && bvid" class="bp-sub-btn-wrap" @click.stop>
      <button
        class="bp-sub-btn"
        :class="{ on: subLines.length, loading: subLoading }"
        :title="subLines.length ? '歌词：' + subLabel + '（点击可换）' : '搜索歌词'"
        @click="subSearchOpen ? (subSearchOpen = false) : openSubSearch()"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h16M4 12h10M4 18h7"/>
        </svg>
        <span class="bp-sub-label">{{ subLoading ? '匹配中…' : (subLines.length ? '歌词' : '搜歌词') }}</span>
      </button>

      <!-- 手动搜索面板：自动匹配不准时的兜底 -->
      <div v-if="subSearchOpen" class="bp-sub-panel">
        <div class="bp-sub-head">
          <span>搜索歌词</span>
          <button class="bp-sub-x" title="关闭" @click="subSearchOpen = false">✕</button>
        </div>
        <div class="bp-sub-input-row">
          <input
            v-model="subKeyword"
            class="bp-sub-input"
            placeholder="歌名 / 歌手"
            @keyup.enter="doSubSearch"
          />
          <button class="bp-sub-go" :disabled="subSearching" @click="doSubSearch">
            {{ subSearching ? '…' : '搜索' }}
          </button>
        </div>
        <div v-if="subResults.length" class="bp-sub-list">
          <button
            v-for="s in subResults"
            :key="s.id"
            class="bp-sub-item"
            @click="pickSubtitle(s)"
          >
            <span class="bp-sub-name">{{ s.name }}</span>
            <span class="bp-sub-artist">{{ s.artist }}</span>
          </button>
        </div>
        <div v-else-if="!subSearching" class="bp-sub-empty">输入关键词搜索，点结果即作为字幕</div>
        <div v-if="subLines.length" class="bp-sub-foot">
          <button class="bp-sub-clear" @click="clearSubtitle(); subSearchOpen = false">关闭字幕</button>
        </div>
      </div>
    </div>

    <template v-if="!merging">
      <!-- 中央播放按钮（暂停时） -->
      <button v-if="!playing && url" class="bp-center-play" @click.stop="togglePlay">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>

      <!-- 错误提示 -->
      <div v-if="errorMsg" class="bp-error">{{ errorMsg }}</div>

      <!-- 顶部信息（悬停显示） -->
      <div class="bp-top" :class="{ show: controlsVisible }">
        <div class="bp-title" :title="title">{{ title }}</div>
        <div v-if="author" class="bp-author">{{ author }}</div>
      </div>

      <!-- 底部控制条 -->
      <div class="bp-controls" :class="{ show: controlsVisible }" @click.stop>
        <!-- 进度条 -->
        <div
          ref="progressRef"
          class="bp-progress"
          @pointerdown.left="onProgressDown"
          @mousemove="onProgressHover"
          @mouseleave="hoverRatio = -1"
        >
          <div class="bp-progress-track">
            <div class="bp-progress-buffer" :style="{ width: bufferedPct + '%' }"></div>
            <div class="bp-progress-played" :style="{ width: progressPct + '%' }"></div>
            <div class="bp-progress-thumb" :style="{ left: progressPct + '%' }"></div>
          </div>
          <!-- 悬停时间气泡 -->
          <div v-if="hoverRatio >= 0 && duration" class="bp-progress-tip" :style="{ left: hoverRatio * 100 + '%' }">
            {{ hoverLabel }}
          </div>
        </div>

        <div class="bp-btn-row">
          <!-- 播放/暂停 -->
          <button class="bp-btn bp-play" :title="playing ? '暂停 (空格)' : '播放 (空格)'" @click="togglePlay">
            <svg v-if="playing" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>

          <!-- 时间 -->
          <div class="bp-time">{{ currentLabel }} / {{ durationLabel }}</div>

          <div class="bp-spacer"></div>

          <!-- 音量 -->
          <div class="bp-volume">
            <button class="bp-btn" :title="muted ? '取消静音 (M)' : '静音 (M)'" @click="toggleMute">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 5 6 9H3v6h3l5 4V5Z"/>
                <path v-if="!muted" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>
                <path v-else d="M16 9l6 6M22 9l-6 6"/>
              </svg>
            </button>
            <input
              class="bp-vol-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="muted ? 0 : volume"
              @input="setVolume(Number($event.target.value))"
            />
          </div>

          <!-- 倍速 -->
          <div class="bp-rate">
            <button class="bp-btn bp-text" :class="{ on: rate !== 1 }" title="播放速度" @click="rateOpen = !rateOpen">
              {{ rate }}x
            </button>
            <div v-if="rateOpen" class="bp-menu">
              <button
                v-for="r in RATES"
                :key="r"
                class="bp-menu-item"
                :class="{ on: r === rate }"
                @click="setRate(r)"
              >
                {{ r }}x
              </button>
            </div>
          </div>

          <!-- 画质 -->
          <div v-if="qualities.length" class="bp-quality">
            <button class="bp-btn bp-text" title="清晰度" @click="qualityOpen = !qualityOpen">
              {{ currentQualityName }}
            </button>
            <div v-if="qualityOpen" class="bp-menu bp-menu-right">
              <button
                v-for="q in qualities"
                :key="q.id"
                class="bp-menu-item"
                :class="{ on: q.id === quality }"
                @click="qualityOpen = false; emit('quality-change', q.id)"
              >
                {{ q.name }}
              </button>
            </div>
          </div>

          <!-- 网页全屏 -->
          <button class="bp-btn" :class="{ on: isWebFullscreen }" title="网页全屏" @click="toggleWebFullscreen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>
            </svg>
          </button>

          <!-- 全屏 -->
          <button class="bp-btn" :title="isFullscreen ? '退出全屏 (F)' : '全屏 (F)'" @click="toggleFullscreen">
            <svg v-if="!isFullscreen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3"/>
            </svg>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bp-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16/9;
  max-height: 70vh;
  background: #000;
  border-radius: 10px;
  overflow: hidden;
  user-select: none;
}
/* 网页全屏：铺满应用内容区 */
.bp-wrap.web-full {
  position: fixed;
  inset: 0;
  z-index: 900;
  max-height: none;
  border-radius: 0;
  aspect-ratio: auto;
}
.bp-wrap.hide-cursor { cursor: none; }

.bp-video {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
}

/* 中央播放按钮 */
.bp-center-play {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 66px;
  height: 66px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.18s var(--ease), transform 0.18s var(--ease);
}
.bp-center-play:hover { background: var(--accent); transform: translate(-50%, -50%) scale(1.08); }
.bp-center-play svg { width: 30px; height: 30px; margin-left: 3px; }

/* 顶部信息 */
.bp-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 14px 18px 30px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.65), transparent);
  color: #fff;
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 0.22s var(--ease), transform 0.22s var(--ease);
  pointer-events: none;
}
.bp-top.show { opacity: 1; transform: translateY(0); }
.bp-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
.bp-author { font-size: 12px; opacity: 0.75; margin-top: 3px; }

/* 底部控制条 */
.bp-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 22px 14px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.75), transparent);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.22s var(--ease), transform 0.22s var(--ease);
}
.bp-controls.show { opacity: 1; transform: translateY(0); }

/* 进度条 */
.bp-progress {
  position: relative;
  height: 14px;
  display: flex;
  align-items: center;
  cursor: pointer;
  margin-bottom: 4px;
}
.bp-progress-track {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.22);
  transition: height 0.14s var(--ease);
}
.bp-progress:hover .bp-progress-track { height: 5px; }
.bp-progress-buffer {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: rgba(255, 255, 255, 0.38);
  border-radius: 2px;
}
.bp-progress-played {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: var(--accent, #fb7299); /* B 站粉 */
  border-radius: 2px;
}
.bp-progress-thumb {
  position: absolute;
  top: 50%;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.14s var(--ease);
}
.bp-progress:hover .bp-progress-thumb { transform: translate(-50%, -50%) scale(1); }
.bp-progress-tip {
  position: absolute;
  bottom: 16px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.82);
  color: #fff;
  font-size: 12px;
  padding: 3px 7px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 按钮行 */
.bp-btn-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #fff;
}
.bp-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.92);
  border-radius: 6px;
  transition: background 0.15s var(--ease), color 0.15s var(--ease), transform 0.12s var(--ease);
}
.bp-btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.bp-btn:active { transform: scale(0.94); }
.bp-btn.on { color: var(--accent, #fb7299); }
.bp-btn svg { width: 19px; height: 19px; }
.bp-play svg { width: 22px; height: 22px; }
/* 文字按钮（倍速/画质） */
.bp-btn.bp-text {
  width: auto;
  min-width: 40px;
  padding: 0 9px;
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.bp-time {
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.88);
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
  white-space: nowrap;
}
.bp-spacer { flex: 1; }

/* 音量 */
.bp-volume { display: flex; align-items: center; }
.bp-vol-slider {
  width: 0;
  opacity: 0;
  transition: width 0.2s var(--ease), opacity 0.2s var(--ease);
  accent-color: var(--accent, #fb7299);
  cursor: pointer;
}
.bp-volume:hover .bp-vol-slider { width: 72px; opacity: 1; margin-left: 2px; }

/* 菜单（倍速 / 画质） */
.bp-rate, .bp-quality { position: relative; }
.bp-menu {
  position: absolute;
  bottom: 38px;
  left: 0;
  min-width: 92px;
  background: rgba(24, 24, 26, 0.95);
  backdrop-filter: blur(12px);
  border-radius: 8px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.5);
}
.bp-menu-right { left: auto; right: 0; min-width: 120px; }
.bp-menu-item {
  padding: 7px 11px;
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
  transition: background 0.13s var(--ease), color 0.13s var(--ease);
}
.bp-menu-item:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
.bp-menu-item.on { color: var(--accent, #fb7299); font-weight: 700; }

/* 错误 */
.bp-error {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 13px;
  padding: 10px 18px;
  border-radius: 8px;
}

/* 合流中：叠加在 video 之上（不卸载 video，避免丢失播放状态与接管） */
.bp-merging {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 遮住下方的 video 画面（合流期间画面是旧的，容易误解） */
  background: rgba(0, 0, 0, 0.82);
  z-index: 6;
}

/* ---- 字幕按钮与搜索面板 ---- */
.bp-sub-btn-wrap {
  position: absolute;
  right: 14px;
  /* 贴在控制条上方，与画质按钮错开（画质在控制条内） */
  bottom: 62px;
  z-index: 7;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.bp-sub-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(8px);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 600;
  transition: background 0.15s var(--ease), color 0.15s var(--ease), transform 0.15s var(--ease);
}
.bp-sub-btn:hover { background: rgba(0, 0, 0, 0.84); transform: scale(1.03); }
.bp-sub-btn.on { color: var(--accent, #fb7299); }
.bp-sub-btn.loading { opacity: 0.75; }
.bp-sub-btn svg { width: 13px; height: 13px; }
.bp-sub-label { white-space: nowrap; }

.bp-sub-panel {
  width: 260px;
  background: rgba(24, 24, 26, 0.96);
  backdrop-filter: blur(14px);
  border-radius: 10px;
  padding: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bp-sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  font-weight: 700;
  color: #fff;
}
.bp-sub-x {
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  padding: 2px 5px;
  border-radius: 4px;
}
.bp-sub-x:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
.bp-sub-input-row { display: flex; gap: 6px; }
.bp-sub-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  padding: 5px 9px;
  color: #fff;
  font-size: 12.5px;
  outline: none;
}
.bp-sub-input::placeholder { color: rgba(255, 255, 255, 0.4); }
.bp-sub-input:focus { border-color: var(--accent, #fb7299); }
.bp-sub-go {
  padding: 5px 11px;
  border-radius: 6px;
  background: var(--accent, #fb7299);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.bp-sub-go:disabled { opacity: 0.5; }
.bp-sub-list {
  max-height: 190px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.bp-sub-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 8px;
  border-radius: 6px;
  text-align: left;
  color: rgba(255, 255, 255, 0.88);
  transition: background 0.13s var(--ease);
}
.bp-sub-item:hover { background: rgba(255, 255, 255, 0.1); }
.bp-sub-name { font-size: 12.5px; font-weight: 600; }
.bp-sub-artist { font-size: 11px; color: rgba(255, 255, 255, 0.5); }
.bp-sub-empty {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.45);
  padding: 8px 2px;
  line-height: 1.5;
}
.bp-sub-foot { border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 8px; }
.bp-sub-clear {
  width: 100%;
  padding: 5px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
}
.bp-sub-clear:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }
.bp-merge-box { width: min(420px, 78%); text-align: center; }
.bp-merge-title { color: #fff; font-size: 14px; font-weight: 600; margin-bottom: 14px; }
.bp-merge-bar {
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}
.bp-merge-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent, #fb7299);
  transition: width 0.3s var(--ease-out);
}
.bp-merge-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}
</style>
