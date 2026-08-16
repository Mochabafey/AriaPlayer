<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, imgUrl } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'

const route = useRoute()
const player = usePlayerStore()
const loading = ref(true)
const album = ref(null)
const songs = ref([])

async function load() {
  loading.value = true
  album.value = null
  songs.value = []
  try {
    const d = await api('album', { id: route.params.id })
    album.value = d.album
    songs.value = d.songs || []
  } finally {
    loading.value = false
  }
}

onMounted(load)

watch(
  () => route.params.id,
  (id, old) => {
    if (id && id !== old) load()
  }
)
</script>

<template>
  <div class="album-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <template v-else-if="album">
      <div class="head">
        <div class="cover">
          <img :src="imgUrl(album.picUrl + '?param=300y300')" alt="" />
        </div>
        <div class="info">
          <h1>{{ album.name }}</h1>
          <div class="sub">歌手：{{ album.artist?.name }}</div>
          <div class="sub dim">{{ album.company }} · {{ album.publishTime ? new Date(album.publishTime).toLocaleDateString() : '' }}</div>
          <div class="actions">
            <button class="btn primary" :disabled="!songs.length" @click="player.playList(songs)">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
              播放专辑
            </button>
          </div>
          <p v-if="album.description" class="desc">{{ album.description }}</p>
        </div>
      </div>
      <div class="tabs">
        <span class="tab active">歌曲 <em>{{ songs.length }}</em></span>
      </div>
      <SongTable :songs="songs" />
    </template>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  gap: 28px;
  margin-bottom: 24px;
  padding: 24px;
  background: linear-gradient(135deg, #e8f4fd 0%, #f0f8ff 50%, #fafafa 100%);
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
  transition: transform 0.3s var(--ease);
}
.cover:hover img {
  transform: scale(1.04);
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
