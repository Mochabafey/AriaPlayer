<script setup>
import { ref, computed, onMounted } from 'vue'
import { ncm, imgUrl } from '../api'
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

// ---- .ncm 批量转换 ----
const showConvert = ref(false)
const convertDir = ref('')
const converting = ref(false)
const convertProgress = ref({ done: 0, total: 0, ok: 0, fail: 0, current: '' })
const convertResult = ref(null) // {ok,total,ok,fail,results,outputDir}
const convertError = ref('')

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
  return s.coverPath ? `ncm-audio://cover?path=${encodeURIComponent(s.coverPath)}` : ''
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

// ---- .ncm 转换 ----
async function openConvert() {
  showConvert.value = true
  convertResult.value = null
  convertError.value = ''
  convertProgress.value = { done: 0, total: 0, ok: 0, fail: 0, current: '' }
  const dir = await ncm.convertPickDir()
  if (!dir) {
    showConvert.value = false
    return
  }
  convertDir.value = dir
}

async function startConvert() {
  if (converting.value || !convertDir.value) return
  converting.value = true
  convertResult.value = null
  convertError.value = ''
  convertProgress.value = { done: 0, total: 0, ok: 0, fail: 0, current: '' }
  try {
    const r = await ncm.convertBatch({ dir: convertDir.value, recursive: true })
    if (!r.ok) convertError.value = r.error || '转换失败'
    else convertResult.value = r
  } finally {
    converting.value = false
  }
}

function openConvertOut() {
  if (convertResult.value?.outputDir) ncm.openFolder(convertResult.value.outputDir)
}
</script>

<template>
  <div class="library">
    <div class="head">
      <h1 class="page-title">曲库</h1>
      <div class="head-actions">
        <button class="btn small" @click="openConvert">⇲ NCM 转换</button>
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
          <img v-if="s.coverPath" :src="imgUrl(coverOf(s))" alt="" loading="lazy" />
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
        <p class="hint">保存后会写回文件标签（MP3/FLAC/M4A）</p>
        <div class="modal-actions">
          <button class="btn ghost" @click="editing = null">取消</button>
          <button class="btn" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- NCM 批量转换 -->
    <div v-if="showConvert" class="modal-mask" @click.self="showConvert = false">
      <div class="modal convert-modal">
        <h3>NCM 批量转换</h3>
        <p class="hint">将网易云 .ncm 加密文件转换为 MP3 / FLAC（自动提取歌曲信息与封面）</p>

        <div class="convert-dir">
          <span class="path">{{ convertDir || '未选择目录' }}</span>
          <button class="btn small ghost" :disabled="converting" @click="openConvert()">重新选择</button>
        </div>

        <div v-if="converting || convertProgress.total" class="convert-progress">
          <div class="bar">
            <div class="fill" :style="{ width: (convertProgress.total ? (convertProgress.done / convertProgress.total) * 100 : 0) + '%' }"></div>
          </div>
          <div class="meta">
            <span v-if="converting">转换中 {{ convertProgress.done }}/{{ convertProgress.total }} · {{ convertProgress.current }}</span>
            <span v-else-if="convertResult">完成</span>
          </div>
        </div>

        <p v-if="convertError" class="err">{{ convertError }}</p>

        <div v-if="convertResult" class="convert-result">
          <p class="summary">
            成功 <span class="ok">{{ convertResult.ok }}</span> / 失败 <span class="fail">{{ convertResult.fail }}</span> / 共 {{ convertResult.total }} 首
          </p>
          <p class="out-dir">输出目录：{{ convertResult.outputDir }}</p>
        </div>

        <div class="modal-actions">
          <button class="btn ghost" @click="showConvert = false">关闭</button>
          <button v-if="!convertResult" class="btn" :disabled="!convertDir || converting" @click="startConvert">
            {{ converting ? '转换中…' : '开始转换' }}
          </button>
          <button v-else class="btn" @click="openConvertOut">打开输出目录</button>
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
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
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
  transition: background 0.18s var(--ease), transform 0.18s var(--ease), border-color 0.18s var(--ease);
  border: 1px solid transparent;
}
.song-card:hover {
  background: var(--bg-card);
  transform: translateY(-2px);
}
.song-card.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.cover {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
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
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  opacity: 0;
  transition: opacity 0.2s var(--ease);
}
.song-card:hover .hover-ops {
  opacity: 1;
}
.hover-ops .op {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 15px;
  backdrop-filter: blur(4px);
  transition: background 0.15s, transform 0.12s var(--ease);
}
.hover-ops .op:hover {
  background: var(--accent);
  transform: scale(1.08);
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
.convert-modal {
  width: 460px;
}
.convert-dir {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 8px;
}
.convert-dir .path {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.convert-progress {
  margin-top: 12px;
}
.convert-progress .bar {
  height: 8px;
  border-radius: 4px;
  background: #2c2c2c;
  overflow: hidden;
}
.convert-progress .fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.25s;
}
.convert-progress .meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 6px;
}
.convert-result {
  margin-top: 10px;
  font-size: 13px;
}
.convert-result .summary .ok {
  color: var(--green);
  font-weight: 600;
}
.convert-result .summary .fail {
  color: var(--accent);
  font-weight: 600;
}
.convert-result .out-dir {
  color: var(--text-faint);
  font-size: 12px;
  word-break: break-all;
  margin-top: 4px;
}
.err {
  color: var(--accent);
  font-size: 13px;
  margin-top: 8px;
}
</style>
