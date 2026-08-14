<script setup>
import { ref } from 'vue'
import { api, resolveLinkInput, imgUrl } from '../api'
import { usePlayerStore } from '../stores/player'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { fmtTime } from '../utils/format'
import SongTable from '../components/SongTable.vue'

const player = usePlayerStore()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

const input = ref('')
const loading = ref(false)
const searching = ref(false)
const result = ref(null) // {type, id, detail, songs, url}
const error = ref('')
const searchResults = ref([])
const searchMode = ref(false) // 输入的是歌名，显示搜索结果

async function resolveLink() {
  const text = input.value?.trim()
  if (!text) return
  error.value = ''
  result.value = null
  searchResults.value = []
  searchMode.value = false

  // 1) 先尝试链接 / ID
  const parsed = await resolveLinkInput(text)
  if (parsed) {
    await doResolve(parsed)
    return
  }
  // 2) 非链接 → 按歌名搜索
  await searchByName(text)
}

/** 执行解析（链接/ID 或搜索结果选中后共用） */
async function doResolve(parsed) {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    if (parsed.type === 'song') {
      const [d, u] = await Promise.all([
        api('song_detail', { ids: parsed.id }),
        api('song_url_v1', {
          id: parsed.id,
          level: settings.settings.quality === 'lossless' ? 'lossless' : settings.settings.quality === '320000' ? 'exhigh' : 'standard'
        })
      ])
      const song = d.songs?.[0]
      const url = u.data?.[0]?.url
      if (!song) throw new Error('歌曲不存在或已被删除')
      result.value = {
        type: 'song',
        id: parsed.id,
        detail: song,
        songs: [song],
        url: url || null
      }
      if (!url) error.value = '⚠ 该歌曲无可用播放地址（可能无版权，解灰失败）；如需播放可尝试登录 VIP 账号'
    } else if (parsed.type === 'playlist') {
      const d = await api('playlist_detail', { id: parsed.id })
      const pl = d.playlist
      if (!pl) throw new Error('歌单不存在')
      result.value = { type: 'playlist', id: parsed.id, detail: pl, songs: pl.tracks || [] }
    } else if (parsed.type === 'album') {
      const d = await api('album', { id: parsed.id })
      const al = d.album
      if (!al) throw new Error('专辑不存在')
      result.value = { type: 'album', id: parsed.id, detail: al, songs: d.songs || [] }
    } else {
      error.value = `暂不支持解析「${parsed.type}」类型`
    }
  } catch (e) {
    error.value = '解析失败：' + e.message
  } finally {
    loading.value = false
  }
}

/** 按歌名搜索（cloudsearch）并展示结果列表 */
async function searchByName(keywords) {
  searching.value = true
  error.value = ''
  try {
    const res = await api('cloudsearch', { keywords, type: 1, limit: 20 })
    const songs = res.result?.songs || []
    searchResults.value = songs.map((s) => ({
      id: s.id,
      name: s.name,
      artist: (s.ar || []).map((a) => a.name).join('/'),
      album: s.al?.name || '',
      pic: s.al?.picUrl || '',
      dt: s.dt || 0,
      fee: s.fee
    }))
    searchMode.value = true
    if (!songs.length) error.value = '未找到相关歌曲，换个关键词试试'
  } catch (e) {
    error.value = '搜索失败：' + e.message
  } finally {
    searching.value = false
  }
}

/** 从搜索结果选中一首 → 解析 */
async function pickSearchSong(song) {
  await doResolve({ type: 'song', id: String(song.id) })
  if (result.value?.type === 'song') {
    // 保留搜索结果区，滚动到结果
    searchMode.value = false
  }
}

async function copyUrl() {
  if (!result.value?.url) return
  try {
    await navigator.clipboard.writeText(result.value.url)
    alert('播放地址已复制')
  } catch {
    error.value = '复制失败'
  }
}

async function downloadUrl() {
  const r = result.value
  if (!r?.url) return
  await downloads.add({
    songId: r.id,
    title: r.detail.name,
    artist: (r.detail.ar || []).map((a) => a.name).join('/'),
    url: r.url,
    quality: settings.settings.quality,
    cover: r.detail.al?.picUrl
  })
}
</script>

<template>
  <div class="resolver">
    <div class="hero">
      <div class="hero-icon">⌁</div>
      <h1 class="page-title">解析</h1>
      <p class="desc">粘贴网易云歌曲 / 歌单 / 专辑链接或纯 ID，一键解析真实播放地址</p>
    </div>

    <div class="input-row">
      <input
        v-model="input"
        class="input"
        placeholder="支持：歌曲链接 / ID / 163cn.tv 短链，或直接输入歌名搜索"
        @keyup.enter="resolveLink"
      />
      <button class="btn" :disabled="loading || searching" @click="resolveLink">{{ loading ? '解析中…' : searching ? '搜索中…' : '解析' }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- 歌名搜索结果 -->
    <div v-if="searchMode" class="search-results">
      <div class="list-head">
        <div class="list-title">搜索结果（点击歌曲解析）</div>
        <span class="count">{{ searchResults.length }} 首</span>
      </div>
      <div
        v-for="s in searchResults"
        :key="s.id"
        class="search-item"
        @click="pickSearchSong(s)"
      >
        <img class="thumb" :src="imgUrl(s.pic + '?param=60y60')" alt="" loading="lazy" />
        <div class="s-main">
          <div class="s-name">{{ s.name }} <span v-if="s.fee" class="fee">VIP</span></div>
          <div class="s-sub">{{ s.artist }} · {{ s.album }}</div>
        </div>
        <span class="s-dur">{{ fmtTime(s.dt / 1000) }}</span>
      </div>
    </div>

    <div v-if="result" class="result">
      <!-- 单曲解析 -->
      <template v-if="result.type === 'song'">
        <div class="song-card">
          <img class="big-cover" :src="imgUrl(result.detail.al?.picUrl + '?param=300y300')" alt="" />
          <div class="song-info">
            <div class="song-title">{{ result.detail.name }}</div>
            <div class="song-sub">
              {{ (result.detail.ar || []).map((a) => a.name).join('/') }} · {{ result.detail.al?.name }}
            </div>
            <div class="url-box" v-if="result.url">
              <div class="url-label">真实播放地址</div>
              <div class="url-text" :title="result.url">{{ result.url }}</div>
            </div>
            <div v-else class="url-empty">未获取到播放地址（可能无版权，可在设置中开启全局解灰）</div>
            <div class="actions">
              <button class="btn" @click="player.playNext(result.detail)">▶ 播放</button>
              <button class="btn ghost" :disabled="!result.url" @click="copyUrl">复制地址</button>
              <button class="btn ghost" :disabled="!result.url" @click="downloadUrl">下载</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 歌单/专辑批量解析 -->
      <template v-else>
        <div class="list-head">
          <div class="list-title">
            {{ result.detail.name || result.detail.title }}
            <span class="count">{{ result.songs.length }} 首</span>
          </div>
          <button class="btn" :disabled="!result.songs.length" @click="player.playList(result.songs)">
            ▶ 播放全部
          </button>
        </div>
        <SongTable :songs="result.songs" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.resolver {
  max-width: 860px;
  margin: 0 auto;
}
.hero {
  text-align: center;
  padding: 40px 0 30px;
}
.hero-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 18px;
  border-radius: 18px;
  background: linear-gradient(135deg, var(--accent), var(--accent-soft));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  color: #fff;
  box-shadow: 0 8px 24px rgba(236, 65, 65, 0.35);
}
.hero .page-title {
  margin-bottom: 8px;
}
.desc {
  color: var(--text-dim);
  font-size: 13px;
}
.input-row {
  display: flex;
  gap: 10px;
  max-width: 640px;
  margin: 0 auto;
}
.input-row .input {
  flex: 1;
}
.error {
  color: var(--accent);
  margin-top: 10px;
  font-size: 13px;
  text-align: center;
}
.search-results {
  margin-top: 20px;
}
.search-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.search-item:hover {
  background: var(--bg-card);
}
.search-item .thumb {
  width: 46px;
  height: 46px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}
.search-item .s-main {
  flex: 1;
  min-width: 0;
}
.search-item .s-name {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-item .s-name .fee {
  color: var(--accent);
  font-size: 10px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 6px;
}
.search-item .s-sub {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.search-item .s-dur {
  font-size: 12px;
  color: var(--text-faint);
  flex-shrink: 0;
}
.result {
  margin-top: 26px;
}
.song-card {
  display: flex;
  gap: 24px;
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 22px;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.2s var(--ease);
}
.song-card:hover {
  box-shadow: var(--shadow);
}
.big-cover {
  width: 160px;
  height: 160px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}
.song-info {
  flex: 1;
  min-width: 0;
}
.song-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 6px;
}
.song-sub {
  color: var(--text-dim);
  font-size: 13px;
  margin-bottom: 16px;
}
.url-box {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 16px;
}
.url-label {
  font-size: 11px;
  color: var(--text-faint);
  margin-bottom: 4px;
}
.url-text {
  font-size: 12px;
  color: var(--green);
  word-break: break-all;
  max-height: 44px;
  overflow: hidden;
}
.url-empty {
  color: #f0a020;
  font-size: 13px;
  margin-bottom: 16px;
}
.actions {
  display: flex;
  gap: 10px;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.list-title {
  font-size: 18px;
  font-weight: 600;
}
.count {
  font-size: 13px;
  color: var(--text-faint);
  font-weight: 400;
  margin-left: 8px;
}
</style>
