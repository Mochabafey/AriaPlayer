<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()
const loading = ref(true)
const artist = ref(null)
const hotSongs = ref([])
const albums = ref([])
const mvs = ref([])
const desc = ref('')

onMounted(async () => {
  try {
    const [d, descRes] = await Promise.allSettled([
      api('artist_detail', { id: route.params.id }),
      api('artist_desc', { id: route.params.id })
    ])
    if (d.status === 'fulfilled') artist.value = d.value.data?.artist
    if (descRes.status === 'fulfilled') desc.value = descRes.value.data?.briefDesc || ''
    const [hs, al, mv] = await Promise.allSettled([
      api('artist_top_song', { id: route.params.id }),
      api('artist_album', { id: route.params.id, limit: 12 }),
      api('artist_mv', { id: route.params.id, limit: 6 })
    ])
    if (hs.status === 'fulfilled') hotSongs.value = hs.value.songs || []
    if (al.status === 'fulfilled') albums.value = al.value.hotAlbums || []
    if (mv.status === 'fulfilled') mvs.value = mv.value.mvs || []
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="artist-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <template v-else-if="artist">
      <div class="head">
        <img :src="artist.picUrl + '?param=300y300'" class="avatar" alt="" />
        <div class="info">
          <h1>{{ artist.name }}</h1>
          <div class="sub">粉丝：{{ artist.fansCount || 0 }} · 歌曲 {{ artist.musicSize || 0 }} 首</div>
          <div class="actions">
            <button class="btn" :disabled="!hotSongs.length" @click="player.playList(hotSongs)">▶ 播放热门歌曲</button>
          </div>
          <p v-if="desc" class="desc">{{ desc }}</p>
        </div>
      </div>

      <section class="sec" v-if="hotSongs.length">
        <h2>热门歌曲</h2>
        <SongTable :songs="hotSongs" />
      </section>

      <section class="sec" v-if="albums.length">
        <h2>专辑</h2>
        <div class="grid">
          <div v-for="al in albums" :key="al.id" class="card" @click="router.push('/album/' + al.id)">
            <div class="cover">
              <img :src="al.picUrl + '?param=200y200'" alt="" loading="lazy" />
            </div>
            <div class="name">{{ al.name }}</div>
          </div>
        </div>
      </section>

      <section class="sec" v-if="mvs.length">
        <h2>MV</h2>
        <div class="grid">
          <div v-for="m in mvs" :key="m.id" class="card" @click="router.push('/mv/' + m.id)">
            <div class="cover">
              <img :src="m.cover + '?param=200y200'" alt="" loading="lazy" />
              <span class="play-badge">▶</span>
            </div>
            <div class="name">{{ m.name }}</div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  gap: 24px;
  margin-bottom: 26px;
}
.avatar {
  width: 160px;
  height: 160px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: var(--shadow);
}
.info h1 {
  font-size: 26px;
  margin-bottom: 8px;
}
.sub {
  color: var(--text-dim);
  font-size: 13px;
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
.sec {
  margin-bottom: 30px;
}
.sec h2 {
  font-size: 17px;
  margin-bottom: 14px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}
.card {
  cursor: pointer;
}
.cover {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--bg-card);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.play-badge {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.name {
  margin-top: 8px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}
</style>
