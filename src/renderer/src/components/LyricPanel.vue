<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { useDownloadsStore } from '../stores/downloads'
import { activeIndex } from '../utils/lrc'
import { api, imgUrl } from '../api'
import { toast } from '../utils/toast'

const player = usePlayerStore()
const settings = useSettingsStore()
const downloads = useDownloadsStore()
const listRef = ref(null)
const trackRef = ref(null)
const volTrackRef = ref(null)

const active = computed(() => activeIndex(player.lyrics, player.currentTime))
const hasLyric = computed(() => player.lyrics.length > 0)
// 是否显示歌词翻译（设置项 showTranslation）
const showTrans = computed(() => settings.settings.showTranslation)
const hasTrans = computed(() => player.lyrics.some((l) => l.trans))
function toggleTrans() {
  settings.set('showTranslation', !settings.settings.showTranslation)
}

// 封面模糊背景（Apple Music 全屏风格）
const bgStyle = computed(() => {
  const pic = player.current?.pic
  return pic
    ? { backgroundImage: `url(${imgUrl(pic)})` }
    : {}
})

/* ================= 歌词滚动：rAF 自定义缓动 =================
 * 原生 scrollIntoView({behavior:'smooth'}) 的时长随距离变化且互相打断，
 * 连续切行时顿挫感明显；改为固定时长 easeOutCubic（起步快收尾缓），
 * 每次切行从当前位置重新起跳，观感连续。 */
let scrollRaf = 0
let userScrollUntil = 0 // 用户手动翻动歌词后，暂停自动跟滚直到此时间戳

function centerLine(idx, animate = true) {
  const list = listRef.value
  if (!list) return
  const el = list.querySelector(`[data-idx="${idx}"]`)
  if (!el) return
  const rect = list.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const target =
    list.scrollTop + (elRect.top - rect.top) - (rect.height - elRect.height) / 2
  const clamped = Math.max(0, Math.min(target, list.scrollHeight - list.clientHeight))
  if (!animate) {
    list.scrollTop = clamped
    return
  }
  if (performance.now() < userScrollUntil) return // 用户正在翻看，别抢滚动条
  cancelAnimationFrame(scrollRaf)
  const from = list.scrollTop
  if (Math.abs(clamped - from) < 1) return
  const start = performance.now()
  const dur = 460
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur)
    const e = 1 - (1 - t) ** 3 // easeOutCubic
    list.scrollTop = from + (clamped - from) * e
    if (t < 1) scrollRaf = requestAnimationFrame(step)
  }
  scrollRaf = requestAnimationFrame(step)
}

/** 用户滚轮/触摸翻动歌词：中止动画并暂停自动跟滚 2.6s */
function onUserScroll() {
  cancelAnimationFrame(scrollRaf)
  userScrollUntil = performance.now() + 2600
}

/** 点击歌词行 seek：主动恢复跟滚（点击即表示要跟着这句走） */
function seekLine(line) {
  userScrollUntil = 0
  player.seek(line.time)
}

watch(active, (idx) => {
  if (idx >= 0) centerLine(idx)
})

// 切歌后歌词数组被替换：若新旧 active 索引相同上面的 watch 不会触发，
// 需主动把列表滚回当前行（无动画直跳），避免停留在上一首的滚动位置
watch(
  () => player.lyrics,
  async () => {
    await nextTick()
    if (!listRef.value) return
    if (active.value >= 0) centerLine(active.value, false)
    else listRef.value.scrollTop = 0
  }
)

/* ================= 进度条（Apple Music 风格） ================= */
const seeking = ref(false)
const dragTime = ref(0)

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

const shownTime = computed(() => (seeking.value ? dragTime.value : player.currentTime))
const pct = computed(() =>
  player.duration ? Math.min(100, (shownTime.value / player.duration) * 100) : 0
)
const elapsedLabel = computed(() => fmt(shownTime.value))
const remainLabel = computed(() => '-' + fmt(Math.max(0, player.duration - shownTime.value)))

function posToTime(e) {
  const rect = trackRef.value.getBoundingClientRect()
  const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width)
  return (x / rect.width) * (player.duration || 0)
}
function onDown(e) {
  if (!player.duration) return
  seeking.value = true
  dragTime.value = posToTime(e)
  trackRef.value.setPointerCapture?.(e.pointerId)
}
function onMove(e) {
  if (!seeking.value) return
  dragTime.value = posToTime(e)
}
function onUp() {
  if (!seeking.value) return
  seeking.value = false
  player.seek(dragTime.value)
}

/* ================= 播放模式 / 收藏 / 下载 / 音量 / 播放队列 ================= */
// 播放模式：list 列表循环 → loop 单曲循环 → shuffle 随机（无 toast，hover 按钮显示模式名）
function cycleMode() {
  const map = { list: 'loop', loop: 'shuffle', shuffle: 'list' }
  settings.set('playMode', map[settings.settings.playMode])
}
const modeTitle = computed(() => ({ list: '列表循环', loop: '单曲循环', shuffle: '随机播放' })[settings.settings.playMode])

// 播放队列
const showQueue = ref(false)

// 收藏（喜欢）：乐观更新，失败回滚。uid 挂载时从 login_status 取一次并缓存
const liked = ref(false)
const likePending = ref(false)
let uidCache = null
async function refreshLiked() {
  const id = player.current?.id
  liked.value = false
  if (!id || !uidCache) return
  try {
    const lk = await api('likelist', { uid: uidCache })
    if (lk.ids?.includes(id)) liked.value = true
  } catch { /* 未登录忽略 */ }
}
onMounted(async () => {
  try {
    const s = await api('login_status')
    const acc = s.data?.account
    if (acc && !acc.anonimousUser) {
      uidCache = acc.id
      refreshLiked() // uid 拿到后补查当前歌曲
    }
  } catch { /* 未登录 */ }
})
watch(() => player.current?.id, refreshLiked)
async function toggleLike() {
  const song = player.current
  if (!song || likePending.value) return
  likePending.value = true
  const was = liked.value
  liked.value = !was
  try {
    await api('like', { id: song.id, like: !was })
  } catch (e) {
    liked.value = was
    toast(e.code === 301 ? '喜欢功能需要先登录' : '操作失败：' + (e.message || '未知错误'), 'error')
  } finally {
    likePending.value = false
  }
}

// 下载当前歌曲
function downloadCurrent() {
  const song = player.current
  if (!song || song.fromLocal) return
  downloads.add({
    songId: song.id,
    title: song.name,
    artist: song.artist,
    url: song.audioUrl,
    quality: settings.settings.quality,
    cover: song.pic
  })
  toast('已加入下载队列')
}

// 音量：点击 + 拖拽 + 静音（与 PlayerBar 同一套交互）
const muted = ref(false)
const mutedVolume = ref(0.8)
const volumeDisplay = computed(() => (muted.value ? 0 : Math.round(player.volume * 100)))

function ratioFromEvent(el, e) {
  const rect = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}
function setVolFromEvent(e) {
  player.setVolume(ratioFromEvent(volTrackRef.value, e))
}
let volDragging = false
function onVolDown(e) {
  volDragging = true
  setVolFromEvent(e)
  window.addEventListener('pointermove', onVolMove)
  window.addEventListener('pointerup', onVolUp)
}
function onVolMove(e) {
  if (volDragging) setVolFromEvent(e)
}
function onVolUp() {
  volDragging = false
  window.removeEventListener('pointermove', onVolMove)
  window.removeEventListener('pointerup', onVolUp)
}
function toggleMute() {
  if (muted.value) {
    player.setVolume(mutedVolume.value)
    muted.value = false
  } else {
    mutedVolume.value = player.volume
    player.setVolume(0)
    muted.value = true
  }
}
watch(
  () => player.volume,
  (v) => {
    if (v > 0 && muted.value) muted.value = false
  }
)

/* ================= 沉浸模式：10s 无操作自动隐藏控件 ================= */
const idle = ref(false)
let idleTimer = null
const IDLE_MS = 10000

function poke() {
  idle.value = false
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!seeking.value) idle.value = true
  }, IDLE_MS)
}

onMounted(() => {
  poke()
  // 监听 window：鼠标移到底部 PlayerBar 区域也能唤醒
  window.addEventListener('mousemove', poke, { passive: true })
  window.addEventListener('pointerdown', poke, { passive: true })
  window.addEventListener('wheel', poke, { passive: true })
  window.addEventListener('keydown', poke)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(scrollRaf)
  clearTimeout(idleTimer)
  window.removeEventListener('mousemove', poke)
  window.removeEventListener('pointerdown', poke)
  window.removeEventListener('wheel', poke)
  window.removeEventListener('keydown', poke)
  window.removeEventListener('pointermove', onVolMove)
  window.removeEventListener('pointerup', onVolUp)
})
</script>

<template>
  <div class="lyric-panel" :class="{ immersed: idle }">
    <div class="lyric-bg" :style="bgStyle"></div>
    <!-- 无边框窗口拖拽条：全屏播放页也可移动窗口（不遮挡任何交互） -->
    <div class="drag-zone"></div>
    <div class="lyric-inner">
      <div class="left-col">
        <div class="cover-large" v-if="player.current">
          <img :src="imgUrl(player.current.pic)" alt="" />
        </div>
        <div class="track-info" v-if="player.current">
          <div class="t-name">{{ player.current.name }}</div>
          <div class="t-artist">{{ player.current.artist }}</div>
        </div>
      </div>
      <div class="lyric-list" ref="listRef" @wheel.passive="onUserScroll" @touchmove.passive="onUserScroll">
        <p v-if="!hasLyric" class="no-lyric">暂无歌词</p>
        <template v-else>
          <p
            v-for="(line, i) in player.lyrics"
            :key="i"
            :data-idx="i"
            class="lyric-line"
            :class="{ active: i === active }"
            title="跳转到此句"
            @click="seekLine(line)"
          >
            {{ line.text }}
            <span v-if="showTrans && line.trans" class="lyric-trans">{{ line.trans }}</span>
          </p>
        </template>
      </div>
    </div>

    <!-- 常驻控制坞：进度条 + 播放控制（沉浸时收起为小白条） -->
    <div class="dock-wrap">
      <div
        class="progress-dock"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <span class="time">{{ elapsedLabel }}</span>
        <div class="p-track" ref="trackRef" :class="{ drag: seeking, buffering: player.buffering }">
          <div class="p-fill" :style="{ width: pct + '%' }"></div>
          <div class="p-knob" :style="{ left: pct + '%' }"></div>
        </div>
        <span class="time">{{ remainLabel }}</span>
      </div>
      <div class="ctrl-row">
        <!-- 左：模式 / 收藏 / 下载 -->
        <div class="ctrl-side left">
          <button class="c-btn ghost tip-up" @click="cycleMode">
            <svg v-if="settings.settings.playMode === 'loop'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="7" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>
            <svg v-else-if="settings.settings.playMode === 'shuffle'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
            <span class="tip-bubble">{{ modeTitle }}</span>
          </button>
          <button
            v-if="hasTrans"
            class="c-btn ghost tip-up trans-btn"
            :class="{ on: showTrans }"
            @click="toggleTrans"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h8"/><path d="M7 3v2c0 4-2 7-4 8"/><path d="M5 8c1.5 3 3.5 5 6 6"/><path d="M13 21l4-9 4 9"/><path d="M14.5 17.5h5"/></svg>
            <span class="tip-bubble">{{ showTrans ? '关闭翻译' : '显示翻译' }}</span>
          </button>
          <button class="c-btn ghost" :class="{ 'like-on': liked }" :title="liked ? '取消喜欢' : '喜欢'" @click="toggleLike">
            <svg viewBox="0 0 24 24" :fill="liked ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
          <button class="c-btn ghost" title="下载当前歌曲" @click="downloadCurrent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
          </button>
        </div>
        <!-- 中：上一首 / 播放 / 下一首 -->
        <button class="c-btn main" title="上一首" @click="player.prev()">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button class="c-btn main play" :title="player.playing ? '暂停' : '播放'" @click="player.toggle()">
          <svg v-if="player.buffering" class="spin" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7z"/></svg>
          <svg v-else-if="player.playing" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="c-btn main" title="下一首" @click="player.next()">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg>
        </button>
        <!-- 右：播放队列 / 音量 -->
        <div class="ctrl-side right">
          <button class="c-btn ghost" :class="{ 'queue-on': showQueue }" title="当前播放队列" @click="showQueue = !showQueue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13"/><path d="M3 12h13"/><path d="M3 18h9"/><path d="M16 15.5l5 3-5 3z" fill="currentColor" stroke="none"/></svg>
          </button>
          <button class="c-btn ghost vol-btn" :class="{ muted }" :title="muted ? '取消静音' : '静音'" @click="toggleMute">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 5 6 9H3v6h3l5 4V5Z"/>
              <path v-if="!muted" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>
              <path v-else d="M16 9l6 6M22 9l-6 6"/>
            </svg>
          </button>
          <div
            ref="volTrackRef"
            class="vol-track"
            :class="{ muted }"
            title="音量（点击或拖动调节）"
            @pointerdown.left="onVolDown"
          >
            <div class="vol-fill" :style="{ width: volumeDisplay + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 沉浸态：悬浮小白条（仅时间 + 进度） -->
    <div class="mini-bar">
      <span class="time">{{ elapsedLabel }}</span>
      <span class="mini-track"><span class="mini-fill" :style="{ width: pct + '%' }"></span></span>
      <span class="time">{{ remainLabel }}</span>
    </div>

    <!-- 当前播放队列抽屉 -->
    <div class="queue-drawer" :class="{ open: showQueue }">
      <div class="queue-header">
        <h3>当前播放 <span class="q-count">{{ player.queue.length }} 首</span></h3>
        <div class="q-actions">
          <button v-if="player.queue.length" class="q-text-btn" @click="player.clearQueue()">清空</button>
          <button class="close-queue" @click="showQueue = false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </div>
      <div class="queue-list">
        <p v-if="!player.queue.length" class="q-empty">队列为空，去挑几首喜欢的歌吧</p>
        <div
          v-for="(song, idx) in player.queue"
          :key="song.id + '-' + idx"
          class="queue-item"
          :class="{ current: idx === player.currentIndex }"
          @click="player.playAt(idx)"
        >
          <div class="q-idx">
            <span v-if="idx === player.currentIndex && player.playing" class="eq"><i></i><i></i><i></i></span>
            <span v-else>{{ idx + 1 }}</span>
          </div>
          <img v-if="song.pic" :src="imgUrl(song.pic)" alt="" class="queue-cover" />
          <div v-else class="queue-cover no-pic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </div>
          <div class="queue-info">
            <div class="queue-title">{{ song.name }}</div>
            <div class="queue-artist">{{ song.artist }}</div>
          </div>
          <span class="queue-time">{{ song.duration ? fmt(song.duration) : '' }}</span>
          <button class="q-del" title="移出队列" @click.stop="player.removeFromQueue(idx)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </div>
    </div>

    <button class="close-btn" @click="player.showLyrics = false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
    </button>
  </div>
</template>

<style scoped>
.lyric-panel {
  --lyric-h: min(52vh, 520px);
  position: fixed;
  inset: 0;
  z-index: 200;
}
.lyric-bg {
  position: absolute;
  inset: 0;
  background: #000;
  background-size: cover;
  background-position: center;
  filter: blur(60px) brightness(0.4) saturate(1.4);
  transform: scale(1.4);
}
.lyric-inner {
  position: relative;
  height: 100%;
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(36px, 6vw, 96px);
  padding: 40px 6vw 150px;
  box-sizing: border-box;
  transition: padding 0.45s var(--ease);
}
/* 沉浸态控制坞收起：内容下沉至真正垂直居中，消除底部空块 */
.immersed .lyric-inner { padding-bottom: 40px; }
.left-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(14px, 2vh, 24px);
  flex-shrink: 0;
}
/* 封面随窗口等比缩放：受宽度、高度、上限三方约束 */
.cover-large {
  width: min(30vw, 44vh, 340px);
  aspect-ratio: 1;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-lg);
}
.cover-large img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.track-info { text-align: center; max-width: min(30vw, 340px); }
.t-name {
  font-size: clamp(18px, 1.55vw, 23px);
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-artist {
  font-size: clamp(14px, 1.15vw, 16px);
  color: rgba(255, 255, 255, 0.78);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.4);
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 歌词列：高度随视口等比缩放，上下留白一半高度让首尾行可居中 */
.lyric-list {
  flex: 1;
  max-width: 560px;
  height: var(--lyric-h);
  overflow-y: auto;
  /* 滚动由 rAF 逐帧驱动，禁用原生 smooth（避免每次 scrollTop 赋值被排队成动画） */
  overscroll-behavior: contain;
  padding: calc(var(--lyric-h) / 2 - 22px) 24px;
  mask-image: linear-gradient(180deg, transparent, #000 14%, #000 86%, transparent);
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 14%, #000 86%, transparent);
}
.lyric-line {
  text-align: center;
  font-size: clamp(17px, 1.4vw, 20px);
  line-height: 1.55;
  padding: 7px 14px;
  color: rgba(255, 255, 255, 0.42);
  /* 用 scale 做放大动画：不触发重排，上下行不被推挤，滚动丝滑 */
  transition: color 0.4s var(--ease), transform 0.4s var(--ease);
  cursor: pointer;
}
.lyric-line.active {
  color: #fff;
  font-weight: 700;
  transform: scale(1.1);
}
/* 翻译行：紧跟歌词原文（间隔收敛），激活时与原文同步高亮 */
.lyric-trans {
  display: block;
  margin-top: 3px;
  line-height: 1.45;
  font-size: clamp(14px, 1.15vw, 17px);
  font-weight: 400;
  color: rgba(255, 255, 255, 0.45);
  transition: color 0.4s var(--ease);
}
.lyric-line.active .lyric-trans { color: rgba(255, 255, 255, 0.92); }
/* 翻译开关激活态 */
.c-btn.trans-btn.on { color: #fff; }
.c-btn.trans-btn.on::after {
  content: '';
  position: absolute;
  bottom: 1px;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff;
  opacity: 0.9;
}
.no-lyric {
  text-align: center;
  color: var(--text-faint);
}

/* ---- 常驻控制坞（Apple Music 风格）：进度条 + 控制键 ---- */
.dock-wrap {
  position: absolute;
  bottom: clamp(16px, 3.5vh, 30px);
  left: 50%;
  transform: translate(-50%, 0);
  width: min(920px, 82vw);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(10px, 1.6vh, 16px);
  transition: opacity 0.45s var(--ease), transform 0.45s var(--ease);
}
.progress-dock {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
}
.progress-dock .time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.62);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  min-width: 34px;
}
.progress-dock .time:last-child { text-align: right; }
.p-track {
  position: relative;
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
  cursor: pointer;
  transition: height 0.18s var(--ease);
  touch-action: none;
}
.progress-dock:hover .p-track,
.p-track.drag { height: 7px; }
.p-fill {
  height: 100%;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.35);
  transition: width 0.25s linear;
}
.p-track.drag .p-fill { transition: none; }
.p-track.buffering .p-fill { animation: p-pulse 1.2s ease-in-out infinite; }
@keyframes p-pulse { 50% { opacity: 0.45; } }
.p-knob {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.18s var(--ease);
  pointer-events: none;
}
.progress-dock:hover .p-knob,
.p-track.drag .p-knob { transform: translate(-50%, -50%) scale(1); }

/* ---- 控制区：无底图标，三键居中、其余两侧对称 ---- */
.ctrl-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: clamp(10px, 2vw, 20px);
}
/* 两侧弹性等宽，保证中间三键始终绝对居中 */
.ctrl-side {
  flex: 1;
  display: flex;
  align-items: center;
  gap: clamp(14px, 2.5vw, 26px);
}
.ctrl-side.left { justify-content: flex-start; }
.ctrl-side.right { justify-content: flex-end; gap: 10px; }

.c-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.82);
  background: none;
  border: none;
  transition: color 0.18s var(--ease), transform 0.18s var(--ease), opacity 0.18s var(--ease);
}
.c-btn:hover { color: #fff; transform: scale(1.1); }
.c-btn:active { transform: scale(0.94); }

/* 两侧功能键：小图标 */
.c-btn.ghost { width: 34px; height: 34px; }
.c-btn.ghost svg { width: 19px; height: 19px; }

/* 中间主控三键：大图标 */
.c-btn.main { width: 44px; height: 44px; }
.c-btn.main svg { width: 30px; height: 30px; }
.c-btn.main.play svg { width: 38px; height: 38px; }

.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 收藏激活：红心 */
.c-btn.like-on { color: var(--accent, #fa5151); }
.c-btn.like-on:hover { color: var(--accent, #fa5151); }

/* 队列按钮激活（抽屉打开） */
.c-btn.queue-on { color: #fff; }

/* ---- 音量 ---- */
.vol-btn.muted { color: rgba(255, 255, 255, 0.4); }
.vol-track {
  width: clamp(64px, 7vw, 96px);
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
  cursor: pointer;
  transition: height 0.18s var(--ease);
  touch-action: none;
}
.ctrl-side.right:hover .vol-track { height: 6px; }
.vol-fill {
  height: 100%;
  border-radius: 999px;
  background: #fff;
}

/* ---- 沉浸态小白条 ---- */
.mini-bar {
  position: absolute;
  bottom: clamp(14px, 3vh, 26px);
  left: 50%;
  transform: translate(-50%, 8px);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(16px);
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.5s var(--ease), transform 0.5s var(--ease);
}
.mini-track {
  position: relative;
  width: 120px;
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
  overflow: hidden;
}
.mini-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: #fff;
  transition: width 0.25s linear;
}

/* ---- 沉浸模式：隐藏控件，只留小白条 ---- */
.immersed .dock-wrap {
  opacity: 0;
  transform: translate(-50%, 10px);
  pointer-events: none;
}
.immersed .close-btn {
  opacity: 0;
  pointer-events: none;
}
.immersed .mini-bar {
  opacity: 1;
  transform: translate(-50%, 0);
}

.close-btn {
  position: absolute;
  top: 26px;
  right: 30px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(10px);
  color: rgba(255, 255, 255, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.4s var(--ease), background 0.15s, color 0.15s;
  -webkit-app-region: no-drag;
  z-index: 6;
}
/* 顶部拖拽条（无边框窗口）：低于 close 按钮与队列抽屉 */
.drag-zone {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 40px;
  -webkit-app-region: drag;
  z-index: 5;
}
.close-btn svg { width: 15px; height: 15px; }
.close-btn:hover { background: rgba(255, 255, 255, 0.22); color: #fff; }

/* ---- 悬浮小字提示（替代原生 title / toast） ---- */
.tip-up { position: relative; }
.tip-bubble {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%) translateY(3px);
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.92);
  font-size: 11px;
  line-height: 1.7;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}
.tip-up:hover .tip-bubble {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* ---- 当前播放队列抽屉 ---- */
.queue-drawer {
  position: absolute;
  top: 0;
  right: 0;
  width: min(360px, 88vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: rgba(20, 20, 20, 0.82);
  backdrop-filter: blur(24px);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  transform: translateX(105%);
  transition: transform 0.35s var(--ease);
  z-index: 300;
}
.queue-drawer.open { transform: translateX(0); }
.queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.queue-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.92);
}
.q-count {
  font-size: 12px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
  margin-left: 6px;
}
.q-actions { display: flex; align-items: center; gap: 8px; }
.q-text-btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}
.q-text-btn:hover { color: rgba(255, 255, 255, 0.9); background: rgba(255, 255, 255, 0.08); }
.close-queue {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.close-queue svg { width: 12px; height: 12px; }
.close-queue:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
.queue-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0 16px;
}
.queue-list::-webkit-scrollbar { width: 6px; }
.queue-list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }
.q-empty {
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
  padding: 40px 0;
}
.queue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.queue-item:hover { background: rgba(255, 255, 255, 0.06); }
.queue-item.current { background: rgba(255, 255, 255, 0.09); }
.q-idx {
  width: 20px;
  flex-shrink: 0;
  text-align: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  font-variant-numeric: tabular-nums;
}
.queue-item.current .q-idx { color: rgba(255, 255, 255, 0.85); }
/* 正在播放的跳动小条 */
.eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.eq i {
  width: 2.5px;
  border-radius: 1px;
  background: currentColor;
  animation: eq-jump 0.9s ease-in-out infinite;
}
.eq i:nth-child(2) { animation-delay: 0.25s; }
.eq i:nth-child(3) { animation-delay: 0.5s; }
@keyframes eq-jump {
  0%, 100% { height: 4px; }
  50% { height: 12px; }
}
.queue-cover {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
}
.queue-cover.no-pic {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.35);
}
.queue-cover.no-pic svg { width: 18px; height: 18px; }
.queue-info { flex: 1; min-width: 0; }
.queue-title {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.88);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-item.current .queue-title { color: #fff; font-weight: 600; }
.queue-artist {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-time {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.q-del {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background: none;
  color: rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}
.queue-item:hover .q-del { opacity: 1; }
.q-del svg { width: 12px; height: 12px; }
.q-del:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }

/* ---- 窄窗口适配 ---- */
@media (max-width: 920px) {
  .lyric-inner { gap: 24px; }
  .cover-large { width: min(26vw, 30vh, 220px); }
  .lyric-panel { --lyric-h: min(52vh, 460px); }
}

/* ---- 进入/离开播放页动效 ---- */
/* 整体淡入 */
.player-full-enter-active {
  transition: opacity 0.35s var(--ease);
}
.player-full-leave-active {
  transition: opacity 0.25s var(--ease);
}
.player-full-enter-from,
.player-full-leave-to {
  opacity: 0;
}
/* 模糊背景：从清晰快速铺开 */
.player-full-enter-active .lyric-bg {
  transition: opacity 0.4s ease;
}
.player-full-enter-from .lyric-bg {
  opacity: 0;
}
/* 大封面：从小圆角块放大展开 + 弹性回弹 */
.player-full-enter-active .cover-large {
  transition:
    transform 0.55s var(--ease-spring),
    opacity 0.4s var(--ease),
    box-shadow 0.55s var(--ease);
  transform-origin: center;
}
.player-full-enter-from .cover-large {
  opacity: 0;
  transform: scale(0.6) translateY(14px);
  box-shadow: none;
}
/* 歌曲信息与歌词：错开上浮 */
.player-full-enter-active .track-info,
.player-full-enter-active .lyric-list,
.player-full-enter-active .close-btn {
  transition:
    opacity 0.45s var(--ease),
    transform 0.45s var(--ease);
}
.player-full-enter-from .track-info {
  opacity: 0;
  transform: translateY(18px);
}
.player-full-enter-from .lyric-list {
  opacity: 0;
  transform: translateY(26px);
}
.player-full-enter-from .close-btn {
  opacity: 0;
  transform: translateY(-10px);
}
/* 控制坞最后浮现 */
.player-full-enter-active .dock-wrap {
  transition:
    opacity 0.5s var(--ease) 0.12s,
    transform 0.5s var(--ease) 0.12s;
}
.player-full-enter-from .dock-wrap {
  opacity: 0;
  transform: translate(-50%, 16px);
}
/* 离开时轻微缩小收拢 */
.player-full-leave-active .cover-large {
  transition: transform 0.25s var(--ease), opacity 0.25s var(--ease);
}
.player-full-leave-to .cover-large {
  opacity: 0;
  transform: scale(0.85) translateY(8px);
}
</style>
