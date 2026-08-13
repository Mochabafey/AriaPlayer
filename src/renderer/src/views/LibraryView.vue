<script setup>
import { ref, computed, onMounted } from 'vue'
import { ncm } from '../api'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { fmtTime } from '../utils/format'

const library = useLibraryStore()
const player = usePlayerStore()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

const query = ref('')
const view = ref('grid') // grid | list
const selected = ref(new Set())
const filter = ref('all') // all | download | import
const editing = ref(null) // 正在编辑元数据的歌曲
const editForm = ref({ title: '', artist: '', album: '' })

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return library.songs.filter((s) => {
    if (filter.value !== 'all' && s.source !== filter.value) return false
    if (!q) return true
    return [s.title, s.artist, s.album].some((v) => (v || '').toLowerCase().includes(q))
  })
})

const sorted = computed(() => {
  return [...filtered.value].sort((a, b) => b.addedAt - a.addedAt)
})

function coverOf(s) {
  return s.coverPath ? `ncm://cover?path=${encodeURIComponent(s.coverPath)}` : ''
}

onMounted(() => {
  library.load()
  downloads.watch()
})

async function pickFolder() {
  const dir = await ncm.librarySelectFolder()
  if (dir) {
    await library.addFolder(dir)
  }
}

function playLocal(song) {
  player.playList([{ ...song, fromLocal: true, ar: [{ name: song.artist }] }])
}

function toggleSelect(id) {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
  selected.value = new Set(selected.value)
}

function selectAll() {
  if (selected.value.size === sorted.value.length) selected.value = new Set()
  else selected.value = new Set(sorted.value.map((s) => s.id))
}

function startEdit(song) {
  editing.value = song
  editForm.value = { title: song.title, artist: song.artist, album: song.album }
}

async function saveEdit() {
  if (!editing.value) return
  await library.edit(editing.value.id, editForm.value)
  editing.value = null
}

async function exportLibrary(type) {
  await ncm.libraryExport(type)
}

async function importLibrary() {
  const n = await ncm.libraryImport()
  await library.load()
  if (n > 0) alert(`已导入 ${n} 首`)
}
</script>

<template>
  <div class="library">
    <div class="head">
      <h1 class="page-title">曲库</h1>
      <div class="head-actions">
        <button class="btn small ghost" @click="pickFolder">{{ library.scanning ? '扫描中…' : '＋ 添加文件夹' }}</button>
        <button class="btn small ghost" @click="library.scan()">↻ 重新扫描</button>
        <button class="btn small ghost" @click="importLibrary">⇪ 导入清单</button>
        <button class="btn small ghost" @click="exportLibrary('m3u')">⇓ 导出 M3U</button>
        <button class="btn small ghost" @click="exportLibrary('json')">⇓ 导出 JSON</button>
      </div>
    </div>

    <div class="toolbar">
      <input v-model="query" class="input search" placeholder="搜索曲库（标题 / 歌手 / 专辑）" />
      <div class="filters">
        <button class="chip" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部 {{ library.songs.length }}</button>
        <button class="chip" :class="{ active: filter === 'download' }" @click="filter = 'download'">已下载</button>
        <button class="chip" :class="{ active: filter === 'import' }" @click="filter = 'import'">导入</button>
      </div>
      <div class="view-toggle">
        <button class="chip" :class="{ active: view === 'grid' }" @click="view = 'grid'">▦ 封面墙</button>
        <button class="chip" :class="{ active: view === 'list' }" @click="view = 'list'">☰ 列表</button>
      </div>
      <button v-if="selected.size" class="chip accent" @click="selectAll">已选 {{ selected.size }}，全选/取消</button>
    </div>

    <p v-if="!library.songs.length" class="empty">
      曲库为空<br /><span class="sub">添加文件夹自动扫描，或从解析/搜索页下载歌曲</span>
    </p>

    <!-- 封面墙 -->
    <div v-else-if="view === 'grid'" class="grid">
      <div
        v-for="s in sorted"
        :key="s.id"
        class="song-card"
        :class="{ selected: selected.has(s.id) }"
        @click="toggleSelect(s.id)"
        @dblclick="playLocal(s)"
      >
        <div class="cover">
          <img v-if="s.coverPath" :src="`ncm://cover?path=${encodeURIComponent(s.coverPath)}`" alt="" loading="lazy" />
          <div v-else class="no-cover">♪</div>
          <div class="hover-ops" @click.stop>
            <button class="op" title="播放" @click.stop="playLocal(s)">▶</button>
            <button class="op" title="编辑信息" @click.stop="startEdit(s)">✎</button>
          </div>
          <span class="src-tag" :class="s.source">{{ s.source === 'download' ? '下载' : '导入' }}</span>
        </div>
        <div class="card-meta">
          <div class="c-title" :title="s.title">{{ s.title }}</div>
          <div class="c-artist">{{ s.artist }} · {{ fmtTime(s.duration) }}</div>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else class="table">
      <div v-for="s in sorted" :key="s.id" class="row" :class="{ selected: selected.has(s.id) }" @click="toggleSelect(s.id)">
        <input type="checkbox" :checked="selected.has(s.id)" @change="toggleSelect(s.id)" />
        <div class="r-title">{{ s.title }}</div>
        <div class="r-artist">{{ s.artist }}</div>
        <div class="r-album">{{ s.album }}</div>
        <div class="r-dur">{{ fmtTime(s.duration) }}</div>
        <div class="r-ops" @click.stop>
          <button class="op" @click="playLocal(s)">▶</button>
          <button class="op" @click="startEdit(s)">✎</button>
          <button class="op" @click="library.remove(s.id, { deleteFile: false })">✕</button>
        </div>
      </div>
    </div>

    <!-- 元数据编辑弹窗 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <div class="modal">
        <h3>编辑歌曲信息</h3>
        <label>标题</label>
        <input v-model="editForm.title" class="input" />
        <label>歌手</label>
        <input v-model="editForm.artist" class="input" />
        <label>专辑</label>
        <input v-model="editForm.album" class="input" />
        <p class="hint">MP3 会写回文件标签（ID3v2），FLAC/M4A 仅更新曲库记录</p>
        <div class="modal-actions">
          <button class="btn ghost" @click="editing = null">取消</button>
          <button class="btn" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-title {
  font-size: 22px;
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.search {
  max-width: 300px;
}
.filters,
.view-toggle {
  display: flex;
  gap: 6px;
}
.chip {
  padding: 6px 14px;
  border-radius: 16px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  transition: all 0.15s;
}
.chip:hover {
  color: var(--text);
  border-color: var(--text-dim);
}
.chip.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: transparent;
}
.chip.accent {
  border-color: var(--accent);
  color: var(--accent);
}
.empty {
  color: var(--text-faint);
  text-align: center;
  padding: 80px 0;
}
.empty .sub {
  font-size: 12px;
  opacity: 0.7;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px;
}
.song-card {
  cursor: pointer;
  border-radius: var(--radius);
  padding: 8px;
  transition: background 0.15s;
  border: 1px solid transparent;
}
.song-card:hover {
  background: var(--bg-card);
}
.song-card.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.cover {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-card);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.no-cover {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  color: var(--text-faint);
  background: linear-gradient(135deg, #232323, #1a1a1a);
}
.hover-ops {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  opacity: 0;
  transition: opacity 0.2s;
}
.song-card:hover .hover-ops {
  opacity: 1;
}
.hover-ops .op {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 15px;
}
.hover-ops .op:hover {
  background: var(--accent);
}
.src-tag {
  position: absolute;
  left: 8px;
  top: 8px;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.55);
  color: #ccc;
}
.src-tag.download {
  color: var(--green);
}
.card-meta {
  padding: 8px 2px 0;
}
.c-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-artist {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.table {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  transition: background 0.15s;
}
.row:hover {
  background: var(--bg-hover);
}
.row.selected {
  background: var(--accent-dim);
}
.r-title {
  flex: 1;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-artist {
  width: 18%;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-album {
  width: 22%;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-dur {
  width: 56px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: right;
}
.r-ops {
  width: 110px;
  display: flex;
  gap: 4px;
}
.op {
  color: var(--text-dim);
  padding: 5px;
  font-size: 13px;
}
.op:hover {
  color: var(--accent);
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
.modal {
  width: 380px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.modal h3 {
  margin-bottom: 8px;
}
.modal label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}
.hint {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 6px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
</style>
