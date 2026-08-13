<script setup>
import { ref } from 'vue'
import { api, parseLink } from '../api'
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
const result = ref(null) // {type, id, detail, songs, url}
const error = ref('')

async function resolveLink() {
  const parsed = parseLink(input.value)
  if (!parsed) {
    error.value = '无法识别的链接/ID，支持：歌曲、歌单、专辑链接或纯 ID'
    return
  }
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
        placeholder="例如：https://music.163.com/song?id=33894312 或 33894312"
        @keyup.enter="resolveLink"
      />
      <button class="btn" :disabled="loading" @click="resolveLink">{{ loading ? '解析中…' : '解析' }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="result" class="result">
      <!-- 单曲解析 -->
      <template v-if="result.type === 'song'">
        <div class="song-card">
          <img class="big-cover" :src="result.detail.al?.picUrl + '?param=300y300'" alt="" />
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
