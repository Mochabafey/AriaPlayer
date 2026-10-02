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
import { usePlayerStore } from '../stores/player'

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
  autoplay: { type: Boolean, default: true }
})

const emit = defineEmits(['quality-change', 'ended', 'error'])

const player = usePlayerStore()
const videoRef = ref(null)
const wrapRef = ref(null)

const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const buffered = ref(0)
const volume = ref(0.8)
const muted = ref(false)
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

function setVolume(val) {
  const v = videoRef.value
  const nv = Math.min(1, Math.max(0, val))
  volume.value = nv
  muted.value = nv === 0
  if (v) {
    v.volume = nv
    v.muted = nv === 0
  }
}

function toggleMute() {
  const v = videoRef.value
  if (!v) return
  if (muted.value) {
    muted.value = false
    v.muted = false
    if (volume.value === 0) setVolume(0.8)
  } else {
    muted.value = true
    v.muted = true
  }
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
  // 释放底部条接管，否则离开视频页后底部条仍显示视频信息却无法控制
  player.releaseVideo()
})

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
          seek: seekTo,
          setMuted: setMutedExternal
        }
      },
      (vol) => {
        // 底部条调音量时作用到 video 元素
        const el = videoRef.value
        if (el) el.volume = vol
      }
    )
    v.load()
    if (props.autoplay) v.play().catch(() => {})
    poke()
  },
  { immediate: true }
)

/** 供底部条接管后调用：跳转到指定秒 */
function seekTo(sec) {
  const v = videoRef.value
  if (!v) return
  const d = v.duration || 0
  v.currentTime = Math.min(Math.max(0, sec), d > 0 ? d : sec)
}

/** 供底部条接管后调用：设置静音 */
function setMutedExternal(m) {
  const v = videoRef.value
  if (v) v.muted = !!m
  muted.value = !!m
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
    <!-- 合流中：显示进度而不是播放器 -->
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

    <template v-else>
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

/* 合流中 */
.bp-merging {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
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
