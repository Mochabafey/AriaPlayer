<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, imgUrl } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'
import { fmtCount } from '../utils/format'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()

const keyword = ref('')
const tab = ref('songs')
const results = ref({ songs: [], playlists: [], artists: [], albums: [], mvs: [] })
const fetchedTabs = ref({})
const loading = ref(false)
const tabLoading = ref(false)
const searched = ref(false)

const tabs = [
  { key: 'songs', label: '歌曲' },
  { key: 'playlists', label: '歌单' },
  { key: 'artists', label: '歌手' },
  { key: 'albums', label: '专辑' },
  { key: 'mvs', label: 'MV' }
]

const types = { songs: 1, playlists: 1000, artists: 100, albums: 10, mvs: 1004 }

/** 拉取某个类型的搜索结果并缓存 */
async function fetchTab(key, kw) {
  const res = await api('cloudsearch', { keywords: kw, type: types[key], limit: 20 })
  results.value[key] = res.result?.[key] || []
  fetchedTabs.value[key] = true
}

async function doSearch(kw = keyword.value) {
  kw = (kw || '').trim()
  if (!kw) return
  keyword.value = kw
  loading.value = true
  searched.value = true
  tab.value = 'songs'
  results.value = { songs: [], playlists: [], artists: [], albums: [], mvs: [] }
  fetchedTabs.value = {}
  try {
    // 只请求当前 tab，其余 tab 点击时再懒加载（减少接口压力）
    await fetchTab('songs', kw)
  } catch {
    results.value.songs = []
  } finally {
    loading.value = false
  }
}

/** 切换 tab：未拉取过则懒加载 */
async function switchTab(key) {
  tab.value = key
  if (fetchedTabs.value[key] || !searched.value) return
  tabLoading.value = true
  try {
    await fetchTab(key, keyword.value)
  } catch {
    results.value[key] = []
  } finally {
    tabLoading.value = false
  }
}

onMounted(() => {
  const q = route.query.q
  if (q) {
    keyword.value = q
    doSearch(q)
  }
})

// 已在 /search 页时侧边栏再次搜索只改 query，组件复用不会重新 mount，需监听
watch(
  () => route.query.q,
  (q) => {
    if (q && q !== keyword.value) {
      keyword.value = q
      doSearch(q)
    }
  }
)

function goPlaylist(id) {
  router.push('/playlist/' + id)
}
function goArtist(id) {
  router.push('/artist/' + id)
}
function goAlbum(id) {
  router.push('/album/' + id)
}
function goMv(id) {
  router.push('/mv/' + id)
}
</script>

<template>
  <div class="search-view">
    <h1 class="page-title">搜索</h1>
    <div class="input-row">
      <input v-model="keyword" class="input" placeholder="搜索歌曲 / 歌单 / 歌手 / 专辑 / MV" @keyup.enter="doSearch()" />
      <button class="btn" :disabled="loading" @click="doSearch()">{{ loading ? '搜索中…' : '搜索' }}</button>
    </div>

    <div v-if="searched" class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: tab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}<span v-if="fetchedTabs[t.key]" class="tab-count">({{ results[t.key]?.length || 0 }})</span>
      </button>
    </div>

    <div class="content-area">
      <p v-if="tabLoading" class="empty">加载中…</p>

      <!-- 歌曲 -->
      <SongTable v-else-if="tab === 'songs'" :songs="results.songs || []" />

      <!-- 歌单 -->
      <div v-else-if="tab === 'playlists'" class="grid">
        <div v-for="p in results.playlists" :key="p.id" class="playlist-card" @click="goPlaylist(p.id)">
          <div class="cover-wrap">
            <img :src="imgUrl(p.coverImgUrl + '?param=300y300')" alt="" loading="lazy" />
            <div class="play-count">▶ {{ fmtCount(p.playCount) }}</div>
          </div>
          <div class="name">{{ p.name }}</div>
        </div>
      </div>

      <!-- 歌手 -->
      <div v-else-if="tab === 'artists'" class="grid">
        <div v-for="a in results.artists" :key="a.id" class="playlist-card" @click="goArtist(a.id)">
          <div class="cover-wrap round">
            <img :src="imgUrl(a.picUrl + '?param=300y300')" alt="" loading="lazy" />
          </div>
          <div class="name">{{ a.name }}</div>
        </div>
      </div>

      <!-- 专辑 -->
      <div v-else-if="tab === 'albums'" class="grid">
        <div v-for="al in results.albums" :key="al.id" class="playlist-card" @click="goAlbum(al.id)">
          <div class="cover-wrap">
            <img :src="imgUrl(al.picUrl + '?param=300y300')" alt="" loading="lazy" />
          </div>
          <div class="name">{{ al.name }}</div>
        </div>
      </div>

      <!-- MV -->
      <div v-else-if="tab === 'mvs'" class="grid">
        <div v-for="m in results.mvs" :key="m.id" class="playlist-card" @click="goMv(m.id)">
          <div class="cover-wrap">
            <img :src="imgUrl(m.cover + '?param=300y300')" alt="" loading="lazy" />
            <div class="play-count">▶ {{ m.playCount }}</div>
          </div>
          <div class="name">{{ m.name }}</div>
        </div>
      </div>

      <p v-if="searched && !loading && !tabLoading && !(results[tab] || []).length" class="empty">没有找到相关内容</p>
    </div>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin-bottom: 18px;
}
.input-row {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
  max-width: 720px;
}
.input-row .input {
  flex: 1;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.tab {
  padding: 8px 16px;
  color: var(--text-dim);
  font-size: 13px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.tab-count {
  font-size: 11px;
  color: var(--text-faint);
  margin-left: 4px;
}
.tab.active .tab-count { color: var(--accent); }
.content-area {
  min-height: 200px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}
.playlist-card {
  cursor: pointer;
}
.cover-wrap {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  transition: transform 0.25s var(--ease), box-shadow 0.25s var(--ease);
}
.cover-wrap.round img {
  border-radius: 50%;
}
.cover-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s var(--ease);
}
.playlist-card:hover .cover-wrap {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}
.playlist-card:hover .cover-wrap img {
  transform: scale(1.06);
}
.play-count {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 11px;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}
.name {
  margin-top: 8px;
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.empty {
  color: var(--text-faint);
  text-align: center;
  padding: 40px 0;
}
</style>
