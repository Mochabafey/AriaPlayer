<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, imgUrl, waitServerReady } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'
import { toast } from '../utils/toast'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()

const loading = ref(true)
const playlists = ref([])
const songs = ref([])

// 各类型加载器：playlists=推荐歌单, newsongs=新歌速递
const meta = {
  playlists: {
    title: '推荐歌单',
    load: async () => {
      // 优先每日推荐歌单（每天更新），失败/空回退猜你喜欢
      try {
        const r = await api('recommend_resource', { timestamp: Date.now() })
        const list = r.recommend || r.result || []
        if (list.length) return list
      } catch { /* fallthrough */ }
      const p = await api('personalized', { limit: 100, timestamp: Date.now() })
      return p.result || []
    },
    apply: (v) => (playlists.value = v)
  },
  newsongs: {
    title: '新歌速递',
    load: () => api('personalized_newsong', { limit: 100 }).then((r) => (r.result || []).map((x) => x.song || x)),
    apply: (v) => (songs.value = v)
  }
}

const type = ref(meta[route.params.type] ? route.params.type : 'playlists')
const title = computed(() => meta[type.value]?.title || '更多')

async function load() {
  loading.value = true
  try {
    const m = meta[type.value]
    if (!m) return
    m.apply(await m.load())
  } catch (e) {
    toast('加载失败：' + (e.message || '未知错误'), 'error')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!(await waitServerReady())) {
    loading.value = false
    return
  }
  load()
})

watch(
  () => route.params.type,
  (t) => {
    if (meta[t]) {
      type.value = t
      load()
    }
  }
)

function playPlaylist(p) {
  api('playlist_track_all', { id: p.id, limit: 1000 })
    .then((d) => {
      const list = d.songs || []
      if (list.length) player.playList(list)
      else toast('歌单曲目为空')
    })
    .catch((e) => toast('播放失败：' + e.message, 'error'))
}
</script>

<template>
  <div class="more-view">
    <div class="page-head">
      <button class="back-btn" @click="router.back()">‹</button>
      <h1 class="page-title">{{ title }}</h1>
      <span class="count" v-if="type === 'playlists' && playlists.length">{{ playlists.length }} 个</span>
      <span class="count" v-else-if="type === 'newsongs' && songs.length">{{ songs.length }} 首</span>
    </div>

    <div v-if="loading" class="placeholder">加载中…</div>

    <!-- 推荐歌单：网格 -->
    <div v-else-if="type === 'playlists'" class="grid">
      <div
        v-for="p in playlists"
        :key="p.id"
        class="playlist-card"
        @click="router.push('/playlist/' + p.id)"
      >
        <div class="cover-wrap">
          <img :src="imgUrl((p.picUrl || p.coverImgUrl) + '?param=300y300')" alt="" loading="lazy" />
          <div class="play-float" @click.stop="playPlaylist(p)">▶</div>
        </div>
        <div class="name">{{ p.name }}</div>
      </div>
    </div>

    <!-- 新歌速递：歌曲表 -->
    <SongTable v-else-if="type === 'newsongs'" :songs="songs" />

    <p v-else-if="!loading" class="placeholder">暂无内容</p>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 20px;
}
.back-btn {
  font-size: 26px;
  line-height: 1;
  color: var(--text-dim);
  padding: 2px 10px 2px 0;
  transition: color 0.15s;
}
.back-btn:hover {
  color: var(--accent);
}
.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
}
.count {
  font-size: 13px;
  color: var(--text-faint);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
}
.playlist-card {
  cursor: pointer;
}
.cover-wrap {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--bg-card);
  box-shadow: var(--shadow-cover);
  transition: transform 0.3s var(--ease-spring), box-shadow 0.3s var(--ease);
}
.cover-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.35s var(--ease-out);
}
.playlist-card:hover .cover-wrap {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}
.playlist-card:hover .cover-wrap img {
  transform: scale(1.05);
}
.play-float {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(30, 30, 32, 0.75);
  backdrop-filter: blur(12px);
  color: #fff;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  opacity: 0;
  transform: translateY(6px) scale(0.9);
  transition: opacity 0.2s var(--ease), transform 0.25s var(--ease-spring);
}
.playlist-card:hover .play-float {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.play-float:hover {
  background: var(--accent);
}
.name {
  margin-top: 9px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.placeholder {
  color: var(--text-faint);
  padding: 40px 0;
  text-align: center;
}
</style>
