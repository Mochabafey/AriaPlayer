<script setup>
import { ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { api, imgUrl, qqmusic } from '../api'
import { fmtTime } from '../utils/format'
import { toast } from '../utils/toast'
import { PLATFORM_LOGOS } from '../utils/mergeSongs'

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

// 展开折叠状态：记录哪些 merged 歌曲展开了第二源
const expandedSources = ref(new Set())

function primarySource(song) {
  if (!song.merged || !song.sources) return song.source || 'netease'
  return settings.settings.musicSource || 'netease'
}

function altSource(song) {
  if (!song.merged || !song.sources) return null
  const primary = primarySource(song)
  return primary === 'netease' ? 'qq' : 'netease'
}

function hasBothSources(song) {
  return song.merged && song.sources?.netease?.available && song.sources?.qq?.available
}

function effectiveSong(song, sourceName) {
  if (!song.merged || !song.sources) return song
  const src = song.sources[sourceName || primarySource(song)]
  return src || song
}

function effectiveSongId(song) {
  const s = effectiveSong(song)
  return s?.id || s?.name || ''
}

function playAt(i) {
  const song = props.songs[i]
  if (!song) return
  // 整个列表入队连播（每首歌带 source，播放时各自走对应平台 API）；
  // 展开键的「用此音源播放」走 playSong 单曲替换
  player.playList(props.songs, i)
}

function playAltSource(song) {
  const alt = altSource(song)
  if (!alt || !song.sources?.[alt]?.available) return
  const es = song.sources[alt]
  player.playSong(es, alt)
}

function toggleExpand(songId) {
  const s = new Set(expandedSources.value)
  if (s.has(songId)) s.delete(songId)
  else s.add(songId)
  expandedSources.value = s
}

/** 喜欢/取消喜欢：乐观更新，接口失败回滚 */
async function toggleLike(song) {
  const id = song.id
  if (!id || likePending.value.has(id)) return
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
    const src = primarySource(song)
    const es = effectiveSong(song, src)
    if (src === 'qq') {
      // QQ音乐下载
      const res = await qqmusic.url(es.id)
      const url = res?.url
      if (!url) return toast('无可用播放地址', 'error')
      await downloads.add({
        songId: idFromSong(es, src),
        title: es.name,
        artist: es.artist || (es.ar || []).map((a) => a.name).join('/'),
        url,
        quality: 'standard',
        cover: es.al?.picUrl || es.pic || ''
      })
      return
    }
    const res = await api('song_url_v1', {
      id: es.id,
      level: settings.settings.quality === 'lossless' ? 'lossless' : settings.settings.quality === '320000' ? 'exhigh' : 'standard'
    })
    const url = res.data?.[0]?.url
    if (!url) return toast('无可用播放地址', 'error')
    await downloads.add({
      songId: es.id,
      title: es.name,
      artist: (es.ar || []).map((a) => a.name).join('/'),
      url,
      quality: settings.settings.quality,
      cover: es.al?.picUrl
    })
  } catch (e) {
    toast('下载失败：' + e.message, 'error')
  }
}

function idFromSong(song, source) {
  return source === 'qq' ? `qq:${song.id}` : String(song.id)
}

/** 歌曲行唯一 key（merged 歌曲用两源 ID 拼接） */
function rowKey(song, i) {
  if (song.merged) return `merged-${song.sources?.netease?.id || ''}-${song.sources?.qq?.id || ''}-${i}`
  return song.id || `row-${i}`
}

function isPlaying(song) {
  if (!player.current) return false
  const curId = player.current?.id
  if (!curId) return false
  // 当前播放的歌是这首歌的任一来源（主源或备选源）都算"在播"
  return (
    curId === effectiveSong(song)?.id ||
    curId === song.sources?.netease?.id ||
    curId === song.sources?.qq?.id
  )
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
    <template v-for="(s, i) in songs" :key="rowKey(s, i)">
      <div
        class="st-row"
        :class="{ playing: isPlaying(s), 'is-playing': isPlaying(s) && player.playing, 'merged': s.merged }"
        @dblclick="playAt(i)"
      >
        <span class="c-idx" v-if="showIndex">
          <span v-if="isPlaying(s) && player.playing" class="playing-bars"><i></i><i></i><i></i></span>
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
            v-if="effectiveSong(s).al?.picUrl || effectiveSong(s).pic"
            class="cover-thumb"
            :src="imgUrl((effectiveSong(s).al?.picUrl || effectiveSong(s).pic) + '?param=60y60')"
            alt=""
            loading="lazy"
          />
        </span>
        <div class="c-title">
          <div class="t-name-row">
            <!-- 平台 Logo -->
            <span class="source-badge" v-if="s.merged && hasBothSources(s)" v-html="PLATFORM_LOGOS[primarySource(s)]"></span>
            <span class="source-badge" v-else-if="!s.merged && s.source" v-html="PLATFORM_LOGOS[s.source]"></span>
            <span class="t-name">{{ effectiveSong(s).name }}</span>
            <!-- 展开按钮：双源同名歌曲 -->
            <button
              v-if="hasBothSources(s)"
              class="expand-btn"
              :class="{ open: expandedSources.has(rowKey(s, i)) }"
              @click.stop="toggleExpand(rowKey(s, i))"
              :title="expandedSources.has(rowKey(s, i)) ? '收起' : '查看其他音源'"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </button>
          </div>
          <span class="t-artist">{{ effectiveSong(s).artist || (effectiveSong(s).ar || []).map((a) => a.name ?? a).join('/') }}</span>
        </div>
        <span class="c-album" v-if="showAlbum">{{ effectiveSong(s).al?.name || effectiveSong(s).album }}</span>
        <span class="c-like">
          <button
            v-if="effectiveSong(s).id"
            class="like-btn"
            :class="{ liked: liked.has(effectiveSong(s).id), pending: likePending.has(effectiveSong(s).id) }"
            :title="liked.has(effectiveSong(s).id) ? '取消喜欢' : '喜欢'"
            @click.stop="toggleLike(effectiveSong(s))"
          >
            <svg :class="{ filled: liked.has(effectiveSong(s).id) }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </span>
        <span class="c-time">{{ fmtTime((effectiveSong(s).dt || effectiveSong(s).duration || 0) / 1000) }}</span>
        <div class="c-ops">
          <button class="op" title="下载" @click.stop="download(s)">⇩</button>
        </div>
      </div>
      <!-- 展开的备选音源行 -->
      <div
        v-if="hasBothSources(s) && expandedSources.has(rowKey(s, i))"
        class="st-row alt-source"
        @dblclick="playAltSource(s)"
      >
        <span class="c-idx" v-if="showIndex"></span>
        <span class="c-cover">
          <img
            v-if="effectiveSong(s, altSource(s)).pic"
            :src="imgUrl(effectiveSong(s, altSource(s)).pic + '?param=60y60')"
            alt=""
            loading="lazy"
          />
        </span>
        <div class="c-title">
          <div class="t-name-row">
            <span class="source-badge" v-html="PLATFORM_LOGOS[altSource(s)]"></span>
            <span class="t-name dim">{{ effectiveSong(s, altSource(s)).name }}</span>
            <span class="source-label">{{ altSource(s) === 'qq' ? 'QQ音乐' : '网易云' }}</span>
          </div>
          <span class="t-artist">{{ effectiveSong(s, altSource(s)).artist || (effectiveSong(s, altSource(s)).ar || []).map((a) => a.name ?? a).join('/') }}</span>
        </div>
        <span class="c-album" v-if="showAlbum">{{ effectiveSong(s, altSource(s)).al?.name || effectiveSong(s, altSource(s)).album }}</span>
        <span class="c-like"></span>
        <span class="c-time">{{ fmtTime((effectiveSong(s, altSource(s)).dt || effectiveSong(s, altSource(s)).duration || 0) / 1000) }}</span>
        <div class="c-ops">
          <button class="op play-alt" title="用此音源播放" @click.stop="playAltSource(s)">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
      </div>
    </template>
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
.t-name.dim {
  color: var(--text-dim);
}
.st-row:hover .t-name {
  color: var(--text);
}
.t-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
}
.source-badge {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  opacity: 0.85;
}
.source-label {
  font-size: 10px;
  color: var(--text-faint);
  background: var(--bg-card);
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}
.expand-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  transition: color 0.15s, transform 0.2s var(--ease), background 0.15s;
  opacity: 0;
}
.expand-btn svg {
  width: 14px;
  height: 14px;
}
.st-row:hover .expand-btn {
  opacity: 1;
}
.expand-btn:hover {
  color: var(--accent);
  background: var(--accent-dim);
}
.expand-btn.open {
  transform: rotate(180deg);
}
.alt-source {
  background: var(--bg-card);
  border-left: 2px solid var(--accent);
  margin-left: 0;
}
.alt-source:hover {
  background: var(--bg-hover);
}
.play-alt {
  opacity: 1 !important;
  transform: none !important;
}
.play-alt:hover {
  color: var(--accent);
  background: var(--accent-dim);
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
