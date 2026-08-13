<script setup>
import { usePlayerStore } from '../stores/player'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { api } from '../api'
import { fmtTime } from '../utils/format'

const props = defineProps({
  songs: { type: Array, default: () => [] },
  showAlbum: { type: Boolean, default: true },
  showIndex: { type: Boolean, default: true }
})

const player = usePlayerStore()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

function playAt(i) {
  player.playList(props.songs, i)
}

async function download(song) {
  try {
    const res = await api('song_url_v1', {
      id: song.id,
      level: settings.settings.quality === 'lossless' ? 'lossless' : settings.settings.quality === '320000' ? 'exhigh' : 'standard'
    })
    const url = res.data?.[0]?.url
    if (!url) return alert('无可用播放地址')
    await downloads.add({
      songId: song.id,
      title: song.name,
      artist: (song.ar || []).map((a) => a.name).join('/'),
      url,
      quality: settings.settings.quality,
      cover: song.al?.picUrl
    })
  } catch (e) {
    alert('下载失败：' + e.message)
  }
}
</script>

<template>
  <div class="song-table">
    <div class="st-head">
      <span class="c-idx" v-if="showIndex">#</span>
      <span class="c-title">歌曲</span>
      <span class="c-album" v-if="showAlbum">专辑</span>
      <span class="c-time">时长</span>
      <span class="c-ops"></span>
    </div>
    <div v-for="(s, i) in songs" :key="s.id" class="st-row" @dblclick="playAt(i)">
      <span class="c-idx" v-if="showIndex">{{ i + 1 }}</span>
      <div class="c-title">
        <span class="t-name">{{ s.name }}</span>
        <span class="t-artist">{{ (s.ar || s.artists || []).map((a) => a.name ?? a).join('/') }}</span>
      </div>
      <span class="c-album" v-if="showAlbum">{{ s.al?.name || s.album }}</span>
      <span class="c-time">{{ fmtTime((s.dt || s.duration || 0) / 1000) }}</span>
      <div class="c-ops">
        <button class="op" title="播放" @click.stop="playAt(i)">▶</button>
        <button class="op" title="下载" @click.stop="download(s)">⇩</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.song-table {
  display: flex;
  flex-direction: column;
}
.st-head,
.st-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
}
.st-head {
  color: var(--text-faint);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.st-row {
  border-radius: var(--radius-sm);
  transition: background 0.15s var(--ease);
  cursor: default;
}
.st-row:hover {
  background: var(--bg-hover);
}
.c-idx {
  width: 34px;
  flex-shrink: 0;
  text-align: center;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  transition: color 0.15s;
}
.st-row:hover .c-idx {
  color: var(--accent);
}
.c-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.t-name {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s;
}
.st-row:hover .t-name {
  color: var(--text);
}
.t-artist {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-album {
  width: 22%;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-time {
  width: 52px;
  text-align: right;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.c-ops {
  width: 70px;
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  flex-shrink: 0;
}
.op {
  color: var(--text-dim);
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 6px;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease), color 0.15s;
}
.st-row:hover .op {
  opacity: 1;
  transform: translateY(0);
}
.op:hover {
  color: var(--accent);
  background: var(--bg-active);
}
</style>
