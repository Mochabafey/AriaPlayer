<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
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
  const next = map[settings.settings.playMode]
  settings.set('playMode', next)
}

const modeIcon = computed(() => ({ list: '▸▸', loop: '↻', shuffle: '⇄' })[settings.settings.playMode])

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
  <div class="player-bar" :class="{ playing: player.playing }">
    <audio ref="audioRef" preload="metadata" class="hidden-audio" />

    <div class="p-left">
      <div class="cover" v-if="player.current">
        <img :src="player.current.pic" alt="" loading="lazy" />
      </div>
      <div class="cover placeholder" v-else>♪</div>
      <div class="meta" v-if="player.current">
        <div class="title" :title="player.current.name">{{ player.current.name }}</div>
        <div class="artist">{{ player.current.artist }} · {{ player.current.album }}</div>
      </div>
      <div class="meta empty" v-else>未在播放</div>
    </div>

    <div class="p-center">
      <div class="controls">
        <button class="ctrl" title="上一首" @click="player.prev()">⏮</button>
        <button class="ctrl play" title="播放/暂停" @click="player.toggle()">
          {{ player.buffering ? '…' : player.playing ? '⏸' : '▶' }}
        </button>
        <button class="ctrl" title="下一首" @click="player.next()">⏭</button>
      </div>
      <div class="timeline">
        <span class="time">{{ fmtTime(player.currentTime) }}</span>
        <div class="progress" @click="onSeek">
          <div class="progress-fill" :style="{ width: progress + '%' }"></div>
        </div>
        <span class="time">{{ fmtTime(player.duration) }}</span>
      </div>
    </div>

    <div class="p-right">
      <button class="ctrl" :title="'播放模式：' + settings.settings.playMode" @click="cycleMode">
        {{ modeIcon }}
      </button>
      <button class="ctrl" :title="'歌词'" :class="{ active: player.showLyrics }" @click="player.showLyrics = !player.showLyrics">
        ≣
      </button>
      <button class="ctrl" title="下载当前歌曲" @click="downloadCurrent">⇩</button>
      <button class="ctrl" title="清空队列" @click="player.clearQueue()">✕</button>
      <div class="volume" @click="onVolume">
        <div class="volume-fill" :style="{ width: settings.settings.volume * 100 + '%' }"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-bar {
  position: fixed;
  left: var(--sidebar-w);
  right: 0;
  bottom: 0;
  height: var(--player-h);
  background: rgba(22, 22, 22, 0.94);
  backdrop-filter: blur(18px);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 22px;
  gap: 24px;
  z-index: 100;
}
.hidden-audio {
  display: none;
}
.p-left {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 300px;
  flex-shrink: 0;
}
.cover {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-card);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: cover-spin 22s linear infinite;
  animation-play-state: paused;
}
.player-bar.playing .cover img {
  animation-play-state: running;
}
.cover:hover img {
  animation-play-state: paused;
}
@keyframes cover-spin {
  from {
    transform: rotate(0);
  }
  to {
    transform: rotate(360deg);
  }
}
.cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--text-faint);
}
.meta {
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
  margin-top: 3px;
}
.meta.empty {
  color: var(--text-faint);
  font-size: 13px;
}
.p-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.controls {
  display: flex;
  align-items: center;
  gap: 18px;
}
.ctrl {
  font-size: 16px;
  color: var(--text-dim);
  transition: color 0.15s, transform 0.12s var(--ease);
  padding: 5px;
  line-height: 1;
  border-radius: 50%;
}
.ctrl:hover {
  color: var(--text);
  transform: scale(1.1);
}
.ctrl:active {
  transform: scale(0.92);
}
.ctrl.active {
  color: var(--accent);
}
.ctrl.play {
  width: 40px;
  height: 40px;
  font-size: 18px;
  color: #fff;
  background: var(--accent);
  box-shadow: 0 3px 12px rgba(236, 65, 65, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ctrl.play:hover {
  color: #fff;
  background: var(--accent-hover);
  transform: scale(1.08);
}
.timeline {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 560px;
}
.time {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  width: 40px;
  text-align: center;
}
.progress {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: #333;
  cursor: pointer;
  position: relative;
  transition: height 0.12s var(--ease);
}
.progress:hover {
  height: 7px;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  position: relative;
}
.progress-fill::after {
  content: '';
  position: absolute;
  right: -4px;
  top: 50%;
  transform: translateY(-50%);
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity 0.15s;
}
.progress:hover .progress-fill::after {
  opacity: 1;
}
.p-right {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 300px;
  flex-shrink: 0;
  justify-content: flex-end;
}
.volume {
  width: 80px;
  height: 5px;
  border-radius: 3px;
  background: #333;
  cursor: pointer;
  position: relative;
  transition: height 0.12s var(--ease);
}
.volume:hover {
  height: 7px;
}
.volume-fill {
  height: 100%;
  background: var(--text-dim);
  border-radius: 3px;
}
</style>
