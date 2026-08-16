<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, imgUrl } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'

const route = useRoute()
const player = usePlayerStore()
const loading = ref(true)
const playlist = ref(null)
const tracks = ref([])
const notFound = ref(false)

let timer = null

async function load() {
  loading.value = true
  notFound.value = false
  playlist.value = null
  tracks.value = []
  try {
    const d = await api('playlist_detail', { id: route.params.id })
    if (!d.playlist) throw new Error('not found')
    playlist.value = d.playlist
    tracks.value = d.playlist.tracks || []
  } catch {
    notFound.value = true
  } finally {
    loading.value = false
  }
}

async function loadAll() {
  if (!playlist.value) return
  const total = playlist.value.trackCount || tracks.value.length
  if (tracks.value.length >= total) return
  try {
    const d = await api('playlist_track_all', { id: route.params.id, limit: 1000 })
    const t = d.songs || []
    if (t.length) {
      tracks.value = t
      playlist.value.trackCount = t.length
    }
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  load().then(loadAll)
  timer = setInterval(() => {
    if (playlist.value && tracks.value.length === 0) loadAll()
  }, 3000)
  setTimeout(() => clearInterval(timer), 30000)
})
onUnmounted(() => clearInterval(timer))

watch(
  () => route.params.id,
  (id, old) => {
    if (id && id !== old) load().then(loadAll)
  }
)
</script>

<template>
  <div class="playlist-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <div v-else-if="notFound" class="placeholder">歌单不存在或加载失败</div>
    <template v-else-if="playlist">
      <div class="head">
        <div class="cover">
          <img :src="imgUrl(playlist.coverImgUrl + '?param=300y300')" alt="" />
        </div>
        <div class="info">
          <h1>{{ playlist.name }}</h1>
          <div class="sub">
            {{ playlist.creator?.nickname }} · 播放 {{ playlist.playCount }} · 收藏 {{ playlist.subscribedCount }}
          </div>
          <div class="sub dim">共 {{ playlist.trackCount }} 首</div>
          <div class="actions">
            <button class="btn primary" :disabled="!tracks.length" @click="player.playList(tracks)">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
              播放全部
            </button>
            <button class="btn ghost" :disabled="!tracks.length" @click="player.enqueue(tracks)">加入队列</button>
          </div>
          <p v-if="playlist.description" class="desc">{{ playlist.description }}</p>
        </div>
      </div>
      <div class="tabs">
        <span class="tab active">歌曲 <em>{{ tracks.length }}</em></span>
        <span class="tab">评论</span>
        <span class="tab">收藏者</span>
      </div>
      <SongTable :songs="tracks" />
      <p v-if="tracks.length === 0" class="placeholder">歌单曲目加载中或为空…</p>
    </template>
  </div>
</template>

<style scoped>
.playlist-detail {
  position: relative;
}
.head {
  display: flex;
  gap: 28px;
  margin-bottom: 24px;
  padding: 24px;
  background: linear-gradient(135deg, #ffe4e8 0%, #fff0f2 50%, #fafafa 100%);
  border-radius: var(--radius-lg);
}
.cover {
  width: 180px;
  height: 180px;
  border-radius: var(--radius);
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: var(--shadow-lg);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.info h1 {
  font-size: 26px;
  font-weight: 700;
  margin-bottom: 12px;
  line-height: 1.3;
  color: var(--text);
}
.sub {
  color: var(--text-dim);
  font-size: 13px;
  margin-bottom: 6px;
}
.sub.dim {
  color: var(--text-faint);
}
.actions {
  display: flex;
  gap: 12px;
  margin: 16px 0;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 24px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  transition: all 0.18s var(--ease);
}
.btn.primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 4px 12px var(--accent-glow);
}
.btn.primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 6px 16px var(--accent-glow);
}
.btn.ghost {
  background: rgba(0, 0, 0, 0.06);
  color: var(--text);
}
.btn.ghost:hover {
  background: rgba(0, 0, 0, 0.1);
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.desc {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 8px;
}
.tabs {
  display: flex;
  gap: 24px;
  padding: 0 8px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.tab {
  padding: 10px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.tab em {
  font-style: normal;
  font-size: 12px;
  margin-left: 2px;
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.tab:hover {
  color: var(--text);
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}
</style>
