<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, imgUrl, qqmusic } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'
import { fmtCount } from '../utils/format'
import { PLATFORM_LOGOS } from '../utils/mergeSongs'
import { toast } from '../utils/toast'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()

// 平台切换：默认网易云，可切 QQ 音乐（两区块不再上下堆叠）
const activePlat = ref('ne')
// 各平台已加载结果总数（切换按钮上的计数）
const neTotal = computed(() => Object.values(neResults.value).reduce((a, b) => a + (b?.length || 0), 0))
const qqTotal = computed(() => Object.values(qqResults.value).reduce((a, b) => a + (b?.length || 0), 0))
const keyword = ref('')
// 平台分区：网易云 / QQ音乐 两个大区块，各自独立类型子分组（综合为默认）
const neTab = ref('all')
const qqTab = ref('all')
const neResults = ref({ songs: [], playlists: [], artists: [], albums: [], mvs: [] })
const qqResults = ref({ songs: [], artists: [], albums: [], mvs: [] })
// 各类型真实结果总数（cloudsearch 返回的 *Count，比数组长度更全）
const neCounts = ref({})
const countKeys = { songs: 'songCount', playlists: 'playlistCount', artists: 'artistCount', albums: 'albumCount', mvs: 'mvCount' }
// 网易云分页状态（QQ 音乐一次拉全，不分页）
const neLoaded = ref({})
const neHasMore = ref({})
const loadingMore = ref(false)
// QQ 分页状态（搜索接口单页上限 60，超出可翻页）
const qqPage = ref(1)
const qqHasMore = ref(false)
const qqLoadingMore = ref(false)
const loading = ref(false)
const searched = ref(false)
// 滚动预加载阈值（px）：滑到距底部还有这么多就提前拉下一页
const PRELOAD_PX = 400

const tabs = [
  { key: 'all', label: '综合' },
  { key: 'songs', label: '歌曲' },
  { key: 'playlists', label: '歌单' },
  { key: 'artists', label: '歌手' },
  { key: 'albums', label: '专辑' },
  { key: 'mvs', label: 'MV' }
]
// QQ 无歌单来源（smartbox 只聚合歌手/专辑/MV）
const qqTabs = tabs.filter((t) => t.key !== 'playlists')
const types = { songs: 1, playlists: 1000, artists: 100, albums: 10, mvs: 1004 }

/** 拉取网易云某个类型（limit 100：一次拿全，避免 20 条太少） */
async function fetchNeTab(key, kw) {
  const res = await api('cloudsearch', { keywords: kw, type: types[key], limit: 100, offset: 0 })
  neResults.value[key] = res.result?.[key] || []
  const ck = countKeys[key]
  if (ck && res.result?.[ck] != null) neCounts.value[key] = res.result[ck]
  neLoaded.value[key] = neResults.value[key].length
  neHasMore.value[key] = (neCounts.value[key] ?? neResults.value[key].length) > neResults.value[key].length
}

/** 拉取 QQ 音乐：歌曲列表（单页上限 60，支持翻页）+ smartbox 聚合（歌手/专辑/MV），与网易云完全独立 */
async function fetchQq(kw) {
  try {
    const [sr, sb] = await Promise.allSettled([qqmusic.search(kw, 1, 60), qqmusic.smartbox(kw)])
    const songs = sr.status === 'fulfilled' ? sr.value?.songs || [] : []
    const box = sb.status === 'fulfilled' ? sb.value || {} : {}
    qqResults.value = { songs, artists: box.artists || [], albums: box.albums || [], mvs: box.mvs || [] }
    qqPage.value = 1
    // 单页拉满 60 说明大概率还有更多，允许下滑翻页
    qqHasMore.value = songs.length >= 60
  } catch (e) {
    console.error('[qqmusic-search] error:', e)
    qqResults.value = { songs: [], artists: [], albums: [], mvs: [] }
    qqHasMore.value = false
  }
}

/** QQ 音乐翻页：追加下一页（每页 60，按 songmid 去重） */
async function loadMoreQq() {
  if (!searched.value || !qqHasMore.value || qqLoadingMore.value) return
  qqLoadingMore.value = true
  try {
    const next = qqPage.value + 1
    const res = await qqmusic.search(keyword.value, next, 60)
    const more = res?.songs || []
    const seen = new Set(qqResults.value.songs.map((s) => s.id))
    const fresh = more.filter((s) => s.id && !seen.has(s.id))
    qqResults.value = { ...qqResults.value, songs: [...qqResults.value.songs, ...fresh] }
    qqPage.value = next
    qqHasMore.value = more.length >= 60
  } catch { /* 翻页失败静默，下次滚动重试 */ } finally {
    qqLoadingMore.value = false
  }
}

/** 网易云无限滚动：滑近底部追加下一页（offset 分页，每页 100） */
async function loadMoreNe() {
  const key = neTab.value
  if (!searched.value || !neHasMore.value[key] || loadingMore.value) return
  loadingMore.value = true
  try {
    const res = await api('cloudsearch', {
      keywords: keyword.value,
      type: types[key],
      limit: 100,
      offset: neLoaded.value[key] || 0
    })
    const more = res.result?.[key] || []
    neResults.value[key] = [...neResults.value[key], ...more]
    neLoaded.value[key] = (neLoaded.value[key] || 0) + more.length
    const ck = countKeys[key]
    neHasMore.value[key] = (res.result?.[ck] ?? neLoaded.value[key]) > neLoaded.value[key]
  } catch { /* 翻页失败静默，下次滚动重试 */ } finally {
    loadingMore.value = false
  }
}

function onScroll() {
  const sc = document.querySelector('.content')
  if (!sc) return
  if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - PRELOAD_PX) return
  // 按当前激活平台分流：网易云分页 / QQ 翻页
  if (activePlat.value === 'ne') loadMoreNe()
  else if (activePlat.value === 'qq') loadMoreQq()
}

async function doSearch(kw = keyword.value) {
  kw = (kw || '').trim()
  if (!kw) return
  keyword.value = kw
  loading.value = true
  searched.value = true
  activePlat.value = 'ne'
  neTab.value = 'all'
  qqTab.value = 'all'
  neResults.value = { songs: [], playlists: [], artists: [], albums: [], mvs: [] }
  qqResults.value = { songs: [], artists: [], albums: [], mvs: [] }
  neCounts.value = {}
  neLoaded.value = {}
  neHasMore.value = {}
  try {
    // 并行拉取：网易云全类型（all 为聚合视图，不单独请求）+ QQ（歌曲 + smartbox 聚合），互不合并
    const fetchTabs = tabs.filter((t) => t.key !== 'all')
    await Promise.all([Promise.allSettled(fetchTabs.map((t) => fetchNeTab(t.key, kw))), fetchQq(kw)])
  } finally {
    loading.value = false
  }
}

function tabLabel(key) {
  return tabs.find((t) => t.key === key)?.label || key
}

onMounted(() => {
  const q = route.query.q
  if (q) {
    keyword.value = q
    doSearch(q)
  }
  // 无限滚动：监听内容滚动容器，滑近底部自动加载网易云下一页
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
/** QQ 非歌曲卡片点击：详情页暂未接入 QQ 源，提示即可 */
function onQqCardClick(item) {
  if (item?.source === 'qq') toast('QQ 音乐详情页暂未接入，歌曲可在「歌曲」中播放')
}
</script>

<template>
  <div class="search-view">
    <h1 class="page-title">搜索</h1>
    <div class="input-row">
      <input v-model="keyword" class="input" placeholder="搜索歌曲 / 歌单 / 歌手 / 专辑 / MV" @keyup.enter="doSearch()" />
      <button class="btn" :disabled="loading" @click="doSearch()">{{ loading ? '搜索中…' : '搜索' }}</button>
    </div>

    <p v-if="loading" class="empty">搜索中…</p>

    <template v-else-if="searched">
      <!-- 平台切换器：网易云 / QQ音乐 -->
      <div class="plat-switch">
        <button
          class="plat-sw-btn ne"
          :class="{ active: activePlat === 'ne' }"
          @click="activePlat = 'ne'"
        >
          <span class="sw-logo" v-html="PLATFORM_LOGOS.netease"></span>
          <span class="sw-name">网易云音乐</span>
          <span class="sw-count">{{ neTotal }}</span>
        </button>
        <button
          class="plat-sw-btn qq"
          :class="{ active: activePlat === 'qq' }"
          @click="activePlat = 'qq'"
        >
          <span class="sw-logo" v-html="PLATFORM_LOGOS.qq"></span>
          <span class="sw-name">QQ音乐</span>
          <span class="sw-count">{{ qqTotal }}</span>
        </button>
      </div>

      <!-- ==================== 网易云音乐 区块 ==================== -->
      <section v-if="activePlat === 'ne'" class="plat-block ne-block">
        <div class="plat-head">
          <span class="plat-logo" v-html="PLATFORM_LOGOS.netease"></span>
          <h2 class="plat-title">网易云音乐</h2>
        </div>
        <div class="sub-tabs">
          <button
            v-for="t in tabs"
            :key="'ne-' + t.key"
            class="sub-tab"
            :class="{ active: neTab === t.key }"
            @click="neTab = t.key"
          >
            {{ t.label }}<span v-if="neCounts[t.key] != null" class="sub-count">({{ neCounts[t.key] }})</span>
          </button>
        </div>

        <!-- 网易云：综合（单曲优先 + 歌手/歌单/专辑/MV 横滑，模仿音乐平台排版） -->
        <template v-if="neTab === 'all'">
          <!-- 单曲列表 -->
          <div class="mix-head">
            <h3 class="mix-title">单曲</h3>
            <button class="mix-more" @click="neTab = 'songs'">查看全部{{ neCounts.songs != null ? ' (' + neCounts.songs + ')' : '' }}</button>
          </div>
          <SongTable v-if="neResults.songs.length" :songs="neResults.songs.slice(0, 8)" :show-album="false" />

          <!-- 歌手横滑 -->
          <template v-if="neResults.artists.length">
            <div class="mix-head">
              <h3 class="mix-title">歌手</h3>
              <button class="mix-more" @click="neTab = 'artists'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="a in neResults.artists.slice(0, 15)" :key="a.id" class="h-card round" @click="goArtist(a.id)">
                <div class="cover-wrap">
                  <img :src="imgUrl((a.picUrl || '') + '?param=300y300')" alt="" loading="lazy" />
                </div>
                <div class="name">{{ a.name }}</div>
              </div>
            </div>
          </template>

          <!-- 歌单横滑 -->
          <template v-if="neResults.playlists.length">
            <div class="mix-head">
              <h3 class="mix-title">歌单</h3>
              <button class="mix-more" @click="neTab = 'playlists'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="p in neResults.playlists.slice(0, 15)" :key="p.id" class="h-card" @click="goPlaylist(p.id)">
                <div class="cover-wrap">
                  <img :src="imgUrl(p.coverImgUrl + '?param=300y300')" alt="" loading="lazy" />
                  <div class="play-count">▶ {{ fmtCount(p.playCount) }}</div>
                </div>
                <div class="name">{{ p.name }}</div>
              </div>
            </div>
          </template>

          <!-- 专辑横滑 -->
          <template v-if="neResults.albums.length">
            <div class="mix-head">
              <h3 class="mix-title">专辑</h3>
              <button class="mix-more" @click="neTab = 'albums'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="al in neResults.albums.slice(0, 15)" :key="al.id" class="h-card" @click="goAlbum(al.id)">
                <div class="cover-wrap">
                  <img :src="imgUrl((al.picUrl || '') + '?param=300y300')" alt="" loading="lazy" />
                </div>
                <div class="name">{{ al.name }}</div>
              </div>
            </div>
          </template>

          <!-- MV 横滑 -->
          <template v-if="neResults.mvs.length">
            <div class="mix-head">
              <h3 class="mix-title">MV</h3>
              <button class="mix-more" @click="neTab = 'mvs'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="m in neResults.mvs.slice(0, 15)" :key="m.id" class="h-card" @click="goMv(m.id)">
                <div class="cover-wrap">
                  <img :src="imgUrl((m.cover || '') + '?param=300y300')" alt="" loading="lazy" />
                  <div class="play-count">▶ {{ m.playCount }}</div>
                </div>
                <div class="name">{{ m.name }}</div>
              </div>
            </div>
          </template>
        </template>
        <!-- 网易云：歌曲 -->
        <SongTable v-else-if="neTab === 'songs'" :songs="neResults.songs" />
        <!-- 网易云：歌单 -->
        <div v-else-if="neTab === 'playlists'" class="grid">
          <div v-for="p in neResults.playlists" :key="p.id" class="playlist-card" @click="goPlaylist(p.id)">
            <div class="cover-wrap">
              <img :src="imgUrl(p.coverImgUrl + '?param=300y300')" alt="" loading="lazy" />
              <div class="play-count">▶ {{ fmtCount(p.playCount) }}</div>
            </div>
            <div class="name">{{ p.name }}</div>
          </div>
        </div>
        <!-- 网易云：歌手 -->
        <div v-else-if="neTab === 'artists'" class="grid">
          <div v-for="a in neResults.artists" :key="a.id" class="playlist-card" @click="goArtist(a.id)">
            <div class="cover-wrap round">
              <img :src="imgUrl((a.picUrl || '') + '?param=300y300')" alt="" loading="lazy" />
            </div>
            <div class="name">{{ a.name }}</div>
          </div>
        </div>
        <!-- 网易云：专辑 -->
        <div v-else-if="neTab === 'albums'" class="grid">
          <div v-for="al in neResults.albums" :key="al.id" class="playlist-card" @click="goAlbum(al.id)">
            <div class="cover-wrap">
              <img :src="imgUrl((al.picUrl || '') + '?param=300y300')" alt="" loading="lazy" />
            </div>
            <div class="name">{{ al.name }}</div>
          </div>
        </div>
        <!-- 网易云：MV -->
        <div v-else-if="neTab === 'mvs'" class="grid">
          <div v-for="m in neResults.mvs" :key="m.id" class="playlist-card" @click="goMv(m.id)">
            <div class="cover-wrap">
              <img :src="imgUrl((m.cover || '') + '?param=300y300')" alt="" loading="lazy" />
              <div class="play-count">▶ {{ m.playCount }}</div>
            </div>
            <div class="name">{{ m.name }}</div>
          </div>
        </div>

        <p v-if="neTab === 'all'" class="load-more done">综合共 {{ neTotal }} 条结果，点「查看全部」看对应类型</p>
        <template v-else>
          <p v-if="!(neResults[neTab] || []).length" class="empty">网易云暂无「{{ tabLabel(neTab) }}」结果</p>
          <p v-else-if="neHasMore[neTab]" class="load-more">{{ loadingMore ? '加载中…' : '继续下滑加载更多' }}</p>
          <p v-else class="load-more done">已加载全部 {{ neCounts[neTab] ?? neResults[neTab].length }} 条</p>
        </template>
      </section>

      <!-- ==================== QQ 音乐 区块 ==================== -->
      <section v-else class="plat-block qq-block">
        <div class="plat-head">
          <span class="plat-logo" v-html="PLATFORM_LOGOS.qq"></span>
          <h2 class="plat-title">QQ音乐</h2>
        </div>
        <div class="sub-tabs">
          <button
            v-for="t in qqTabs"
            :key="'qq-' + t.key"
            class="sub-tab"
            :class="{ active: qqTab === t.key }"
            @click="qqTab = t.key"
          >
            {{ t.label }}<span v-if="qqResults[t.key]?.length" class="sub-count">({{ qqResults[t.key].length }})</span>
          </button>
        </div>

        <!-- QQ：综合（单曲优先 + 歌手/专辑/MV 横滑） -->
        <template v-if="qqTab === 'all'">
          <div class="mix-head">
            <h3 class="mix-title">单曲</h3>
            <button class="mix-more" @click="qqTab = 'songs'">查看全部 ({{ qqResults.songs.length }})</button>
          </div>
          <SongTable v-if="qqResults.songs.length" :songs="qqResults.songs.slice(0, 8)" :show-album="false" />
          <template v-if="qqResults.artists.length">
            <div class="mix-head">
              <h3 class="mix-title">歌手</h3>
              <button class="mix-more" @click="qqTab = 'artists'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="a in qqResults.artists" :key="a.id" class="h-card round" @click="onQqCardClick(a)">
                <div class="cover-wrap">
                  <img :src="imgUrl((a.pic || '') + '?param=300y300')" alt="" loading="lazy" />
                  <span class="plat-badge" v-html="PLATFORM_LOGOS.qq"></span>
                </div>
                <div class="name">{{ a.name }}</div>
              </div>
            </div>
          </template>
          <template v-if="qqResults.albums.length">
            <div class="mix-head">
              <h3 class="mix-title">专辑</h3>
              <button class="mix-more" @click="qqTab = 'albums'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="al in qqResults.albums" :key="al.id" class="h-card" @click="onQqCardClick(al)">
                <div class="cover-wrap">
                  <img :src="imgUrl((al.pic || '') + '?param=300y300')" alt="" loading="lazy" />
                  <span class="plat-badge" v-html="PLATFORM_LOGOS.qq"></span>
                </div>
                <div class="name">{{ al.name }}</div>
              </div>
            </div>
          </template>
          <template v-if="qqResults.mvs.length">
            <div class="mix-head">
              <h3 class="mix-title">MV</h3>
              <button class="mix-more" @click="qqTab = 'mvs'">查看全部</button>
            </div>
            <div class="h-scroll">
              <div v-for="m in qqResults.mvs" :key="m.id" class="h-card" @click="onQqCardClick(m)">
                <div class="cover-wrap">
                  <img :src="imgUrl((m.pic || '') + '?param=300y300')" alt="" loading="lazy" />
                  <span class="plat-badge" v-html="PLATFORM_LOGOS.qq"></span>
                </div>
                <div class="name">{{ m.name }}</div>
              </div>
            </div>
          </template>
        </template>
        <!-- QQ：歌曲 -->
        <SongTable v-else-if="qqTab === 'songs'" :songs="qqResults.songs" />
        <!-- QQ：歌手（smartbox 聚合） -->
        <div v-else-if="qqTab === 'artists'" class="grid">
          <div v-for="a in qqResults.artists" :key="a.id" class="playlist-card" @click="onQqCardClick(a)">
            <div class="cover-wrap round">
              <img :src="imgUrl((a.pic || '') + '?param=300y300')" alt="" loading="lazy" />
              <span class="plat-badge" v-html="PLATFORM_LOGOS.qq"></span>
            </div>
            <div class="name">{{ a.name }}</div>
          </div>
        </div>
        <!-- QQ：专辑 -->
        <div v-else-if="qqTab === 'albums'" class="grid">
          <div v-for="al in qqResults.albums" :key="al.id" class="playlist-card" @click="onQqCardClick(al)">
            <div class="cover-wrap">
              <img :src="imgUrl((al.pic || '') + '?param=300y300')" alt="" loading="lazy" />
              <span class="plat-badge" v-html="PLATFORM_LOGOS.qq"></span>
            </div>
            <div class="name">{{ al.name }}</div>
          </div>
        </div>
        <!-- QQ：MV -->
        <div v-else-if="qqTab === 'mvs'" class="grid">
          <div v-for="m in qqResults.mvs" :key="m.id" class="playlist-card" @click="onQqCardClick(m)">
            <div class="cover-wrap">
              <img :src="imgUrl((m.pic || '') + '?param=300y300')" alt="" loading="lazy" />
              <span class="plat-badge" v-html="PLATFORM_LOGOS.qq"></span>
            </div>
            <div class="name">{{ m.name }}</div>
          </div>
        </div>

        <p v-if="qqTab === 'all'" class="load-more done">综合共 {{ qqTotal }} 条结果，点「查看全部」看对应类型</p>
        <template v-else>
          <p v-if="!(qqResults[qqTab] || []).length" class="empty">QQ音乐暂无「{{ tabLabel(qqTab) }}」结果</p>
          <p v-else-if="qqTab === 'songs' && qqHasMore" class="load-more">{{ qqLoadingMore ? '加载中…' : '继续下滑加载更多' }}</p>
          <p v-else class="load-more done">已加载 {{ qqResults[qqTab].length }} 条</p>
        </template>
      </section>
    </template>
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
  margin-bottom: 24px;
  max-width: 720px;
}
.input-row .input {
  flex: 1;
}
.content-area {
  min-height: 200px;
}

/* ---------- 平台切换器 ---------- */
.plat-switch {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}
.plat-sw-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: 12px;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  transition: transform 0.15s var(--ease), box-shadow 0.15s var(--ease), background 0.15s;
  font-size: 14px;
  color: var(--text-dim);
  cursor: pointer;
}
.plat-sw-btn:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
.plat-sw-btn.active {
  color: #fff;
}
.plat-sw-btn.ne.active {
  background: #ec4141;
}
.plat-sw-btn.qq.active {
  background: #31c27c;
}
.sw-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  flex-shrink: 0;
  transition: background 0.15s, border-radius 0.15s;
}
.sw-logo :deep(svg) {
  width: 16px;
  height: 16px;
}
/* 激活态：给 logo 容器换成白圆底，让原品牌色 logo 保持颜色、强对比清晰可见
   （filter 变白对细线条 logo 视觉太弱，故不用） */
.plat-sw-btn.active .sw-logo {
  background: #fff;
  border-radius: 50%;
}
.sw-count {
  font-size: 11px;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  padding: 1px 8px;
  font-variant-numeric: tabular-nums;
}
.plat-sw-btn.active .sw-count {
  background: rgba(255, 255, 255, 0.25);
}

/* ---------- 平台大区块 ---------- */
.plat-block {
  margin-bottom: 40px;
  padding-top: 4px;
}
.plat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.plat-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  flex-shrink: 0;
}
.plat-logo :deep(svg) {
  width: 18px;
  height: 18px;
}
.plat-title {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.3px;
}
.ne-block .plat-title {
  color: #ec4141;
}
.qq-block .plat-title {
  color: #31c27c;
}
.plat-note {
  font-size: 11px;
  color: var(--text-faint);
  background: var(--bg-card);
  padding: 2px 8px;
  border-radius: 8px;
}

/* ---------- 区块内类型子分组 ---------- */
.sub-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.sub-tab {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-radius: 8px;
  background: var(--bg-card);
  transition: color 0.15s, background 0.15s;
}
.sub-tab:hover {
  color: var(--text);
}
.sub-tab.active {
  color: #fff;
  background: var(--accent);
  font-weight: 600;
}
.qq-block .sub-tab.active {
  background: #31c27c;
}
.sub-count {
  font-size: 10px;
  opacity: 0.85;
  margin-left: 3px;
}

/* ---------- 综合视图：类型区块头 ---------- */
.mix-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin: 24px 0 12px;
}
.mix-head:first-of-type {
  margin-top: 0;
}
.mix-title {
  font-size: 15px;
  font-weight: 700;
}
.mix-more {
  font-size: 12px;
  color: var(--text-dim);
  padding: 3px 10px;
  border-radius: 8px;
  background: var(--bg-card);
  transition: color 0.15s, background 0.15s;
  flex-shrink: 0;
}
.mix-more:hover {
  color: var(--accent);
  background: var(--bg-hover);
}

/* ---------- 综合视图：横滑卡片（音乐平台风格） ---------- */
.h-scroll {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding: 4px 2px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.h-scroll::-webkit-scrollbar {
  height: 5px;
}
.h-scroll::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.h-card {
  flex-shrink: 0;
  width: 128px;
  cursor: pointer;
}
.h-card.round .cover-wrap {
  border-radius: 50%;
}
.h-card .cover-wrap {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  transition: transform 0.25s var(--ease), box-shadow 0.25s var(--ease);
}
.h-card:hover .cover-wrap {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}
.h-card .cover-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s var(--ease);
}
.h-card:hover .cover-wrap img {
  transform: scale(1.06);
}
.h-card .name {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.h-card.round .name {
  text-align: center;
}
.h-card .play-count {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 11px;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}
.h-card .plat-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.h-card .plat-badge :deep(svg) {
  width: 14px;
  height: 14px;
}

/* ---------- 卡片网格（歌单/歌手/专辑/MV 共用） ---------- */
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
.plat-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.plat-badge :deep(svg) {
  width: 14px;
  height: 14px;
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
