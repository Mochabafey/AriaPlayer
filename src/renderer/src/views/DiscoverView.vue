<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api, imgUrl, waitServerReady } from '../api'
import { usePlayerStore } from '../stores/player'
import { toast } from '../utils/toast'

const router = useRouter()
const player = usePlayerStore()

const dailySongs = ref([])
const recommendPlaylists = ref([])
const loading = ref(true)
const serverDown = ref(false)
// 每日推荐日期：如 17/8（日/月）
const now = new Date()
const dailyDate = `${now.getDate()}/${now.getMonth() + 1}`

/** 推荐歌单：优先每日推荐歌单（recommend_resource，每天更新），失败/空回退猜你喜欢。
 *  结果缓存到 localStorage：换一批的内容下次进入不丢 */
const RECOMMEND_KEY = 'aria:recommend-playlists'
function cacheRecommend(list) {
  try { localStorage.setItem(RECOMMEND_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}
function cachedRecommend() {
  try {
    const s = localStorage.getItem(RECOMMEND_KEY)
    if (s) return JSON.parse(s)
  } catch { /* ignore */ }
  return null
}

async function loadRecommend() {
  try {
    const r = await api('recommend_resource', { timestamp: Date.now() })
    const list = r.recommend || r.result || []
    if (list.length) {
      recommendPlaylists.value = list
      cacheRecommend(list)
      return
    }
  } catch { /* fallthrough */ }
  try {
    const p = await api('personalized', { limit: 12, timestamp: Date.now() })
    recommendPlaylists.value = p.result || []
    if (recommendPlaylists.value.length) cacheRecommend(recommendPlaylists.value)
  } catch { /* keep old */ }
}

/** 换一批：每日推荐歌单一天只有一套，换不新——改从歌单广场随机 offset 拉一批（真正每次不同） */
async function refreshRecommend() {
  try {
    const offset = Math.floor(Math.random() * 300)
    const t = await api('top_playlist', { limit: 12, offset, order: 'hot' })
    const list = t.playlists || []
    if (list.length) {
      recommendPlaylists.value = list
      cacheRecommend(list)
      return
    }
  } catch { /* fallthrough */ }
  await loadRecommend()
}

/** 播放整个歌单：先拉取曲目再入队 */
async function playPlaylist(p) {
  try {
    const d = await api('playlist_track_all', { id: p.id, limit: 1000 })
    const songs = d.songs || []
    if (!songs.length) {
      toast('歌单曲目为空或加载失败')
      return
    }
    await player.playList(songs)
  } catch (e) {
    toast('播放歌单失败：' + e.message, 'error')
  }
}

/* ============ 推荐功能排：日推 / 心动 / 雷达 / 相似 / 漫游 ============ */
const recFeatures = [
  { key: 'daily', name: '每日推荐', desc: '今日为你精选', icon: 'M8 2v4M16 2v4M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', act: () => router.push('/daily') },
  { key: 'heart', name: '心动模式', desc: '跟着喜欢的听', icon: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z', act: playFm },
  { key: 'radar', name: '私人雷达', desc: '今日雷达歌单', icon: 'M19.07 4.93A10 10 0 0 0 6.99 3.34M4 6h.01M2.29 9.62A10 10 0 1 0 21.31 8.35M16.24 7.76A6 6 0 1 0 8.23 16.67M12 18h.01M17.99 11.66A6 6 0 0 1 15.77 16.67M13.41 10.59l5.66-5.66', act: playRadar },
  { key: 'simi', name: '相似推荐', desc: '找更多同款', icon: 'M9.5 17.5V6.5l8-1.8v11.5M7 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM15.5 16a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', act: playSimi },
  { key: 'roam', name: '云漫游', desc: '随机探索好歌', icon: 'M3.5 8.5h17a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1ZM7 8.5 9.5 4.5M16.5 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM19.5 14.5a5 5 0 0 0-3-4.5M5.5 11.5h4M7 16.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z', act: playRoam }
]

async function handleFeature(f) {
  try {
    await f.act()
  } catch (e) {
    toast(f.name + '失败：' + (e.message || '未知错误'), 'error')
  }
}

/** 心动模式：私人 FM（按喜欢驱动） */
async function playFm() {
  const r = await api('personal_fm')
  const songs = r.data || []
  if (!songs.length) return toast('心动模式暂无内容（需要登录网易云账号）', 'error')
  player.playList(songs)
  toast('心动模式启动 ♥')
}

/** 私人雷达：今日推荐歌单里随机播一个 */
async function playRadar() {
  const r = await api('recommend_resource', { timestamp: Date.now() })
  const list = r.recommend || r.result || []
  if (!list.length) return toast('雷达暂无内容', 'error')
  const p = list[Math.floor(Math.random() * list.length)]
  await playPlaylist(p)
}

/** 相似推荐：基于当前播放歌曲 */
async function playSimi() {
  const cur = player.current
  if (!cur) return toast('请先播放一首歌，再找相似推荐', 'error')
  const r = await api('simi_song', { id: cur.id, limit: 30 })
  const songs = r.songs || []
  if (!songs.length) return toast('暂无相似歌曲', 'error')
  player.playList(songs)
}

/** 云漫游：随机歌单播放 */
async function playRoam() {
  const offset = Math.floor(Math.random() * 400)
  const t = await api('top_playlist', { limit: 1, offset, order: 'hot' })
  const p = t.playlists?.[0]
  if (!p) return toast('漫游未找到歌单', 'error')
  await playPlaylist(p)
  toast('漫游到「' + p.name + '」')
}

onMounted(async () => {
  if (!(await waitServerReady())) {
    serverDown.value = true
    loading.value = false
    return
  }
  try {
    const dl = await api('recommend_songs')
    dailySongs.value = dl.data?.dailySongs || []
    // 先显示上次的推荐歌单（localStorage），再后台刷新今天的
    const cached = cachedRecommend()
    if (cached?.length) recommendPlaylists.value = cached
    await loadRecommend()
  } catch { /* ignore */ } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="discover">
    <h1 class="page-title">发现</h1>

    <div v-if="loading" class="placeholder">加载中…</div>
    <div v-else-if="serverDown" class="placeholder">
      内置服务未就绪<br />
      <span class="sub">请检查 server/ 目录是否已 vendor（npm run vendor），或查看设置页重启服务</span>
    </div>

    <!-- 推荐功能排：日推 / 心动 / 雷达 / 相似 / 漫游 -->
    <section class="sec" v-if="!loading && !serverDown">
      <div class="feature-grid">
        <div v-for="f in recFeatures" :key="f.key" class="feature-card" @click="handleFeature(f)">
          <span v-if="f.key === 'daily'" class="f-date">{{ dailyDate }}</span>
          <div class="f-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="f.icon"/></svg>
          </div>
          <div class="f-name">{{ f.name }}</div>
          <div class="f-desc">{{ f.desc }}</div>
        </div>
      </div>
    </section>
    <p v-else-if="!loading" class="hint">
      每日推荐需要登录网易云账号后使用，去
      <RouterLink to="/profile" class="link">个人中心</RouterLink>
      扫码登录吧
    </p>
    <!-- 推荐歌单 -->
    <section class="sec" v-if="recommendPlaylists.length">
      <div class="sec-head">
        <h2>推荐歌单</h2>
        <div class="sec-ops">
          <button class="btn small ghost" @click="refreshRecommend">换一批</button>
          <RouterLink to="/more/playlists" class="more-link">更多 ›</RouterLink>
        </div>
      </div>
      <div class="grid">
        <div
          v-for="p in recommendPlaylists"
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
    </section>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.3px;
  margin-bottom: 22px;
  color: var(--text);
}
.hint {
  color: var(--text-faint);
  font-size: 13px;
  padding: 30px 0;
}
.link {
  color: var(--accent);
  text-decoration: underline;
}
.placeholder {
  color: var(--text-faint);
  padding: 40px 0;
  text-align: center;
}
.sub {
  font-size: 12px;
}

/* 区块标题 */
.sec {
  margin-top: 28px;
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.sec-head h2 {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.sec-ops {
  display: flex;
  align-items: center;
  gap: 12px;
}
.more-link {
  font-size: 13px;
  color: var(--text-dim);
  transition: color 0.15s;
}
.more-link:hover {
  color: var(--accent);
}

/* 推荐歌单网格 */
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

/* 推荐功能卡片排：日推 / 心动 / 雷达 / 相似 / 漫游 */
.feature-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 14px;
}
@media (max-width: 1100px) {
  .feature-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
}
.feature-card {
  position: relative;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px 14px 16px;
  text-align: center;
  cursor: pointer;
  box-shadow: var(--shadow-cover);
  transition: transform 0.25s var(--ease-spring), box-shadow 0.25s var(--ease);
}
.feature-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-lg);
}
.f-icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 10px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent-dim), rgba(254, 44, 85, 0.05));
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.feature-card:hover .f-icon {
  background: var(--accent);
  color: #fff;
}
.f-icon svg {
  width: 24px;
  height: 24px;
}
.f-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.f-desc {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 4px;
}
.f-date {
  position: absolute;
  top: 9px;
  right: 10px;
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-dim);
  border-radius: 8px;
  padding: 2px 7px;
}
</style>
