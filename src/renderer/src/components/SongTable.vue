<script setup>
import { ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { api, imgUrl } from '../api'
import { fmtTime } from '../utils/format'
import { toast } from '../utils/toast'

const props = defineProps({
  songs: { type: Array, default: () => [] },
  showAlbum: { type: Boolean, default: true },
  showIndex: { type: Boolean, default: true }
})

const player = usePlayerStore()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

// 当前页面点赞集合（组件级，乐观更新；未登录时后端会返回错误并回滚）
const liked = ref(new Set())
const likePending = ref(new Set())

function playAt(i) {
  player.playList(props.songs, i)
}

/** 喜欢/取消喜欢：乐观更新，接口失败回滚 */
async function toggleLike(song) {
  const id = song.id
  if (likePending.value.has(id)) return
  const wasLiked = liked.value.has(id)
  // 乐观更新
  liked.value = new Set(liked.value)
  if (wasLiked) liked.value.delete(id)
  else liked.value.add(id)
  likePending.value = new Set(likePending.value).add(id)
  try {
    await api('like', { id, like: !wasLiked })
  } catch (e) {
    // 回滚
    liked.value = new Set(liked.value)
    if (wasLiked) liked.value.add(id)
    else liked.value.delete(id)
    toast(e.code === 301 ? '喜欢功能需要先登录' : '操作失败：' + (e.message || '未知错误'), 'error')
  } finally {
    const p = new Set(likePending.value)
    p.delete(id)
    likePending.value = p
  }
}

async function download(song) {
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
</script>

<template>
  <div class="song-table">
    <div class="st-head">
      <span class="c-idx" v-if="showIndex">#</span>
      <span class="c-cover"></span>
      <span class="c-title">歌曲</span>
      <span class="c-album" v-if="showAlbum">专辑</span>
      <span class="c-like">喜欢</span>
      <span class="c-time">时长</span>
      <span class="c-ops"></span>
    </div>
    <div
      v-for="(s, i) in songs"
      :key="s.id"
      class="st-row"
      :class="{ playing: player.current?.id === s.id, 'is-playing': player.current?.id === s.id && player.playing }"
      @dblclick="playAt(i)"
    >
      <span class="c-idx" v-if="showIndex">
        <span v-if="player.current?.id === s.id && player.playing" class="playing-bars"><i></i><i></i><i></i></span>
        <span class="idx-num">{{ i + 1 }}</span>
        <button class="idx-btn idx-play" title="播放" @click.stop="playAt(i)">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="idx-btn idx-pause" title="暂停" @click.stop="player.toggle()">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
        </button>
      </span>
      <span class="c-cover">
        <img
          v-if="s.al?.picUrl || s.pic"
          class="cover-thumb"
          :src="imgUrl((s.al?.picUrl || s.pic) + '?param=60y60')"
          alt=""
          loading="lazy"
        />
      </span>
      <div class="c-title">
        <span class="t-name">{{ s.name }}</span>
        <span class="t-artist">{{ (s.ar || s.artists || []).map((a) => a.name ?? a).join('/') }}</span>
      </div>
      <span class="c-album" v-if="showAlbum">{{ s.al?.name || s.album }}</span>
      <span class="c-like">
        <button
          class="like-btn"
          :class="{ liked: liked.has(s.id), pending: likePending.has(s.id) }"
          :title="liked.has(s.id) ? '取消喜欢' : '喜欢'"
          @click.stop="toggleLike(s)"
        >
          <svg :class="{ filled: liked.has(s.id) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
      </span>
      <span class="c-time">{{ fmtTime((s.dt || s.duration || 0) / 1000) }}</span>
      <div class="c-ops">
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
  padding: 10px 16px;
}
.st-head {
  color: var(--text-faint);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0;
}
.st-row {
  border-bottom: 1px solid var(--hairline);
  transition: background 0.12s var(--ease);
  cursor: default;
}
.st-row:hover {
  background: var(--bg-hover);
}
.st-row.playing .t-name {
  color: var(--accent);
  font-weight: 600;
}
.c-idx {
  width: 40px;
  flex-shrink: 0;
  text-align: center;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.idx-num,
.idx-btn,
.playing-bars { vertical-align: middle; }
.idx-btn {
  display: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s;
}
.idx-btn svg { width: 14px; height: 14px; }
.idx-btn:hover { color: var(--accent); }
.st-row:hover .idx-num { display: none; }
.st-row:hover .idx-play { display: inline-flex; }
.st-row.is-playing .idx-num { display: none; }
.st-row.is-playing:hover .playing-bars,
.st-row.is-playing:hover .idx-play { display: none; }
.st-row.is-playing:hover .idx-pause { display: inline-flex; color: var(--accent); }
.playing-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.playing-bars i {
  width: 3px;
  background: var(--accent);
  border-radius: 1px;
  animation: eq 0.9s ease-in-out infinite;
}
.playing-bars i:nth-child(1) { height: 8px; }
.playing-bars i:nth-child(2) { height: 12px; animation-delay: 0.2s; }
.playing-bars i:nth-child(3) { height: 6px; animation-delay: 0.4s; }
@keyframes eq {
  0%, 100% { transform: scaleY(0.5); }
  50% { transform: scaleY(1); }
}
.c-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 封面缩略图 */
.c-cover {
  width: 36px;
  flex-shrink: 0;
}
.cover-thumb {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  object-fit: cover;
  display: block;
  box-shadow: var(--shadow-sm);
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
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-like {
  width: 40px;
  display: flex;
  justify-content: center;
}
.like-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  transition: color 0.15s, background 0.15s;
}
.like-btn:hover {
  color: var(--accent);
  background: var(--accent-dim);
}
.like-btn.liked {
  color: var(--accent);
}
.like-btn.liked svg.filled {
  fill: var(--accent);
}
.like-btn.pending {
  animation: like-pulse 0.6s var(--ease) infinite;
}
@keyframes like-pulse {
  50% { transform: scale(1.15); }
}
.like-btn svg { width: 16px; height: 16px; }
.c-time {
  width: 60px;
  text-align: right;
  color: var(--text-dim);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.c-ops {
  width: 40px;
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  flex-shrink: 0;
}
.op {
  color: var(--text-faint);
  font-size: 14px;
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
  background: var(--accent-dim);
}
</style>
