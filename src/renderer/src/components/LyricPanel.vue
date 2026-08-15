<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { usePlayerStore } from '../stores/player'
import { activeIndex } from '../utils/lrc'
import { imgUrl } from '../api'

const player = usePlayerStore()
const listRef = ref(null)

const active = computed(() => activeIndex(player.lyrics, player.currentTime))
const hasLyric = computed(() => player.lyrics.length > 0)

// 封面模糊背景（Apple Music 全屏风格）
const bgStyle = computed(() => {
  const pic = player.current?.pic
  return pic
    ? { backgroundImage: `url(${imgUrl(pic)})` }
    : {}
})

watch(active, async (idx) => {
  if (idx < 0 || !listRef.value) return
  await nextTick()
  const el = listRef.value.querySelector(`[data-idx="${idx}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
})

// 切歌后歌词数组被替换：若新旧 active 索引相同上面的 watch 不会触发，
// 需主动把列表滚回当前行，避免停留在上一首的滚动位置
watch(
  () => player.lyrics,
  async () => {
    await nextTick()
    if (!listRef.value) return
    const el = listRef.value.querySelector(`[data-idx="${active.value}"]`)
    if (el) el.scrollIntoView({ block: 'center' })
    else listRef.value.scrollTop = 0
  }
)
</script>

<template>
  <div class="lyric-panel">
    <div class="lyric-bg" :style="bgStyle"></div>
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
      <button class="close-btn" @click="player.showLyrics = false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
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
  background: #000;
  background-size: cover;
  background-position: center;
  filter: blur(60px) brightness(0.4) saturate(1.4);
  transform: scale(1.4);
}
.lyric-inner {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 72px;
  padding: 40px 8vw;
}
.left-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
}
.cover-large {
  width: 300px;
  height: 300px;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-lg);
}
.cover-large img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.track-info { text-align: center; }
.t-name { font-size: 18px; font-weight: 700; }
.t-artist { font-size: 14px; color: var(--text-dim); margin-top: 4px; }
.lyric-list {
  flex: 1;
  max-width: 560px;
  height: 420px;
  overflow-y: auto;
  scroll-behavior: smooth;
  mask-image: linear-gradient(180deg, transparent, #000 14%, #000 86%, transparent);
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 14%, #000 86%, transparent);
}
.lyric-line {
  text-align: center;
  font-size: 17px;
  line-height: 2.1;
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.3s var(--ease), font-size 0.3s var(--ease), font-weight 0.3s;
  cursor: pointer;
}
.lyric-line.active {
  color: #fff;
  font-size: 20px;
  font-weight: 700;
}
.no-lyric {
  text-align: center;
  color: var(--text-faint);
  margin-top: 60px;
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
  transition: background 0.15s, color 0.15s;
}
.close-btn svg { width: 15px; height: 15px; }
.close-btn:hover { background: rgba(255, 255, 255, 0.22); color: #fff; }
</style>
