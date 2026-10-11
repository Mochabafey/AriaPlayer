<script setup>
/**
 * 曲库页 —— 双栏结构：左侧歌单栏 + 右侧曲目区。
 *
 * ## 交互设计要点
 *
 * 1. **两栏共享一套选择模型**：选中态属于「当前视图」（曲库 or 某歌单），
 *    切换视图时清空 —— 否则会出现「在 A 歌单选中的歌，切到 B 歌单还高亮」
 *    这种让人不敢按删除的错觉。
 *
 * 2. **批量操作走底部浮动条**，不在头部堆按钮。曲库动辄上千首，
 *    多选是高频操作，浮动条始终在视口内且不随滚动消失。
 *
 * 3. **右键菜单承载低频操作**（加歌单/移出/编辑/删除），
 *    头部只留最高频的「导入/新建/视图切换」。
 *
 * 4. **空态区分三种情况**：曲库空 / 歌单空 / 搜索无结果。
 *    三者文案与引导动作完全不同，混用会让人以为是 bug。
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { ncm, imgUrl } from '../api'
import { useLibraryStore } from '../stores/library'
import { usePlaylistStore } from '../stores/playlist'
import { usePlayerStore } from '../stores/player'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { fmtTime, fmtDate } from '../utils/format'
import { toast } from '../utils/toast'
import ContextMenu from '../components/ContextMenu.vue'
import PromptModal from '../components/PromptModal.vue'

const library = useLibraryStore()
const playlists = usePlaylistStore()
const player = usePlayerStore()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

/* ---------- 视图状态 ---------- */

/** 'library' = 全部歌曲；'playlist' = 某个歌单 */
const pane = ref('library')
const currentPlaylistId = ref(null)

const query = ref('')
const view = ref(localStorage.getItem('library.view') || 'grid') // grid | list
const filter = ref('all') // all | download | import
const sort = ref(localStorage.getItem('library.sort') || 'added') // added | title | artist | duration

/** 选中集合：id → true（用 Map 而非 Set 便于响应式增删） */
const selected = ref(new Map())
const coverErrors = ref(new Set())

/** 歌单详情的加载态（与曲库分开，避免互相影响） */
const detailLoading = ref(false)

const currentPlaylist = computed(() => playlists.byId(currentPlaylistId.value))

/** 当前视图的曲目列表（统一成同一形状，供渲染与播放复用） */
const rows = computed(() => {
  if (pane.value === 'playlist') {
    return playlists.detail(currentPlaylistId.value)?.songs || []
  }
  return library.songs
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return rows.value.filter((s) => {
    if (pane.value === 'library' && filter.value !== 'all' && s.source !== filter.value) return false
    if (!q) return true
    return [s.title, s.artist, s.album].some((v) => (v || '').toLowerCase().includes(q))
  })
})

const sorted = computed(() => {
  const list = [...filtered.value]
  // 歌单视图保持歌单自身的顺序（用户手动排过序，不该被自动重排覆盖）
  if (pane.value === 'playlist') return list
  switch (sort.value) {
    case 'title':
      return list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'))
    case 'artist':
      return list.sort((a, b) => String(a.artist || '').localeCompare(String(b.artist || ''), 'zh'))
    case 'duration':
      return list.sort((a, b) => (b.duration || 0) - (a.duration || 0))
    default:
      return list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  }
})

const selectedIds = computed(() => [...selected.value.keys()])
const selectedCount = computed(() => selected.value.size)

/** 曲库页展示「歌单外」还是「已下载」等统计 */
const stats = computed(() => {
  const all = library.songs.length
  const dl = library.songs.filter((s) => s.source === 'download').length
  const im = library.songs.filter((s) => s.source === 'import').length
  return { all, dl, im }
})

/* ---------- 持久化视图偏好 ---------- */
watch(view, (v) => localStorage.setItem('library.view', v))
watch(sort, (v) => localStorage.setItem('library.sort', v))

/* ---------- 选择 ---------- */

function isSelected(s) {
  return selected.value.has(keyOf(s))
}

/**
 * 选中键：优先用 id，快照曲目（在线导入）的 id 可能是数字，
 * 统一转字符串避免 Map 键类型不一致导致「选中了但取消不掉」。
 */
function keyOf(s) {
  return String(s?._pid ?? s?.id ?? s?.filePath ?? '')
}

function toggleSelect(s) {
  const k = keyOf(s)
  const m = new Map(selected.value)
  if (m.has(k)) m.delete(k)
  else m.set(k, s)
  selected.value = m
}

function selectAll() {
  if (selectedCount.value === sorted.value.length && sorted.value.length > 0) {
    selected.value = new Map()
  } else {
    const m = new Map()
    for (const s of sorted.value) m.set(keyOf(s), s)
    selected.value = m
  }
}

function clearSelection() {
  selected.value = new Map()
}

/** 切换视图/歌单时清空选择，避免误操作 */
watch([pane, currentPlaylistId, filter], () => clearSelection())

/* ---------- 播放 ---------- */

function playAt(index) {
  const list = sorted.value
  if (!list[index]) return
  player.playList(list, index)
}

function playAll() {
  if (!sorted.value.length) return
  player.playList(sorted.value, 0)
}

function enqueueAll() {
  if (!sorted.value.length) return
  player.enqueue(sorted.value)
  toast(`已加入队列 ${sorted.value.length} 首`, 'success')
}

function playSelected() {
  const list = sorted.value.filter(isSelected)
  if (!list.length) return
  player.playList(list, 0)
}

/* ---------- 歌单导航 ---------- */

async function openLibrary() {
  pane.value = 'library'
  currentPlaylistId.value = null
}

async function openPlaylist(p) {
  pane.value = 'playlist'
  currentPlaylistId.value = p.id
  detailLoading.value = true
  try {
    await playlists.fetchDetail(p.id)
  } finally {
    detailLoading.value = false
  }
}

/* ---------- 歌单 CRUD ---------- */

const prompt = ref({ show: false, mode: 'prompt', title: '', message: '', value: '', placeholder: '', confirmText: '确定', danger: false, onConfirm: null })

function askPrompt(cfg) {
  prompt.value = {
    show: true,
    mode: 'prompt',
    title: '',
    message: '',
    value: '',
    placeholder: '',
    confirmText: '确定',
    danger: false,
    ...cfg
  }
}

function askConfirm(cfg) {
  prompt.value = { show: true, mode: 'confirm', title: '', message: '', confirmText: '确定', danger: false, ...cfg }
}

function onPromptConfirm(v) {
  prompt.value.onConfirm?.(v)
}

async function createPlaylist() {
  askPrompt({
    title: '新建歌单',
    placeholder: '歌单名称',
    value: '',
    hint: selectedCount.value ? `将把当前选中的 ${selectedCount.value} 首一并加入` : '创建后可随时添加歌曲',
    confirmText: '创建',
    onConfirm: async (name) => {
      try {
        const ids = selectedCount.value ? selectedIds.value : []
        const p = await playlists.create(name, ids)
        toast(`已创建「${p.name}」${ids.length ? `，含 ${ids.length} 首` : ''}`, 'success')
        clearSelection()
        openPlaylist(p)
      } catch (e) {
        toast('创建失败：' + (e.message || '未知错误'), 'error')
      }
    }
  })
}

function renamePlaylist(p) {
  askPrompt({
    title: '重命名歌单',
    value: p.name,
    confirmText: '保存',
    onConfirm: async (name) => {
      await playlists.rename(p.id, name)
      toast('已重命名', 'success')
    }
  })
}

function removePlaylist(p) {
  const n = playlists.countOf(p)
  askConfirm({
    title: '删除歌单',
    message: `确定删除「${p.name}」吗？${n ? `（含 ${n} 首，仅删除歌单，不影响曲库文件）` : ''}`,
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      await playlists.remove(p.id)
      if (currentPlaylistId.value === p.id) openLibrary()
      toast('已删除歌单', 'success')
    }
  })
}

/* ---------- 向歌单加歌 ---------- */

const addToTarget = ref(null) // 正在选择「加入哪个歌单」的歌曲

function addSelectedToPlaylist() {
  const list = sorted.value.filter(isSelected)
  if (!list.length) return
  addToTarget.value = list
}

async function addTo(p) {
  const list = addToTarget.value || []
  if (!list.length) return
  const ids = list.map(keyOf)
  try {
    const r = await playlists.addSongs(p.id, ids)
    const skipped = r?.skipped || 0
    toast(
      skipped
        ? `已向「${p.name}」添加 ${r.added} 首（${skipped} 首已在歌单中）`
        : `已向「${p.name}」添加 ${r?.added ?? ids.length} 首`,
      'success'
    )
    addToTarget.value = null
    clearSelection()
  } catch (e) {
    toast('添加失败：' + (e.message || '未知错误'), 'error')
  }
}

/* ---------- 从歌单移出 ---------- */

function removeFromPlaylist(songs) {
  const p = currentPlaylist.value
  if (!p || !songs.length) return
  askConfirm({
    title: '移出歌单',
    message: `从「${p.name}」移出 ${songs.length} 首？（不会删除曲库中的文件）`,
    confirmText: '移出',
    danger: true,
    onConfirm: async () => {
      const r = await playlists.removeSongs(p.id, songs.map(keyOf))
      toast(`已移出 ${r?.removed ?? songs.length} 首`, 'success')
      clearSelection()
    }
  })
}

/** 从曲库删除（可选连文件一起删） */
function removeFromLibrary(songs) {
  if (!songs.length) return
  const n = songs.length
  askConfirm({
    title: '从曲库移除',
    message: `从曲库移除 ${n} 首？仅移除索引记录，不会删除磁盘文件。`,
    confirmText: '移除',
    danger: true,
    onConfirm: async () => {
      // 逐个删但只重载一次：library.remove 内部会 load()，
      // 对上百首的批量删除会变成上百次全量查询。这里直接调 IPC，
      // 循环结束后统一刷新。
      let done = 0
      for (const s of songs) {
        if (!s.filePath || !s.id) continue
        try {
          await ncm.libraryRemove(s.id, { deleteFile: false })
          done++
        } catch { /* 单条失败不中断其余 */ }
      }
      await library.load()
      toast(`已移除 ${done} 首`, 'success')
      clearSelection()
    }
  })
}

/* ---------- 右键菜单 ---------- */

/** 歌曲右键菜单状态 */
const ctx = ref({ show: false, x: 0, y: 0, song: null })
/** 歌单右键菜单状态（与歌曲菜单互斥，共用 ContextMenu 组件但独立状态更清晰） */
const plCtx = ref({ show: false, x: 0, y: 0, playlist: null })

function openCtx(e, song) {
  e.preventDefault()
  plCtx.value.show = false
  // 右键未选中的歌 → 先只选中它（符合资源管理器/音乐软件的通行直觉）
  const k = keyOf(song)
  if (!selected.value.has(k)) {
    selected.value = new Map([[k, song]])
  }
  ctx.value = { show: true, x: e.clientX, y: e.clientY, song }
}

function openPlCtx(e, p) {
  ctx.value.show = false
  plCtx.value = { show: true, x: e.clientX, y: e.clientY, playlist: p }
}

const plCtxItems = computed(() => {
  const p = plCtx.value.playlist
  if (!p) return []
  const n = playlists.countOf(p)
  return [
    { label: '打开', icon: '▸', action: () => openPlaylist(p) },
    {
      label: '播放全部',
      icon: '▶',
      disabled: !n,
      action: async () => {
        const d = await playlists.fetchDetail(p.id)
        if (d?.songs?.length) player.playList(d.songs, 0)
      }
    },
    { divider: true },
    { label: '重命名', icon: '✎', action: () => renamePlaylist(p) },
    {
      label: '导出…',
      icon: '⇧',
      disabled: !n,
      action: async () => {
        await openPlaylist(p)
        showExport.value = true
      }
    },
    { divider: true },
    { label: '删除歌单', icon: '✕', danger: true, action: () => removePlaylist(p) }
  ]
})

const ctxItems = computed(() => {
  const song = ctx.value.song
  if (!song) return []
  const isPlaylist = pane.value === 'playlist'
  const multi = selectedCount.value > 1
  const suffix = multi ? `（${selectedCount.value} 首）` : ''
  const target = multi ? sorted.value.filter(isSelected) : [song]

  const items = [
    { label: '播放', icon: '▶', action: () => player.playList(sorted.value, sorted.value.indexOf(song)) },
    { label: '下一首播放', icon: '⏭', action: () => { player.playNext(song); toast('已插入下一首', 'success') } },
    { label: '加入队列', icon: '＋', action: () => { player.enqueue([song]); toast('已加入队列', 'success') } },
    { divider: true },
    { label: `添加到歌单…${suffix}`, icon: '☰', action: () => { addToTarget.value = target } }
  ]

  if (isPlaylist) {
    items.push({
      label: `从歌单移出${suffix}`,
      icon: '−',
      danger: true,
      action: () => removeFromPlaylist(target)
    })
  } else if (song.id && song.filePath) {
    items.push({ label: '编辑信息', icon: '✎', action: () => startEdit(song) })
    items.push({
      label: `从曲库移除${suffix}`,
      icon: '✕',
      danger: true,
      action: () => removeFromLibrary(target)
    })
  }

  // 在线快照曲目（未下载）：给一个「下载」入口，把在线曲目落到本地
  if (!song.filePath && song.id) {
    items.push({ divider: true })
    items.push({
      label: '下载到本地',
      icon: '⇩',
      action: () => downloadSong(song)
    })
  }

  if (song.filePath) {
    items.push({ divider: true })
    items.push({ label: '在文件夹中显示', icon: '⌸', action: () => ncm.openFolder(song.filePath) })
  }

  return items
})

async function downloadSong(song) {
  // downloads.add 内部已按结果给 toast（成功/重复/失败三种），
  // 这里不再重复提示，只兜住它自身抛出的异常。
  try {
    await downloads.add({
      songId: song.id,
      title: song.title,
      artist: song.artist,
      cover: song.coverPath || song.pic || null,
      quality: settings.settings.quality || '320000'
    })
  } catch (e) {
    toast('下载失败：' + (e.message || '未知错误'), 'error')
  }
}

/* ---------- 元数据编辑 ---------- */

const editing = ref(null)
const editForm = ref({ title: '', artist: '', album: '' })

function startEdit(song) {
  if (!song?.id || !song.filePath) {
    toast('仅曲库内的本地歌曲可编辑信息', 'error')
    return
  }
  editing.value = song
  editForm.value = { title: song.title || '', artist: song.artist || '', album: song.album || '' }
}

async function saveEdit() {
  if (!editing.value) return
  try {
    await library.edit(editing.value.id, editForm.value)
    toast('已保存并写回文件标签', 'success')
    editing.value = null
    if (pane.value === 'playlist') await playlists.fetchDetail(currentPlaylistId.value, { force: true })
  } catch (e) {
    toast('保存失败：' + (e.message || '未知错误'), 'error')
  }
}

/* ---------- 导入 ---------- */

const showImport = ref(false)
const importUrl = ref('')
const importing = ref(false)
const importError = ref('')

function openImport() {
  showImport.value = true
  importUrl.value = ''
  importError.value = ''
}

/**
 * 从输入里解析网易云歌单 ID。
 *
 * 支持用户直接粘贴分享文案（"分享歌单: xxx https://163cn.tv/xxx"）、
 * 完整链接、或纯 ID —— 这是实际使用中最常见的三种输入。
 */
function parsePlaylistId(input) {
  const s = String(input || '').trim()
  if (!s) return null
  if (/^\d{5,20}$/.test(s)) return s
  const m = /playlist[/?=]+(?:id[=/])?(\d{5,20})/i.exec(s)
  if (m) return m[1]
  const m2 = /[?&]id=(\d{5,20})/.exec(s)
  if (m2) return m2[1]
  const m3 = /(\d{5,20})/.exec(s)
  return m3 ? m3[1] : null
}

async function doImportNetease() {
  const id = parsePlaylistId(importUrl.value)
  if (!id) {
    importError.value = '没能识别出歌单 ID，请粘贴歌单链接或纯数字 ID'
    return
  }
  importing.value = true
  importError.value = ''
  try {
    const r = await playlists.importNetease(id)
    if (!r?.ok) {
      importError.value = r?.reason || '导入失败'
      return
    }
    toast(`已导入「${r.playlist.name}」共 ${r.count} 首`, 'success')
    showImport.value = false
    openPlaylist(r.playlist)
  } catch (e) {
    importError.value = e.message || '导入失败'
  } finally {
    importing.value = false
  }
}

/** 导入本地歌单文件（m3u/json）—— 会把文件加入曲库 */
async function importFile(targetId = null) {
  try {
    const r = await playlists.importFile(targetId)
    if (!r?.ok) {
      if (!r?.canceled) toast(r?.reason || '导入失败', 'error')
      return
    }
    const bits = []
    if (r.imported) bits.push(`新入库 ${r.imported} 首`)
    if (r.added) bits.push(`加入歌单 ${r.added} 首`)
    if (r.missing) bits.push(`跳过 ${r.missing} 个无效路径`)
    toast(bits.length ? bits.join('，') : '没有可导入的曲目', bits.length ? 'success' : 'info')
    await library.load()
  } catch (e) {
    toast('导入失败：' + (e.message || '未知错误'), 'error')
  }
}

/** 导入 m3u 为歌单（只收曲库已有的文件） */
async function importM3uAsPlaylist() {
  try {
    const r = await ncm.playlistImportM3u(null)
    if (!r) return
    toast(`已导入「${r.playlist.name}」：匹配 ${r.matched} 首${r.missing ? `，跳过 ${r.missing} 首（不在曲库）` : ''}`, 'success')
    await playlists.load()
    openPlaylist(r.playlist)
  } catch (e) {
    toast('导入失败：' + (e.message || '未知错误'), 'error')
  }
}

/* ---------- 导出 ---------- */

const showExport = ref(false)

async function doExport(format) {
  const p = currentPlaylist.value
  if (!p) return
  const r = await ncm.playlistExport({ id: p.id, format })
  showExport.value = false
  if (r?.canceled) return
  if (!r?.ok) {
    toast(r?.reason || '导出失败', 'error')
    return
  }
  toast(
    r.skipped
      ? `已导出 ${r.count} 首（${r.skipped} 首在线曲目无本地文件，已跳过）`
      : `已导出 ${r.count} 首`,
    'success'
  )
}

/* ---------- 曲库导入导出 ---------- */

async function exportLibrary(type) {
  const p = await ncm.libraryExport(type)
  if (p) toast('已导出曲库清单', 'success')
}

async function importLibrary() {
  const n = await ncm.libraryImport()
  await library.load()
  if (n > 0) toast(`已导入 ${n} 首到曲库`, 'success')
  else toast('没有导入任何曲目（文件可能已在曲库或路径无效）', 'info')
}

/* ---------- NCM 转换 ---------- */

const showConvert = ref(false)
const convertPath = ref('')
const convertType = ref('dir')
const converting = ref(false)
const convertProgress = ref({ done: 0, total: 0, ok: 0, fail: 0, current: '' })
const convertResult = ref(null)
const convertError = ref('')
const convertFormat = ref('auto')

const convertFormats = [
  { value: 'auto', label: '自动', desc: '跟随原文件' },
  { value: 'mp3', label: 'MP3', desc: '兼容性最好' },
  { value: 'flac', label: 'FLAC', desc: '无损' },
  { value: 'm4a', label: 'M4A', desc: 'AAC 高效' },
  { value: 'wav', label: 'WAV', desc: '无压缩' }
]

function pathLooksLikeFile(p) {
  return /\.ncm$/i.test(p || '')
}

async function openConvert() {
  showConvert.value = true
  convertResult.value = null
  convertError.value = ''
  convertProgress.value = { done: 0, total: 0, ok: 0, fail: 0, current: '' }
  if (!settings.loaded) await settings.load()
  if (!convertPath.value && settings.settings.lastConvertPath) {
    convertPath.value = settings.settings.lastConvertPath
    convertType.value = pathLooksLikeFile(settings.settings.lastConvertPath) ? 'file' : 'dir'
  }
}

async function pickConvertFile() {
  try {
    const sel = await ncm.convertPickFile()
    if (sel) {
      convertPath.value = sel.path
      convertType.value = sel.type
    }
  } catch (e) {
    convertError.value = e.message || '打开文件选择失败'
  }
}

async function pickConvertDir() {
  try {
    const sel = await ncm.convertPickDir()
    if (sel) {
      convertPath.value = sel.path
      convertType.value = sel.type
    }
  } catch (e) {
    convertError.value = e.message || '打开目录选择失败'
  }
}

async function startConvert() {
  if (converting.value || !convertPath.value) return
  converting.value = true
  convertResult.value = null
  convertError.value = ''
  convertProgress.value = { done: 0, total: 0, ok: 0, fail: 0, current: '' }
  try {
    const r = await ncm.convertBatch({ path: convertPath.value, recursive: true, format: convertFormat.value })
    if (!r.ok) convertError.value = r.error || '转换失败'
    else convertResult.value = r
  } finally {
    converting.value = false
  }
}

function openConvertOut() {
  if (convertResult.value?.outputDir) ncm.openFolder(convertResult.value.outputDir)
}

/* ---------- 文件夹 ---------- */

async function pickFolder() {
  const dir = await ncm.librarySelectFolder()
  if (dir) {
    toast('正在扫描…', 'info')
    await library.addFolder(dir)
    toast('扫描完成', 'success')
  }
}

const showFolders = ref(false)

async function removeFolder(f) {
  askConfirm({
    title: '移除监控文件夹',
    message: `不再监控「${f}」？已入库的歌曲记录会保留。`,
    confirmText: '移除',
    danger: true,
    onConfirm: async () => {
      // 主进程没有单独的「移除文件夹」接口，用设置层记录忽略列表会更重；
      // 这里通过曲库 store 暴露的接口完成（见 stores/library.js 的 removeFolder）
      await library.removeFolder(f)
      toast('已移除监控文件夹', 'success')
    }
  })
}

/* ---------- 封面 ---------- */

function coverOf(s) {
  if (s.coverPath) return `ncm-audio://cover?path=${encodeURIComponent(s.coverPath)}`
  if (s.pic) return s.pic
  return ''
}

function onCoverError(s) {
  const k = keyOf(s)
  coverErrors.value = new Set(coverErrors.value).add(k)
}

function hasCover(s) {
  return !!coverOf(s) && !coverErrors.value.has(keyOf(s))
}

/* ---------- 生命周期 ---------- */

let offLibrary = null

onMounted(async () => {
  await Promise.all([library.load(), playlists.load()])
  downloads.watch()
  offLibrary = ncm.onLibraryUpdated(() => {
    library.load()
    if (pane.value === 'playlist' && currentPlaylistId.value) {
      playlists.fetchDetail(currentPlaylistId.value, { force: true })
    }
  })
  ncm.onConvertProgress((p) => {
    if (!p) return
    convertProgress.value = {
      done: p.done ?? convertProgress.value.done,
      total: p.total ?? convertProgress.value.total,
      ok: p.ok ?? convertProgress.value.ok,
      fail: p.fail ?? convertProgress.value.fail,
      current: p.current ?? convertProgress.value.current
    }
  })
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  offLibrary?.()
})

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (ctx.value.show) ctx.value.show = false
    else if (plCtx.value.show) plCtx.value.show = false
    else if (prompt.value.show) prompt.value.show = false
    else if (editing.value) editing.value = null
    else if (showImport.value) showImport.value = false
    else if (showConvert.value) showConvert.value = false
    else if (showExport.value) showExport.value = false
    else if (addToTarget.value) addToTarget.value = null
    else if (selectedCount.value) clearSelection()
    return
  }
  // Ctrl+A 全选（输入框内不劫持）
  const tag = e.target?.tagName
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault()
    selectAll()
  }
}
</script>

<template>
  <div class="library">
    <!-- ============ 左侧：歌单栏 ============ -->
    <aside class="side">
      <button class="side-item" :class="{ active: pane === 'library' }" @click="openLibrary">
        <span class="si-icon">♫</span>
        <span class="si-label">全部歌曲</span>
        <span class="si-count">{{ stats.all }}</span>
      </button>

      <div class="side-sep"></div>

      <div class="side-head">
        <span class="sh-title">我的歌单</span>
        <button class="sh-add" title="新建歌单" @click="createPlaylist">＋</button>
      </div>

      <div class="side-list">
        <button
          v-for="p in playlists.list"
          :key="p.id"
          class="side-item pl"
          :class="{ active: pane === 'playlist' && currentPlaylistId === p.id }"
          :title="p.name"
          @click="openPlaylist(p)"
          @contextmenu.prevent="openPlCtx($event, p)"
        >
          <span class="si-icon" :class="{ netease: p.source === 'netease' }">
            {{ p.source === 'netease' ? '云' : p.source === 'm3u' ? '⇪' : '☰' }}
          </span>
          <span class="si-label">{{ p.name }}</span>
          <span class="si-count">{{ playlists.countOf(p) }}</span>
        </button>

        <p v-if="!playlists.list.length" class="side-empty">
          还没有歌单<br />
          <span class="se-sub">点上方 ＋ 新建，或导入一个</span>
        </p>
      </div>

      <div class="side-foot">
        <button class="side-btn" @click="openImport">⇩ 导入歌单</button>
        <button class="side-btn" @click="showFolders = true">⌸ 监控文件夹</button>
      </div>
    </aside>

    <!-- ============ 右侧：主区 ============ -->
    <section class="main">
      <div class="head">
        <div class="head-left">
          <h1 class="page-title">{{ pane === 'playlist' ? currentPlaylist?.name || '歌单' : '曲库' }}</h1>
          <p v-if="pane === 'playlist'" class="head-sub">
            {{ playlists.countOf(currentPlaylist) }} 首
            <span v-if="currentPlaylist?.source === 'netease'" class="src-badge netease">网易云导入</span>
            <span v-else-if="currentPlaylist?.source === 'm3u'" class="src-badge m3u">M3U 导入</span>
            <span v-if="playlists.detail(currentPlaylistId)?.missing" class="src-badge warn">
              {{ playlists.detail(currentPlaylistId).missing }} 首已不在曲库
            </span>
          </p>
        </div>

        <div class="head-actions">
          <button class="btn small" :disabled="!sorted.length" @click="playAll">▶ 播放全部</button>
          <button class="btn small ghost" :disabled="!sorted.length" @click="enqueueAll">＋ 加入队列</button>
          <button v-if="pane === 'playlist'" class="btn small ghost" @click="showExport = true">⇧ 导出</button>
          <button v-else class="btn small ghost" @click="openConvert">⇲ NCM 转换</button>
        </div>
      </div>

      <div class="toolbar">
        <input v-model="query" class="input search" placeholder="搜索标题 / 歌手 / 专辑" />

        <div v-if="pane === 'library'" class="filters">
          <button class="chip" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部 {{ stats.all }}</button>
          <button class="chip" :class="{ active: filter === 'download' }" @click="filter = 'download'">已下载 {{ stats.dl }}</button>
          <button class="chip" :class="{ active: filter === 'import' }" @click="filter = 'import'">本地导入 {{ stats.im }}</button>
        </div>

        <select v-if="pane === 'library'" v-model="sort" class="sort-select" title="排序方式">
          <option value="added">最近添加</option>
          <option value="title">按标题</option>
          <option value="artist">按歌手</option>
          <option value="duration">按时长</option>
        </select>

        <div class="view-toggle">
          <button class="chip" :class="{ active: view === 'grid' }" @click="view = 'grid'" title="封面墙">▦</button>
          <button class="chip" :class="{ active: view === 'list' }" @click="view = 'list'" title="列表">☰</button>
        </div>

        <span v-if="pane === 'library'" class="toolbar-spacer"></span>
        <template v-if="pane === 'library'">
          <button class="link-btn" @click="pickFolder">＋ 添加文件夹</button>
          <button class="link-btn" @click="library.scan()">{{ library.scanning ? '扫描中…' : '↻ 重新扫描' }}</button>
          <button class="link-btn" @click="importLibrary">⇪ 导入清单</button>
          <button class="link-btn" @click="exportLibrary('m3u')">⇓ M3U</button>
          <button class="link-btn" @click="exportLibrary('json')">⇓ JSON</button>
        </template>
      </div>

      <!-- 加载中 -->
      <div v-if="detailLoading" class="placeholder">加载歌单…</div>

      <!-- 空态：三种情况分别引导 -->
      <div v-else-if="!sorted.length" class="empty-wrap">
        <template v-if="query.trim()">
          <div class="empty-icon">⌕</div>
          <p class="empty-title">没有匹配「{{ query }}」的歌曲</p>
          <p class="empty-sub">试试其它关键词，或清空搜索框</p>
          <button class="btn small ghost" @click="query = ''">清空搜索</button>
        </template>
        <template v-else-if="pane === 'playlist'">
          <div class="empty-icon">☰</div>
          <p class="empty-title">这个歌单还是空的</p>
          <p class="empty-sub">回到「全部歌曲」勾选曲目，右键「添加到歌单」</p>
          <button class="btn small ghost" @click="openLibrary">去曲库挑歌</button>
        </template>
        <template v-else>
          <div class="empty-icon">♫</div>
          <p class="empty-title">曲库为空</p>
          <p class="empty-sub">添加文件夹自动扫描，或从搜索 / 解析页下载歌曲</p>
          <div class="empty-actions">
            <button class="btn small" @click="pickFolder">＋ 添加文件夹</button>
            <button class="btn small ghost" @click="importLibrary">⇪ 导入清单</button>
          </div>
        </template>
      </div>

      <!-- 封面墙 -->
      <div v-else-if="view === 'grid'" class="grid">
        <div
          v-for="(s, i) in sorted"
          :key="keyOf(s)"
          class="song-card"
          :class="{ selected: isSelected(s) }"
          @click="toggleSelect(s)"
          @dblclick="playAt(i)"
          @contextmenu="openCtx($event, s)"
        >
          <div class="cover">
            <img
              v-if="hasCover(s)"
              :src="imgUrl(coverOf(s))"
              alt=""
              loading="lazy"
              @error="onCoverError(s)"
            />
            <div v-else class="no-cover">♪</div>

            <!-- 播放按钮：常驻在封面右下，hover 才浮现 -->
            <button class="play-fab" title="播放" @click.stop="playAt(i)">▶</button>

            <span v-if="pane === 'library'" class="src-tag" :class="s.source">
              {{ s.source === 'download' ? '下载' : '导入' }}
            </span>
            <span v-else-if="!s.filePath" class="src-tag online">在线</span>

            <!-- 选中标记 -->
            <span v-if="isSelected(s)" class="check">✓</span>
          </div>
          <div class="card-meta">
            <div class="c-title" :title="s.title">{{ s.title }}</div>
            <div class="c-artist" :title="s.artist">{{ s.artist || '未知歌手' }}</div>
          </div>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="table">
        <div class="thead">
          <span class="th-check"></span>
          <span class="th-title">标题</span>
          <span class="th-artist">歌手</span>
          <span class="th-album">专辑</span>
          <span class="th-dur">时长</span>
          <span class="th-ops"></span>
        </div>
        <div
          v-for="(s, i) in sorted"
          :key="keyOf(s)"
          class="row"
          :class="{ selected: isSelected(s) }"
          @click="toggleSelect(s)"
          @dblclick="playAt(i)"
          @contextmenu="openCtx($event, s)"
        >
          <input type="checkbox" :checked="isSelected(s)" @click.stop="toggleSelect(s)" />
          <div class="r-title" :title="s.title">
            <span v-if="!s.filePath && pane === 'playlist'" class="dot-online" title="在线曲目"></span>
            {{ s.title }}
          </div>
          <div class="r-artist" :title="s.artist">{{ s.artist }}</div>
          <div class="r-album" :title="s.album">{{ s.album }}</div>
          <div class="r-dur">{{ fmtTime(s.duration) }}</div>
          <div class="r-ops" @click.stop>
            <button class="op" title="播放" @click="playAt(i)">▶</button>
            <button class="op" title="更多" @click="openCtx($event, s)">⋯</button>
          </div>
        </div>
      </div>

      <!-- ============ 底部批量操作条 ============ -->
      <Transition name="bulk">
        <div v-if="selectedCount" class="bulk-bar">
          <span class="bulk-count">已选 <b>{{ selectedCount }}</b> 首</span>
          <div class="bulk-actions">
            <button class="bulk-btn" @click="playSelected">▶ 播放</button>
            <button class="bulk-btn" @click="addSelectedToPlaylist">☰ 添加到歌单</button>
            <button
              v-if="pane === 'playlist'"
              class="bulk-btn danger"
              @click="removeFromPlaylist(sorted.filter(isSelected))"
            >
              − 移出歌单
            </button>
            <button
              v-else
              class="bulk-btn danger"
              @click="removeFromLibrary(sorted.filter(isSelected))"
            >
              ✕ 移出曲库
            </button>
            <button class="bulk-btn" @click="selectAll">
              {{ selectedCount === sorted.length ? '取消全选' : '全选' }}
            </button>
            <button class="bulk-close" title="取消选择" @click="clearSelection">✕</button>
          </div>
        </div>
      </Transition>
    </section>

    <!-- ============ 右键菜单 ============ -->
    <ContextMenu
      :show="ctx.show"
      :at="{ x: ctx.x, y: ctx.y }"
      :items="ctxItems"
      @close="ctx.show = false"
    />
    <ContextMenu
      :show="plCtx.show"
      :at="{ x: plCtx.x, y: plCtx.y }"
      :items="plCtxItems"
      @close="plCtx.show = false"
    />

    <!-- ============ 通用提示框 ============ -->
    <PromptModal
      v-model:show="prompt.show"
      :mode="prompt.mode"
      :title="prompt.title"
      :message="prompt.message"
      :model-value="prompt.value"
      :placeholder="prompt.placeholder"
      :hint="prompt.hint"
      :confirm-text="prompt.confirmText"
      :danger="prompt.danger"
      @confirm="onPromptConfirm"
    />

    <!-- ============ 添加到歌单 ============ -->
    <Teleport to="body">
      <div v-if="addToTarget" class="modal-mask" @click.self="addToTarget = null">
        <div class="modal pick-modal">
          <h3>添加到歌单</h3>
          <p class="hint">已选 {{ addToTarget.length }} 首</p>

          <button class="pick-new" @click="addToTarget = null; createPlaylist()">＋ 新建歌单…</button>

          <div class="pick-list">
            <button
              v-for="p in playlists.list"
              :key="p.id"
              class="pick-item"
              @click="addTo(p)"
            >
              <span class="pi-name">{{ p.name }}</span>
              <span class="pi-count">{{ playlists.countOf(p) }} 首</span>
            </button>
            <p v-if="!playlists.list.length" class="pick-empty">还没有歌单，先新建一个吧</p>
          </div>

          <div class="modal-actions">
            <button class="btn ghost" @click="addToTarget = null">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ 导入歌单 ============ -->
    <Teleport to="body">
      <div v-if="showImport" class="modal-mask" @click.self="showImport = false">
        <div class="modal">
          <h3>导入歌单</h3>

          <div class="imp-block">
            <label class="imp-label">从网易云导入</label>
            <input
              v-model="importUrl"
              class="input"
              placeholder="粘贴歌单链接或 ID，如 123456789"
              @keydown.enter.prevent="doImportNetease"
            />
            <p class="hint">
              支持分享链接（163cn.tv / music.163.com）或纯数字 ID。
              导入后会保存一份曲目快照，可离线浏览、按需下载。
            </p>
            <p v-if="importError" class="err">{{ importError }}</p>
            <button class="btn small" :disabled="importing || !importUrl.trim()" @click="doImportNetease">
              {{ importing ? '导入中…' : '导入网易云歌单' }}
            </button>
          </div>

          <div class="imp-sep"><span>或</span></div>

          <div class="imp-block">
            <label class="imp-label">从本地文件导入</label>
            <p class="hint">
              M3U / JSON 歌单文件。文件里指向的歌曲会自动加入曲库并建立歌单。
            </p>
            <div class="imp-actions">
              <button class="btn small ghost" @click="importFile()">选择文件并建歌单</button>
              <button class="btn small ghost" @click="importM3uAsPlaylist">只建歌单（用曲库已有）</button>
            </div>
          </div>

          <div class="modal-actions">
            <button class="btn ghost" @click="showImport = false">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ 导出歌单 ============ -->
    <Teleport to="body">
      <div v-if="showExport" class="modal-mask" @click.self="showExport = false">
        <div class="modal">
          <h3>导出歌单</h3>
          <p class="hint">「{{ currentPlaylist?.name }}」共 {{ playlists.countOf(currentPlaylist) }} 首</p>
          <div class="fmt-options vertical">
            <button class="fmt-btn" @click="doExport('m3u')">
              <b>M3U</b><span>通用播放列表，可在其它播放器打开（仅含本地文件）</span>
            </button>
            <button class="fmt-btn" @click="doExport('json')">
              <b>JSON</b><span>完整快照，含在线曲目信息，适合备份</span>
            </button>
            <button class="fmt-btn" @click="doExport('txt')">
              <b>TXT</b><span>纯歌名清单，方便分享</span>
            </button>
          </div>
          <div class="modal-actions">
            <button class="btn ghost" @click="showExport = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ 监控文件夹 ============ -->
    <Teleport to="body">
      <div v-if="showFolders" class="modal-mask" @click.self="showFolders = false">
        <div class="modal">
          <h3>监控文件夹</h3>
          <p class="hint">这些文件夹里的音频文件会被扫描进曲库</p>
          <div class="folder-list">
            <div v-for="f in library.folders" :key="f" class="folder-row">
              <span class="fr-path" :title="f">{{ f }}</span>
              <button class="op" title="移除" @click="removeFolder(f)">✕</button>
            </div>
            <p v-if="!library.folders.length" class="pick-empty">还没有添加任何文件夹</p>
          </div>
          <div class="modal-actions">
            <button class="btn ghost" @click="pickFolder">＋ 添加文件夹</button>
            <button class="btn ghost" @click="showFolders = false">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ 元数据编辑 ============ -->
    <Teleport to="body">
      <div v-if="editing" class="modal-mask" @click.self="editing = null">
        <div class="modal">
          <h3>编辑歌曲信息</h3>
          <label>标题</label>
          <input v-model="editForm.title" class="input" />
          <label>歌手</label>
          <input v-model="editForm.artist" class="input" />
          <label>专辑</label>
          <input v-model="editForm.album" class="input" />
          <p class="hint">保存后会写回文件标签（MP3 / FLAC / M4A）</p>
          <div class="modal-actions">
            <button class="btn ghost" @click="editing = null">取消</button>
            <button class="btn" @click="saveEdit">保存</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ NCM 转换 ============ -->
    <Teleport to="body">
      <div v-if="showConvert" class="modal-mask" @click.self="showConvert = false">
        <div class="modal convert-modal">
          <h3>NCM 批量转换</h3>
          <p class="hint">将网易云 .ncm 加密文件转换为 MP3 / FLAC（自动提取歌曲信息与封面）</p>

          <div class="convert-dir">
            <div class="path-wrap">
              <span class="type-tag" :class="convertType">{{ convertType === 'file' ? '文件' : '目录' }}</span>
              <span class="path" :title="convertPath">{{ convertPath || '未选择 .ncm 文件或目录' }}</span>
            </div>
            <div class="pick-actions">
              <button class="btn small ghost" :disabled="converting" @click="pickConvertFile">选择文件</button>
              <button class="btn small ghost" :disabled="converting" @click="pickConvertDir">选择目录</button>
            </div>
          </div>

          <div class="convert-format">
            <span class="fmt-label">输出格式</span>
            <div class="fmt-options">
              <button
                v-for="f in convertFormats"
                :key="f.value"
                class="fmt-btn compact"
                :class="{ active: convertFormat === f.value }"
                :disabled="converting"
                :title="f.desc"
                @click="convertFormat = f.value"
              >
                {{ f.label }}
              </button>
            </div>
            <p class="fmt-hint">
              {{ convertFormat === 'auto' ? '保持 .ncm 原始格式（MP3/FLAC）' : `转为 ${convertFormat.toUpperCase()}（需要内置 ffmpeg，转码失败自动保留原格式）` }}
            </p>
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
              <span v-if="convertResult.converted" class="converted">（{{ convertResult.converted }} 首已转码为 {{ (convertResult.format || '').toUpperCase() }}）</span>
            </p>
            <p class="out-dir">输出目录：{{ convertResult.outputDir }}</p>
          </div>

          <div class="modal-actions">
            <button class="btn ghost" @click="showConvert = false">关闭</button>
            <button v-if="!convertResult" class="btn" :disabled="!convertPath || converting" @click="startConvert">
              {{ converting ? '转换中…' : '开始转换' }}
            </button>
            <button v-else class="btn" @click="openConvertOut">打开输出目录</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ============ 布局：左侧歌单栏 + 右侧主区 ============ */
.library {
  display: flex;
  gap: 22px;
  align-items: flex-start;
  height: 100%;
  min-height: 0;
}

/* ---- 侧栏 ---- */
.side {
  width: 208px;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: sticky;
  top: 0;
  max-height: calc(100vh - 190px);
}
.side-sep {
  height: 1px;
  background: var(--hairline);
  margin: 10px 6px;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 6px;
}
.sh-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.sh-add {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1;
  transition: background 0.15s, color 0.15s;
}
.sh-add:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.side-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}
.side-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-dim);
  text-align: left;
  transition: background 0.14s var(--ease), color 0.14s var(--ease);
}
.side-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.side-item.active {
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}
.si-icon {
  width: 17px;
  text-align: center;
  font-size: 12px;
  flex-shrink: 0;
  opacity: 0.85;
}
.si-icon.netease {
  color: #e60026;
  font-weight: 700;
}
.side-item.active .si-icon {
  opacity: 1;
}
.si-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.si-count {
  font-size: 11px;
  color: var(--text-faint);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.side-item.active .si-count {
  color: var(--accent);
  opacity: 0.75;
}
.side-empty {
  font-size: 12px;
  color: var(--text-faint);
  padding: 14px 10px;
  line-height: 1.7;
}
.se-sub {
  font-size: 11px;
  opacity: 0.75;
}
.side-foot {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.side-btn {
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-dim);
  text-align: left;
  transition: background 0.14s, color 0.14s;
}
.side-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* ---- 主区 ---- */
.main {
  flex: 1;
  min-width: 0;
  position: relative;
  padding-bottom: 72px; /* 给底部批量条留位，避免遮住最后一行 */
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.head-left {
  min-width: 0;
}
.page-title {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head-sub {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.src-badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-dim);
}
.src-badge.netease {
  background: rgba(230, 0, 38, 0.1);
  color: #e60026;
}
.src-badge.m3u {
  background: rgba(49, 194, 124, 0.13);
  color: var(--green);
}
.src-badge.warn {
  background: rgba(255, 152, 0, 0.14);
  color: #e08b00;
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* ---- 工具条 ---- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.search {
  width: 240px;
  flex: 0 0 auto;
}
.filters,
.view-toggle {
  display: flex;
  gap: 5px;
}
.toolbar-spacer {
  flex: 1;
}
.sort-select {
  padding: 5px 10px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  outline: none;
}
.sort-select:hover {
  color: var(--text);
  border-color: var(--text-dim);
}
.chip {
  padding: 5px 12px;
  border-radius: 16px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  transition: all 0.15s;
  white-space: nowrap;
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
.view-toggle .chip {
  padding: 5px 10px;
  font-size: 13px;
  line-height: 1;
}
.link-btn {
  font-size: 12px;
  color: var(--text-dim);
  padding: 5px 6px;
  border-radius: 6px;
  transition: color 0.14s, background 0.14s;
  white-space: nowrap;
}
.link-btn:hover {
  color: var(--accent);
  background: var(--accent-dim);
}

/* ---- 空态 ---- */
.empty-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 70px 20px;
  text-align: center;
}
.empty-icon {
  font-size: 42px;
  color: var(--text-faint);
  opacity: 0.4;
  margin-bottom: 16px;
  line-height: 1;
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 7px;
}
.empty-sub {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.7;
  margin-bottom: 18px;
  max-width: 380px;
}
.empty-actions {
  display: flex;
  gap: 10px;
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 70px 0;
  font-size: 13px;
}

/* ---- 封面墙 ---- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(146px, 1fr));
  gap: 16px;
}
.song-card {
  cursor: pointer;
  border-radius: var(--radius);
  padding: 8px;
  transition: background 0.18s var(--ease), transform 0.18s var(--ease), box-shadow 0.18s var(--ease);
  border: 1px solid transparent;
}
.song-card:hover {
  background: var(--bg-card);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
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
  display: block;
}
.no-cover {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  color: var(--text-faint);
  background: linear-gradient(135deg, #f2f2f4, #e8e8ec);
}
.play-fab {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 2px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
  opacity: 0;
  transform: translateY(5px) scale(0.9);
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease), background 0.15s;
}
.song-card:hover .play-fab {
  opacity: 1;
  transform: none;
}
.play-fab:hover {
  background: var(--accent-hover);
  transform: scale(1.08);
}
.src-tag {
  position: absolute;
  left: 7px;
  top: 7px;
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.55);
  color: #ddd;
  backdrop-filter: blur(3px);
}
.src-tag.download {
  color: #7ee2a8;
}
.src-tag.online {
  color: #8fd0ff;
}
.check {
  position: absolute;
  right: 7px;
  top: 7px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
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

/* ---- 列表 ---- */
.table {
  display: flex;
  flex-direction: column;
}
.thead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-faint);
  border-bottom: 1px solid var(--hairline);
  margin-bottom: 4px;
}
.th-check {
  width: 15px;
  flex-shrink: 0;
}
.th-title {
  flex: 1;
  min-width: 0;
}
.th-artist {
  width: 18%;
}
.th-album {
  width: 22%;
}
.th-dur {
  width: 52px;
  text-align: right;
}
.th-ops {
  width: 62px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  transition: background 0.14s;
  cursor: pointer;
}
.row:hover {
  background: var(--bg-hover);
}
.row.selected {
  background: var(--accent-dim);
}
.row input[type='checkbox'] {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.r-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot-online {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #3d9bff;
  flex-shrink: 0;
}
.r-artist,
.r-album {
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-artist {
  width: 18%;
}
.r-album {
  width: 22%;
}
.r-dur {
  width: 52px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.r-ops {
  width: 62px;
  display: flex;
  gap: 2px;
  justify-content: flex-end;
}
.op {
  color: var(--text-dim);
  padding: 5px 6px;
  font-size: 13px;
  border-radius: 6px;
  transition: color 0.14s, background 0.14s;
}
.op:hover {
  color: var(--accent);
  background: var(--accent-dim);
}

/* ---- 底部批量条 ---- */
.bulk-bar {
  position: fixed;
  left: 50%;
  bottom: 104px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 12px 9px 18px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 26px;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.2);
  z-index: 900;
}
.bulk-count {
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
}
.bulk-count b {
  color: var(--accent);
  font-size: 15px;
}
.bulk-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.bulk-btn {
  padding: 6px 12px;
  border-radius: 16px;
  font-size: 12.5px;
  color: var(--text-dim);
  white-space: nowrap;
  transition: background 0.14s, color 0.14s;
}
.bulk-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.bulk-btn.danger:hover {
  background: var(--accent-dim);
  color: var(--accent);
}
.bulk-close {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-faint);
  font-size: 12px;
  margin-left: 2px;
}
.bulk-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.bulk-enter-active,
.bulk-leave-active {
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}
.bulk-enter-from,
.bulk-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(12px);
}

/* ---- 弹窗通用 ---- */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2400;
}
.modal {
  width: 400px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px 24px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
}
.modal h3 {
  font-size: 17px;
  font-weight: 700;
  margin-bottom: 6px;
}
.modal label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}
.hint {
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.65;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.err {
  color: var(--accent);
  font-size: 12.5px;
  margin-top: 6px;
}

/* ---- 添加到歌单 ---- */
.pick-modal {
  width: 360px;
}
.pick-new {
  padding: 9px 12px;
  border-radius: 9px;
  border: 1px dashed var(--border);
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  transition: background 0.15s, border-color 0.15s;
}
.pick-new:hover {
  background: var(--accent-dim);
  border-color: var(--accent);
}
.pick-list {
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}
.pick-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 13px;
  text-align: left;
  transition: background 0.14s;
}
.pick-item:hover {
  background: var(--bg-hover);
}
.pi-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pi-count {
  font-size: 11px;
  color: var(--text-faint);
  flex-shrink: 0;
}
.pick-empty {
  font-size: 12px;
  color: var(--text-faint);
  padding: 16px 12px;
  text-align: center;
}

/* ---- 导入 ---- */
.imp-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.imp-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
}
.imp-sep {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 4px;
  color: var(--text-faint);
  font-size: 11px;
}
.imp-sep::before,
.imp-sep::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--hairline);
}
.imp-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* ---- 导出 ---- */
.fmt-options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.fmt-options.vertical {
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.fmt-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 13px;
  border-radius: 9px;
  background: var(--bg-hover);
  color: var(--text-dim);
  font-size: 12px;
  border: 1px solid var(--hairline);
  text-align: left;
  transition: background 0.15s var(--ease), border-color 0.15s var(--ease);
}
.fmt-btn b {
  font-size: 13px;
  color: var(--text);
}
.fmt-btn span {
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.fmt-btn:hover {
  background: var(--bg-active);
  border-color: var(--text-dim);
}
.fmt-btn.compact {
  padding: 5px 14px;
  border-radius: 7px;
  font-weight: 600;
  font-size: 12px;
  align-items: center;
}
.fmt-btn.compact.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: var(--accent);
}
.fmt-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- 文件夹列表 ---- */
.folder-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
}
.folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  transition: background 0.14s;
}
.folder-row:hover {
  background: var(--bg-hover);
}
.fr-path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

/* ---- NCM 转换 ---- */
.convert-modal {
  width: 460px;
}
.convert-dir {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 8px;
}
.convert-dir .path-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.convert-dir .type-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}
.convert-dir .type-tag.dir {
  background: rgba(49, 194, 124, 0.15);
  color: var(--green);
}
.convert-dir .path {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.convert-dir .pick-actions {
  display: flex;
  gap: 8px;
}
.convert-format {
  margin-top: 12px;
}
.convert-format .fmt-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
  display: block;
}
.convert-format .fmt-hint {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 6px;
}
.convert-progress {
  margin-top: 12px;
}
.convert-progress .bar {
  height: 8px;
  border-radius: 4px;
  background: var(--bg-active);
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
</style>
