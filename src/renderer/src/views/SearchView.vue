<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, imgUrl, qqmusic } from '../api'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import SongTable from '../components/SongTable.vue'
import { fmtCount } from '../utils/format'
import { mergeSearchResults } from '../utils/mergeSongs'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()
const settings = useSettingsStore()

const keyword = ref('')
const tab = ref('songs')
const results = ref({ songs: [], playlists: [], artists: [], albums: [], mvs: [] })
const fetchedTabs = ref({})
const loading = ref(false)
const tabLoading = ref(false)
const searched = ref(false)
// 各类型真实结果总数（cloudsearch 返回的 *Count，比数组长度更全）
const counts = ref({})
const countKeys = { songs: 'songCount', playlists: 'playlistCount', artists: 'artistCount', albums: 'albumCount', mvs: 'mvCount' }
// 无限滚动分页状态
const offsets = ref({})
// 各 tab 网易云原始已加载数（songs tab 合并 QQ 后 length 会变，分页用它）
const neLoaded = ref({})
const hasMore = ref({})
const loadingMore = ref(false)
// 滚动预加载阈值（px）：滑到距底部还有这么多就提前拉下一页
const PRELOAD_PX = 400

const tabs = [
  { key: 'songs', label: '歌曲' },
  { key: 'playlists', label: '歌单' },
  { key: 'artists', label: '歌手' },
  { key: 'albums', label: '专辑' },
  { key: 'mvs', label: 'MV' }
]

const types = { songs: 1, playlists: 1000, artists: 100, albums: 10, mvs: 1004 }

/** 拉取某个类型的搜索结果并缓存（limit 100：一次拿全，避免 20 条太少） */
async function fetchTab(key, kw) {
  const res = await api('cloudsearch', { keywords: kw, type: types[key], limit: 100, offset: 0 })
  results.value[key] = res.result?.[key] || []
  const ck = countKeys[key]
  if (ck && res.result?.[ck] != null) counts.value[key] = res.result[ck]
  offsets.value[key] = results.value[key].length
  neLoaded.value[key] = results.value[key].length
  hasMore.value[key] = (counts.value[key] ?? results.value[key].length) > results.value[key].length
  fetchedTabs.value[key] = true
}

/** 搜索 QQ 音乐（仅歌曲），与网易云结果合并 */
async function fetchQqMusic(kw) {
  try {
    const res = await qqmusic.search(kw, 1, 30)
    return res?.songs || []
  } catch (e) {
    console.error('[qqmusic-search] error:', e)
    return []
  }
}

/** 无限滚动：滑近底部时追加下一页（cloudsearch offset 分页，每页 100） */
async function loadMore() {
  const key = tab.value
  if (!fetchedTabs.value[key] || !hasMore.value[key] || loadingMore.value) return
  loadingMore.value = true
  try {
    const res = await api('cloudsearch', {
      keywords: keyword.value,
      type: types[key],
      limit: 100,
      // 分页 offset 用网易云原始已加载数（songs tab 已合并 QQ 结果，
      // 不能拿合并后的 length 当 offset，否则重复/遗漏）
      offset: neLoaded.value[key] || 0
    })
    const more = res.result?.[key] || []
    results.value[key] = [...results.value[key], ...more]
    neLoaded.value[key] = (neLoaded.value[key] || 0) + more.length
    const ck = countKeys[key]
    hasMore.value[key] = (res.result?.[ck] ?? neLoaded.value[key]) > neLoaded.value[key]
  } catch { /* 翻页失败静默，下次滚动重试 */ } finally {
    loadingMore.value = false
  }
}

function onScroll() {
  const sc = document.querySelector('.content')
  if (!sc) return
  // 预加载：距底部还差 PRELOAD_PX 就提前拉下一页，用户滑到之前数据已就绪
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - PRELOAD_PX) loadMore()
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
  counts.value = {}
  offsets.value = {}
  neLoaded.value = {}
  hasMore.value = {}
  try {
    // 并行拉取所有类型 + QQ音乐搜索
    const tasks = Object.keys(types).map((k) => fetchTab(k, kw))
    const qqPromise = fetchQqMusic(kw)
    await Promise.allSettled(tasks)
    const qqSongs = await qqPromise
    // 合并双源结果（同名折叠，未匹配各自保留）
    if (qqSongs.length) {
      const { merged, unmatched } = mergeSearchResults(results.value.songs, qqSongs)
      results.value.songs = [...merged, ...unmatched]
    }
    // 歌曲为空时自动切到第一个有结果的类型（如歌单）
    if (!results.value.songs.length) {
      const first = tabs.find((t) => t.key !== 'songs' && results.value[t.key]?.length)
      if (first) tab.value = first.key
    }
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
  // 无限滚动：监听内容滚动容器，滑近底部自动加载更多
  const sc = document.querySelector('.content')
  sc?.addEventListener('scroll', onScroll, { passive: true })
})

onUnmounted(() => {
  document.querySelector('.content')?.removeEventListener('scroll', onScroll)
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
        {{ t.label }}<span v-if="fetchedTabs[t.key]" class="tab-count">({{ counts[t.key] ?? (results[t.key]?.length || 0) }})</span>
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

      <!-- 无限滚动：滑近底部自动加载更多 -->
      <p v-if="searched && !loading && !tabLoading && hasMore[tab] && (results[tab] || []).length" class="load-more">
        {{ loadingMore ? '加载中…' : '继续下滑加载更多' }}
      </p>
      <p v-else-if="searched && !loading && !tabLoading && (results[tab] || []).length" class="load-more done">
        已加载全部 {{ counts[tab] ?? results[tab].length }} 条
      </p>
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
.load-more {
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
  padding: 18px 0 8px;
}
.load-more.done {
  color: var(--text-dim);
}
</style>
