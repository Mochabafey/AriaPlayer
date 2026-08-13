<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'

const route = useRoute()
const player = usePlayerStore()
const loading = ref(true)
const album = ref(null)
const songs = ref([])

onMounted(async () => {
  try {
    const d = await api('album', { id: route.params.id })
    album.value = d.album
    songs.value = d.songs || []
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="album-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <template v-else-if="album">
      <div class="head">
        <div class="cover">
          <img :src="album.picUrl + '?param=300y300'" alt="" />
        </div>
        <div class="info">
          <h1>{{ album.name }}</h1>
          <div class="sub">歌手：{{ album.artist?.name }}</div>
          <div class="sub dim">{{ album.company }} · {{ album.publishTime ? new Date(album.publishTime).toLocaleDateString() : '' }}</div>
          <div class="actions">
            <button class="btn" :disabled="!songs.length" @click="player.playList(songs)">▶ 播放专辑</button>
          </div>
          <p v-if="album.description" class="desc">{{ album.description }}</p>
        </div>
      </div>
      <SongTable :songs="songs" />
    </template>
  </div>
</template>

<style scoped>
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
}
.info h1 {
  font-size: 24px;
  margin-bottom: 10px;
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
