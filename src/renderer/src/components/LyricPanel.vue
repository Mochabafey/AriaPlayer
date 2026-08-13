<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { usePlayerStore } from '../stores/player'
import { activeIndex } from '../utils/lrc'

const player = usePlayerStore()
const listRef = ref(null)

const active = computed(() => activeIndex(player.lyrics, player.currentTime))
const hasLyric = computed(() => player.lyrics.length > 0)

watch(active, async (idx) => {
  if (idx < 0 || !listRef.value) return
  await nextTick()
  const el = listRef.value.querySelector(`[data-idx="${idx}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
})
</script>

<template>
  <div class="lyric-panel">
    <div class="lyric-bg"></div>
    <div class="lyric-inner">
      <div class="cover-large" v-if="player.current">
        <img :src="player.current.pic" alt="" />
      </div>
      <div class="lyric-list" ref="listRef">
        <p v-if="!hasLyric" class="no-lyric">暂无歌词</p>
        <template v-else>
          <p
            v-for="(line, i) in player.lyrics"
            :key="i"
            :data-idx="i"
            class="lyric-line"
            :class="{ active: i === active }"
          >
            {{ line.text || '♪' }}
          </p>
        </template>
      </div>
      <button class="close-btn" @click="player.showLyrics = false">✕</button>
    </div>
  </div>
</template>

<style scoped>
.lyric-panel {
  position: fixed;
  inset: 0;
  z-index: 200;
}
.lyric-bg {
  position: absolute;
  inset: 0;
  background: rgba(10, 10, 12, 0.88);
  backdrop-filter: blur(24px);
}
.lyric-inner {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 64px;
  padding: 40px 8vw;
}
.cover-large {
  width: 300px;
  height: 300px;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: var(--shadow);
  flex-shrink: 0;
}
.cover-large img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: spin-slow 30s linear infinite;
}
@keyframes spin-slow {
  to {
    transform: rotate(360deg);
  }
}
.lyric-list {
  flex: 1;
  max-width: 520px;
  height: 380px;
  overflow-y: auto;
  scroll-behavior: smooth;
  mask-image: linear-gradient(180deg, transparent, #000 12%, #000 88%, transparent);
}
.lyric-line {
  text-align: center;
  font-size: 16px;
  line-height: 2.1;
  color: var(--text-faint);
  transition: color 0.25s, font-size 0.25s, transform 0.25s;
  cursor: pointer;
}
.lyric-line.active {
  color: var(--text);
  font-size: 19px;
  font-weight: 600;
}
.no-lyric {
  text-align: center;
  color: var(--text-faint);
  margin-top: 60px;
}
.close-btn {
  position: absolute;
  top: 28px;
  right: 32px;
  font-size: 18px;
  color: var(--text-dim);
  padding: 8px;
}
.close-btn:hover {
  color: var(--text);
}
</style>
