<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api, waitServerReady, imgUrl } from '../api'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { useDownloadsStore } from '../stores/downloads'
import { toast } from '../utils/toast'
import { fmtCount } from '../utils/format'

const router = useRouter()
const player = usePlayerStore()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

const banner = ref([])
const recommendPlaylists = ref([])
const newSongs = ref([])
const toplists = ref([])
const dailySongs = ref([])
const loading = ref(true)
const serverDown = ref(false)

onMounted(async () => {
  if (!(await waitServerReady())) {
    serverDown.value = true
    loading.value = false
    return
  }
  try {
    const [b, rp, ns, tl] = await Promise.allSettled([
      api('banner'),
      api('personalized', { limit: 12 }),
      api('personalized_newsong', { limit: 10 }),
      api('toplist')
    ])
    if (b.status === 'fulfilled') banner.value = (b.value.banners || []).slice(0, 5)
    if (rp.status === 'fulfilled') recommendPlaylists.value = rp.value.result || []
    if (ns.status === 'fulfilled') newSongs.value = (ns.value.result || []).map((x) => x.song || x)
    if (tl.status === 'fulfilled') toplists.value = (tl.value.list || []).slice(0, 10)
  } finally {
    loading.value = false
  }
})

async function playDaily() {
  try {
    const res = await api('recommend_songs')
    dailySongs.value = res.data?.dailySongs || []
    if (!dailySongs.value.length) {
      toast('暂无每日推荐（需登录网易云账号后使用）')
      return
    }
    await player.playList(dailySongs.value)
  } catch (e) {
    toast('获取每日推荐失败：' + e.message, 'error')
  }
}

async function playAll(songs) {
  await player.playList(songs)
}

/** 播放整个歌单：先拉取曲目再入队（歌单对象本身不是可播放的歌曲） */
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

async function downloadSong(song) {
  try {
    const res = await api('song_url_v1', {
      id: song.id,
      level: settings.settings.quality === 'lossless' ? 'lossless' : settings.settings.quality === '320000' ? 'exhigh' : 'standard'
    })
    const url = res.data?.[0]?.url
    if (!url) return toast('无可用播放地址', 'error')
    await downloads.add({
      songId: song.id,
      title: song.name,
      artist: (song.ar || []).map((a) => a.name).join('/'),
      url,
      quality: settings.settings.quality,
      cover: song.al?.picUrl
    })
  } catch (e) {
    toast('下载失败：' + e.message, 'error')
  }
}

function goToplist(id) {
  router.push(`/playlist/${id}`)
}

/** Banner 跳转：targetType 10=专辑 1000=歌单 1=歌曲 1004=MV（其余不支持） */
function goBanner(b) {
  if (!b.targetId) return
  if (b.targetType === 10) router.push(`/album/${b.targetId}`)
  else if (b.targetType === 1000) router.push(`/playlist/${b.targetId}`)
  else if (b.targetType === 1004) router.push(`/mv/${b.targetId}`)
}
</script>

<template>
  <div class="discover">
    <h1 class="page-title">发现</h1>

    <!-- Banner -->
    <div class="banner-row" v-if="banner.length">
      <div
        v-for="b in banner"
        :key="b.bannerId"
        class="banner-card"
        @click="goBanner(b)"
      >
        <img :src="imgUrl(b.imageUrl + '?param=520y220')" alt="" loading="lazy" />
        <div class="banner-title">{{ b.typeTitle || b.titleColor }}</div>
      </div>
    </div>

    <div v-if="loading" class="placeholder">加载中…</div>
    <div v-else-if="serverDown" class="placeholder">
      内置服务未就绪<br />
      <span class="sub">请检查 server/ 目录是否已 vendor（npm run vendor），或查看设置页重启服务</span>
    </div>

    <!-- 每日推荐 -->
    <section class="sec">
      <div class="sec-head">
        <h2>每日推荐</h2>
        <button class="btn small ghost" @click="playDaily">▶ 播放今日推荐</button>
      </div>
      <p v-if="dailySongs.length === 0" class="hint">登录后可用（需登录态，推荐歌曲 30 首）</p>
    </section>

    <!-- 推荐歌单 -->
    <section class="sec" v-if="recommendPlaylists.length">
      <div class="sec-head">
        <h2>推荐歌单</h2>
      </div>
      <div class="grid">
        <div
          v-for="p in recommendPlaylists"
          :key="p.id"
          class="playlist-card"
          @click="router.push('/playlist/' + p.id)"
        >
          <div class="cover-wrap">
            <img :src="imgUrl(p.picUrl + '?param=300y300')" alt="" loading="lazy" />
            <div class="play-count">▶ {{ fmtCount(p.playCount) }}</div>
            <div class="play-float" @click.stop="playPlaylist(p)">▶</div>
          </div>
          <div class="name">{{ p.name }}</div>
        </div>
      </div>
    </section>

    <!-- 新歌速递 -->
    <section class="sec" v-if="newSongs.length">
      <div class="sec-head">
        <h2>新歌速递</h2>
      </div>
      <div class="song-list">
        <div v-for="(s, i) in newSongs" :key="s.id" class="song-row">
          <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>
          <div class="song-meta">
            <div class="song-name">{{ s.name }}</div>
            <div class="song-artist">{{ (s.ar || []).map((a) => a.name).join('/') }}</div>
          </div>
          <button class="op" title="播放" @click="playAll(newSongs.slice(i))">▶</button>
          <button class="op" title="下载" @click="downloadSong(s)">⇩</button>
        </div>
      </div>
    </section>

    <!-- 排行榜 -->
    <section class="sec" v-if="toplists.length">
      <div class="sec-head">
        <h2>排行榜</h2>
      </div>
      <div class="grid small">
        <div
          v-for="t in toplists"
          :key="t.id"
          class="playlist-card"
          @click="goToplist(t.id)"
        >
          <div class="cover-wrap">
            <img :src="imgUrl(t.coverImgUrl + '?param=200y200')" alt="" loading="lazy" />
            <div class="play-count">▶ {{ fmtCount(t.playCount) }}</div>
          </div>
          <div class="name">{{ t.name }}</div>
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
.banner-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 14px;
  margin-bottom: 32px;
}
.banner-card {
  border-radius: 14px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  aspect-ratio: 16/6.5;
  box-shadow: var(--shadow-cover);
  transition: transform 0.3s var(--ease-spring), box-shadow 0.3s var(--ease);
}
.banner-card:hover {
  transform: translateY(-3px) scale(1.02);
  box-shadow: var(--shadow);
}
.banner-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.banner-title {
  position: absolute;
  left: 12px;
  bottom: 10px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7);
}
.sec {
  margin-bottom: 38px;
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
.hint {
  color: var(--text-faint);
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
}
.grid.small {
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
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
/* hover 浮现播放按钮（Apple 风格圆形毛玻璃） */
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
.play-count {
  position: absolute;
  top: 8px;
  right: 10px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
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
.song-list {
  display: flex;
  flex-direction: column;
}
.song-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  border-radius: 8px;
  transition: background 0.15s var(--ease);
}
.song-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
.idx {
  width: 26px;
  color: var(--text-faint);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.song-meta {
  flex: 1;
  min-width: 0;
}
.song-name {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-artist {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}
.op {
  color: var(--text-dim);
  font-size: 14px;
  padding: 6px;
  border-radius: 50%;
  transition: color 0.15s, background 0.15s;
}
.op:hover {
  color: var(--accent);
  background: var(--accent-dim);
}
.placeholder {
  color: var(--text-faint);
  padding: 40px 0;
  text-align: center;
}
</style>
