<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { useDownloadsStore } from '../stores/downloads'
import { imgUrl } from '../api'
import { fmtTime } from '../utils/format'
import { toast } from '../utils/toast'
import { useVolumeSlider } from '../composables/useVolumeSlider'

const router = useRouter()
const player = usePlayerStore()
const settings = useSettingsStore()
const downloads = useDownloadsStore()
const audioRef = ref(null)

const progress = computed(() => {
  if (dragging.value) return dragRatio.value * 100
  if (!player.duration) return 0
  return (player.currentTime / player.duration) * 100
})

/* ---- 进度条：点击 + 拖拽 ---- */
const seekTrackRef = ref(null)
const dragging = ref(false)
const dragRatio = ref(0)
const hoverRatio = ref(-1)

function ratioFromEvent(el, e) {
  const rect = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

function onSeekDown(e) {
  dragging.value = true
  dragRatio.value = ratioFromEvent(seekTrackRef.value, e)
  window.addEventListener('pointermove', onSeekMove)
  window.addEventListener('pointerup', onSeekUp)
}
function onSeekMove(e) {
  if (!dragging.value || !seekTrackRef.value) return
  dragRatio.value = ratioFromEvent(seekTrackRef.value, e)
}
function onSeekUp() {
  window.removeEventListener('pointermove', onSeekMove)
  window.removeEventListener('pointerup', onSeekUp)
  if (dragging.value && player.duration > 0) player.seek(dragRatio.value * player.duration)
  dragging.value = false
}
function onSeekHover(e) {
  if (seekTrackRef.value) hoverRatio.value = ratioFromEvent(seekTrackRef.value, e)
}

/* ---- 音量条：点击 + 拖拽 + 滚轮 + 静音（逻辑与 LyricPanel 共用 composable） ---- */
const {
  trackRef: volTrackRef,
  dragging: volDragging,
  hoverRatio: volHover,
  muted,
  volumeDisplay,
  onDown: onVolDown,
  onHover: onVolHover,
  onLeave: onVolLeave,
  onWheel: onVolWheel,
  toggleMute
} = useVolumeSlider()

function cycleMode() {
  const map = { list: 'loop', loop: 'shuffle', shuffle: 'list' }
  settings.set('playMode', map[settings.settings.playMode])
}

const modeTitle = computed(() => ({ list: '列表循环', loop: '单曲循环', shuffle: '随机播放' })[settings.settings.playMode])

async function downloadCurrent() {
  const song = player.current
  if (!song || song.fromLocal) return
  // 必须 await + catch：store 内部已统一 toast（成功/重复/失败），
  // 但 add 抛错时（IPC 异常等）不接会变成 unhandledRejection 且用户毫无反馈
  try {
    await downloads.add({
      songId: song.id,
      title: song.name,
      artist: song.artist,
      url: song.audioUrl,
      quality: settings.settings.quality,
      cover: song.pic
    })
  } catch (e) {
    toast('下载失败：' + (e?.message || '未知错误'), 'error')
  }
}

onMounted(() => {
  player.attachAudio(audioRef.value)
})

onUnmounted(() => {
  // 清理拖拽残留的全局事件监听器，防止组件卸载后内存泄漏
  // （音量条的 pointermove/up 由 useVolumeSlider 的 onBeforeUnmount 自行清理）
  window.removeEventListener('pointermove', onSeekMove)
  window.removeEventListener('pointerup', onSeekUp)
})
</script>

<template>
  <div class="player-bar" :class="{ playing: player.playing }">
    <audio ref="audioRef" preload="metadata" class="hidden-audio" />
    <div v-if="player.playError" class="play-error">{{ player.playError }}</div>

    <!-- 顶部进度条 -->
    <div
      ref="seekTrackRef"
      class="seek-track"
      :class="{ dragging }"
      @pointerdown.left="onSeekDown"
      @mousemove="onSeekHover"
      @mouseleave="hoverRatio = -1"
    >
      <div class="seek-fill" :style="{ width: progress + '%' }"></div>
      <div class="seek-knob" :style="{ left: progress + '%' }"></div>
      <div v-if="hoverRatio >= 0" class="seek-tip" :style="{ left: hoverRatio * 100 + '%' }">
        {{ fmtTime(hoverRatio * player.duration) }}
      </div>
    </div>

    <!-- 左：圆形封面 + 信息 -->
    <div class="p-left">
      <div
        class="cover clickable"
        v-if="player.current"
        title="展开播放页"
        @click="player.showLyrics = !player.showLyrics"
      >
        <img :src="imgUrl(player.current.pic)" alt="" loading="lazy" />
      </div>
      <div class="cover placeholder" v-else>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V6l11-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16.5" r="2.5"/></svg>
      </div>
      <div class="meta" v-if="player.current">
        <div class="title" :title="player.current.name">{{ player.current.name }}</div>
        <div class="artist">{{ player.current.artist }}</div>
      </div>
      <div class="meta empty" v-else>未在播放</div>
    </div>

    <!-- 中：控制按钮 -->
    <div class="p-center">
      <button class="ctrl sm" :title="modeTitle" @click="cycleMode">
        <svg v-if="settings.settings.playMode === 'loop'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="7" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>
        <svg v-else-if="settings.settings.playMode === 'shuffle'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
      </button>
      <button class="ctrl" title="上一首" @click="player.prev()">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>
      </button>
      <button class="ctrl play" title="播放/暂停" @click="player.toggle()">
        <svg v-if="player.buffering" viewBox="0 0 24 24" fill="currentColor" class="spin"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7z"/></svg>
        <svg v-else-if="player.playing" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="ctrl" title="下一首" @click="player.next()">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>
      </button>
      <span class="time cur">{{ fmtTime(player.currentTime) }}</span>
      <span class="time-divider">/</span>
      <span class="time total">{{ fmtTime(player.duration) }}</span>
    </div>

    <!-- 右：歌词/下载/音量 -->
    <div class="p-right">
      <!-- 全局下载进度指示器：有任务在跑时常驻显示环形进度 + 数量，
           点击直达下载页。不在下载页也能确认「到底下没下」。 -->
      <button
        v-if="downloads.activeCount"
        class="dl-indicator"
        :title="`${downloads.activeCount} 个任务下载中（${Math.round(downloads.overallProgress * 100)}%）— 点击查看`"
        @click="router.push('/downloads')"
      >
        <svg class="dl-ring" viewBox="0 0 36 36">
          <!-- 底环 -->
          <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" stroke-width="3" opacity="0.18" />
          <!-- 进度环：dasharray = 周长(2πr≈94.25)，offset 按进度收缩 -->
          <circle
            cx="18" cy="18" r="15" fill="none"
            stroke="currentColor" stroke-width="3" stroke-linecap="round"
            :stroke-dasharray="94.25"
            :stroke-dashoffset="94.25 * (1 - downloads.overallProgress)"
            transform="rotate(-90 18 18)"
          />
        </svg>
        <span class="dl-count">{{ downloads.activeCount }}</span>
      </button>
      <button class="ctrl sm" title="歌词" :class="{ active: player.showLyrics }" @click="player.showLyrics = !player.showLyrics">≣</button>
      <button class="ctrl sm" title="下载当前歌曲" @click="downloadCurrent">⇩</button>
      <div class="vol-wrap">
        <button
          class="vol-icon"
          :class="{ muted }"
          :title="muted ? '取消静音' : '静音'"
          @click="toggleMute"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 5 6 9H3v6h3l5 4V5Z"/>
            <path v-if="!muted" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>
            <path v-else d="M16 9l6 6M22 9l-6 6"/>
          </svg>
        </button>
        <div
          ref="volTrackRef"
          class="volume"
          :class="{ muted, dragging: volDragging }"
          title="音量（点击/拖动调节，滚轮 ±5%）"
          @pointerdown.left="onVolDown"
          @mousemove="onVolHover"
          @mouseleave="onVolLeave"
          @wheel="onVolWheel"
        >
          <div class="volume-fill" :style="{ width: volumeDisplay + '%' }"></div>
          <span v-if="volHover >= 0" class="vol-tip" :style="{ left: volHover * 100 + '%' }">
            {{ Math.round(volHover * 100) }}%
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--player-h);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 20px;
  gap: 20px;
  z-index: 100;
  background: #fff;
}

/* 顶部全宽进度条 */
.seek-track {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--border);
  cursor: pointer;
  transition: height 0.15s var(--ease);
}
.seek-track:hover,
.seek-track.dragging { height: 5px; }
.seek-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 0 3px 3px 0;
  transition: width 0.1s linear;
}
/* 拖动中即时跟随指针，去掉过渡追赶的拖沓感 */
.seek-track.dragging .seek-fill { transition: none; }
.seek-knob {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.15s var(--ease);
  pointer-events: none;
}
.seek-track:hover .seek-knob,
.seek-track.dragging .seek-knob { transform: translate(-50%, -50%) scale(1); }
.seek-tip {
  position: absolute;
  bottom: 10px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  pointer-events: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 左：方形封面 + 信息 */
.p-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 200px;
}
.cover {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-hover);
  box-shadow: var(--shadow-cover);
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover.clickable {
  cursor: pointer;
  transition: transform 0.18s var(--ease), box-shadow 0.18s var(--ease);
}
.cover.clickable:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
}
.cover.placeholder svg { width: 24px; height: 24px; }
.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.artist {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta.empty {
  font-size: 13px;
  color: var(--text-faint);
}

/* 中：控制按钮 */
.p-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
}
.ctrl {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  transition: color 0.15s, background 0.15s;
}
.ctrl:hover { color: var(--text); background: var(--bg-hover); }
.ctrl svg { width: 20px; height: 20px; }
.ctrl.sm {
  width: 28px;
  height: 28px;
  font-size: 14px;
}
.ctrl.sm svg { width: 16px; height: 16px; }
.ctrl.sm:hover { color: var(--accent); }
.ctrl.play {
  width: 44px;
  height: 44px;
  background: var(--accent);
  color: #fff;
}
.ctrl.play:hover { background: var(--accent-hover); color: #fff; }
.ctrl.play svg { width: 22px; height: 22px; }
.ctrl.active { color: var(--accent); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.time {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.time-divider { color: var(--text-faint); }

/* 右：歌词/下载/音量 */
.p-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 200px;
  justify-content: flex-end;
  padding-right: 26px; /* 音量条离右缘留白 */
}
.vol-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 全局下载进度指示器：环形进度 + 数量角标 */
.dl-indicator {
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  border-radius: 50%;
  transition: background 0.15s var(--ease), transform 0.15s var(--ease);
}
.dl-indicator:hover {
  background: var(--accent-dim);
  transform: scale(1.08);
}
.dl-ring {
  width: 26px;
  height: 26px;
  /* 进度环平滑推进；不加过渡会在每次 progress 事件时跳变 */
  transition: stroke-dashoffset 0.3s var(--ease-out);
}
.dl-count {
  position: absolute;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.vol-icon {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  transition: color 0.15s, background 0.15s;
}
.vol-icon:hover { color: var(--text); background: var(--bg-hover); }
.vol-icon.muted { color: var(--accent); }
.vol-icon svg { width: 16px; height: 16px; }
/* 音量条：视觉 4px 细条，热区用绝对定位伪元素上下各扩 6px。
   注意：项目全局 box-sizing: border-box，用 border 扩热区会把
   内容区高度压成 0（4px - 6px - 6px < 0）→ 整条不可见。
   伪元素不参与布局计算，是这里唯一安全的扩热区方式。 */
.volume {
  width: 96px;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  cursor: pointer;
  position: relative;
  transition: height 0.15s var(--ease);
  touch-action: none;
}
/* 透明热区：上下各 6px，命中范围 16px（不影响视觉与布局） */
.volume::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -6px;
  bottom: -6px;
}
.volume:hover,
.volume.dragging { height: 6px; }
.volume.dragging .volume-fill { background: var(--accent-hover); }
.volume.muted .volume-fill { background: var(--text-faint); }
.volume-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.1s;
}
.vol-tip {
  position: absolute;
  bottom: 12px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  pointer-events: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  transition: left 0.06s linear;
}

.hidden-audio { display: none; }
.play-error {
  position: absolute;
  top: -28px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 12px;
  white-space: nowrap;
}
</style>
