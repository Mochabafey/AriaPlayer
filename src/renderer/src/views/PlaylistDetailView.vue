<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
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
</script>

<template>
  <div class="playlist-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <div v-else-if="notFound" class="placeholder">歌单不存在或加载失败</div>
    <template v-else-if="playlist">
      <div class="head">
        <div class="cover">
          <img :src="playlist.coverImgUrl + '?param=300y300'" alt="" />
        </div>
        <div class="info">
          <h1>{{ playlist.name }}</h1>
          <div class="sub">
            {{ playlist.creator?.nickname }} · 播放 {{ playlist.playCount }} · 收藏 {{ playlist.subscribedCount }}
          </div>
          <div class="sub dim">共 {{ playlist.trackCount }} 首</div>
          <div class="actions">
            <button class="btn" :disabled="!tracks.length" @click="player.playList(tracks)">▶ 播放全部</button>
            <button class="btn ghost" :disabled="!tracks.length" @click="player.enqueue(tracks)">加入队列</button>
          </div>
          <p v-if="playlist.description" class="desc">{{ playlist.description }}</p>
        </div>
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
  gap: 24px;
  margin-bottom: 22px;
}
.cover {
  width: 180px;
  height: 180px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: var(--shadow);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.info {
  flex: 1;
  min-width: 0;
  position: relative;
  z-index: 1;
}
.info h1 {
  font-size: 24px;
  margin-bottom: 10px;
  line-height: 1.3;
}
.sub {
  color: var(--text-dim);
  font-size: 13px;
  margin-bottom: 4px;
}
.sub.dim {
  color: var(--text-faint);
}
.actions {
  display: flex;
  gap: 10px;
  margin: 14px 0;
}
.desc {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}
</style>
