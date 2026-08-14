<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { imgUrl } from '../api'
import { fmtTime } from '../utils/format'

const player = usePlayerStore()
const settings = useSettingsStore()
const audioRef = ref(null)

const progress = computed(() => {
  if (!player.duration) return 0
  return (player.currentTime / player.duration) * 100
})

function onSeek(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  player.seek(ratio * player.duration)
}

function onVolume(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  player.setVolume(ratio)
}

function cycleMode() {
  const map = { list: 'loop', loop: 'shuffle', shuffle: 'list' }
  settings.set('playMode', map[settings.settings.playMode])
}

const modeIcon = computed(() => ({ list: '▸▸', loop: '↻', shuffle: '⇄' })[settings.settings.playMode])
const modeTitle = computed(() => ({ list: '列表循环', loop: '单曲循环', shuffle: '随机播放' })[settings.settings.playMode])

function downloadCurrent() {
  const song = player.current
  if (!song || song.fromLocal) return
  window.ncm.invoke('ncm:download-add', {
    songId: song.id,
    title: song.name,
    artist: song.artist,
    url: song.audioUrl,
    quality: settings.settings.quality,
    cover: song.pic
  })
}

onMounted(() => {
  player.attachAudio(audioRef.value)
})
</script>

<template>
  <div class="player-bar glass" :class="{ playing: player.playing }">
    <audio ref="audioRef" preload="metadata" class="hidden-audio" />
    <div v-if="player.playError" class="play-error">{{ player.playError }}</div>

    <!-- 顶部进度条（全宽、hover 变粗） -->
    <div class="seek-track" @click="onSeek">
      <div class="seek-fill" :style="{ width: progress + '%' }"></div>
    </div>

    <!-- 左：封面 + 信息 -->
    <div class="p-left">
      <div class="cover" v-if="player.current">
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

    <!-- 中：控制 -->
    <div class="p-center">
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

    <!-- 右：模式/歌词/下载/音量 -->
    <div class="p-right">
      <button class="ctrl sm" :title="modeTitle" @click="cycleMode">{{ modeIcon }}</button>
      <button class="ctrl sm" title="歌词" :class="{ active: player.showLyrics }" @click="player.showLyrics = !player.showLyrics">≣</button>
      <button class="ctrl sm" title="下载当前歌曲" @click="downloadCurrent">⇩</button>
      <button class="ctrl sm" title="清空队列" @click="player.clearQueue()">✕</button>
      <div class="volume" @click="onVolume" title="音量">
        <div class="volume-fill" :style="{ width: settings.settings.volume * 100 + '%' }"></div>
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
  border-top: 1px solid var(--hairline);
  display: flex;
  align-items: center;
  padding: 0 20px;
  gap: 20px;
  z-index: 100;
}

/* 顶部全宽进度条 */
.seek-track {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: height 0.15s var(--ease);
}
.seek-track:hover { height: 6px; }
.seek-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 0 3px 3px 0;
  transition: width 0.1s linear;
}

.play-error {
  position: fixed;
  bottom: calc(var(--player-h) + 14px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(250, 36, 60, 0.95);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 8px;
  z-index: 200;
  max-width: 70vw;
  box-shadow: var(--shadow);
}
.hidden-audio { display: none; }

/* 左 */
.p-left {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 300px;
  flex-shrink: 0;
  min-width: 0;
}
.cover {
  width: 46px;
  height: 46px;
  border-radius: 7px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-card);
  box-shadow: var(--shadow-cover);
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
}
.cover.placeholder svg { width: 20px; height: 20px; }
.meta { min-width: 0; }
.title {
  font-size: 13px;
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
  margin-top: 2px;
}
.meta.empty { color: var(--text-faint); font-size: 13px; }

/* 中：控制 */
.p-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 22px;
}
.ctrl {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  padding: 6px;
  border-radius: 50%;
  transition: color 0.15s, transform 0.1s var(--ease);
}
.ctrl:hover { color: var(--text); }
.ctrl:active { transform: scale(0.92); }
.ctrl svg { width: 20px; height: 20px; }
.ctrl.sm { font-size: 15px; }
.ctrl.active { color: var(--accent); }
.ctrl.play {
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
  transition: background 0.15s, transform 0.1s var(--ease);
}
.ctrl.play:hover { background: rgba(255, 255, 255, 0.18); }
.ctrl.play svg { width: 20px; height: 20px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.time {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.time-divider { color: var(--text-faint); font-size: 11px; }

/* 右 */
.p-right {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 300px;
  flex-shrink: 0;
  justify-content: flex-end;
}
.volume {
  width: 78px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.14);
  cursor: pointer;
  transition: height 0.12s var(--ease);
}
.volume:hover { height: 6px; }
.volume-fill {
  height: 100%;
  background: var(--text-dim);
  border-radius: 2px;
}
.volume:hover .volume-fill { background: #fff; }
</style>
