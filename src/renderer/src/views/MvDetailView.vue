<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import Hls from 'hls.js'
import { api } from '../api'
import { useDownloadsStore } from '../stores/downloads'
import { useSettingsStore } from '../stores/settings'
import { toast } from '../utils/toast'
import { NcmProxyLoader } from '../utils/hlsLoader'

const route = useRoute()
const downloads = useDownloadsStore()
const settings = useSettingsStore()

const loading = ref(true)
const mv = ref(null)
const url = ref('')
const error = ref('')
const downloading = ref(false)
const videoRef = ref(null)
let hls = null

/**
 * 可用画质档位：来自 mv_detail 的 brs 字段（形如 [{ br: 240, size }, { br: 480, size }]）。
 * 上游并不保证一定有 1080 —— 很多老 MV 只有 240/480。
 * 原实现固定请求 r=1080，上游对超范围的档位**静默降级**到最高可用（返回体里的 r
 * 会变成真实档位），用户既看不到自己实际拿到多少，也无从选择。
 */
const qualities = ref([])
/** 当前选中档位（数字，如 480） */
const currentQuality = ref(0)
/** 当前实际拿到的档位（上游可能降级，与请求值不同） */
const actualQuality = ref(0)
/** 画质菜单展开态 */
const qualityOpen = ref(false)
/** 切换画质中（避免重复点击） */
const switching = ref(false)

/** 画质标签：480 → 480P；1080 → 1080P 高清 */
function qLabel(br) {
  if (!br) return '未知'
  if (br >= 1080) return `${br}P 高清`
  if (br >= 720) return `${br}P`
  return `${br}P`
}

const currentLabel = computed(() => qLabel(actualQuality.value || currentQuality.value))

/** 是否值得显示画质选择器（只有一个档位时没有切换的意义） */
const showQualityPicker = computed(() => qualities.value.length > 1)

async function initPlayer() {
  const video = videoRef.value
  if (!video || !url.value) return

  if (url.value.endsWith('.m3u8')) {
    if (Hls.isSupported()) {
      hls = new Hls({ loader: NcmProxyLoader })
      hls.loadSource(url.value)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === 'networkError') {
          // 网络错误：重新拉流（recoverMediaError 是媒体错误的恢复手段，用错会导致黑屏）
          hls?.startLoad()
        } else if (data.type === 'mediaError') {
          error.value = '媒体解码错误'
          hls?.destroy()
          hls = null
        } else {
          error.value = '播放失败：' + (data.details || data.type)
          hls?.destroy()
          hls = null
        }
      })
      video.play().catch(() => {})
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = `ncm-audio://stream?url=${encodeURIComponent(url.value)}`
      video.play().catch(() => {})
    } else {
      error.value = '当前环境不支持 m3u8 播放'
    }
  } else {
    video.src = `ncm-audio://stream?url=${encodeURIComponent(url.value)}`
  }
}

/** 停止并清理当前播放（HLS 实例 + video 元素） */
function cleanup() {
  if (hls) {
    hls.destroy()
    hls = null
  }
  const video = videoRef.value
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}

/**
 * 取指定画质的播放地址。
 * 返回 { url, actual }：actual 是上游实际给出的档位（可能低于请求值）。
 */
async function fetchUrl(mvid, br) {
  const params = { id: mvid }
  if (br) params.r = br
  const res = await api('mv_url', params)
  // mv_url 的 data 是**对象**（{ id, url, r, size, code }），
  // 与 song_url_v1 的数组结构不同。原实现照搬 song/url 的 `data.find(...)`，
  // 直接抛 "urls.find is not a function" 导致 MV 永远放不了。
  // 这里兼容对象与数组两种返回，避免上游格式变化再次打挂。
  const d0 = res.data
  const item = Array.isArray(d0) ? d0.find((x) => x?.url) : d0
  return { url: item?.url || '', actual: item?.r || 0, code: item?.code, size: item?.size || 0 }
}

/**
 * 按可用档位从高到低尝试，返回第一个真正有地址的档位。
 * 必要性：brs 列出的档位未必都能取到（版权/转码缺失），
 * 只试最高档会因个别档位缺失而误报"无版权"。
 */
async function resolveBestUrl(mvid, preferred) {
  const list = qualities.value.map((q) => q.br)
  // 优先用户偏好，其次由高到低
  const order = preferred && list.includes(preferred)
    ? [preferred, ...list.filter((b) => b !== preferred)]
    : [...list].sort((a, b) => b - a)

  let last = { url: '', actual: 0, code: 0 }
  for (const br of order) {
    const r = await fetchUrl(mvid, br)
    if (r.url) return { ...r, requested: br }
    last = r
  }
  return { ...last, requested: order[0] || 0 }
}

async function loadData() {
  loading.value = true
  error.value = ''
  mv.value = null
  url.value = ''
  qualities.value = []
  actualQuality.value = 0
  const mvid = route.params.id
  try {
    // 详情与可用档位一起拿：mv_detail 的 brs 才是权威档位表
    const d = await api('mv_detail', { mvid }).catch(() => null)
    if (d?.data) {
      mv.value = d.data
      const brs = Array.isArray(d.data.brs) ? d.data.brs : []
      qualities.value = brs
        .filter((b) => b && b.br)
        .map((b) => ({ br: b.br, size: b.size || 0 }))
        .sort((a, b) => b.br - a.br) // 高清在前
    }

    // 默认档位：用户偏好（若该 MV 支持）→ 否则最高可用
    const preferred = Number(settings.settings.mvQuality) || 0
    if (!qualities.value.length) {
      // 详情没给 brs（少见）：退回旧行为，直接要地址
      const r = await fetchUrl(mvid, preferred || undefined)
      url.value = r.url
      actualQuality.value = r.actual
      currentQuality.value = r.actual || preferred
      if (!url.value) {
        error.value = r.code === 404 ? '该 MV 无版权或已下架' : '未获取到播放地址'
      }
    } else {
      const best = await resolveBestUrl(mvid, preferred)
      url.value = best.url
      actualQuality.value = best.actual
      currentQuality.value = best.actual || best.requested
      if (!url.value) {
        error.value = best.code === 404 ? '该 MV 无版权或已下架' : '未获取到播放地址'
      }
    }
  } catch (e) {
    error.value = '加载失败：' + (e?.message || '未知错误')
  } finally {
    loading.value = false
    await nextTick()
    await initPlayer()
  }
}

/**
 * 切换画质：保持播放位置与播放状态，换源后跳回原位置。
 *
 * 换源会触发 video 重新加载（currentTime 归零），必须在**设置新 src 之前**
 * 注册 loadedmetadata 监听并缓存目标位置，否则：
 *   - 监听注册晚了会错过事件 → 位置停在 0
 *   - 不清理旧 HLS 实例会与新实例并存 → 双份分片请求 + 内存泄漏
 */
async function switchQuality(br) {
  if (switching.value || br === currentQuality.value) {
    qualityOpen.value = false
    return
  }
  const video = videoRef.value
  const at = video?.currentTime || 0
  const wasPlaying = video ? !video.paused : false
  switching.value = true
  qualityOpen.value = false
  try {
    const r = await fetchUrl(route.params.id, br)
    if (!r.url) {
      toast(`该画质暂不可用（${qLabel(br)}）`, 'error')
      return
    }

    // 先清理旧播放器（HLS 实例 + 旧 src），再注册位置恢复监听
    cleanup()

    url.value = r.url
    currentQuality.value = br
    actualQuality.value = r.actual || br
    settings.set('mvQuality', actualQuality.value)

    await nextTick()
    const v = videoRef.value
    if (v) {
      // 监听必须在 initPlayer 设置 src 之前挂上：src 设好后的加载很快，
      // 晚一步注册就错过 loadedmetadata，位置恢复失效
      const restore = () => {
        v.removeEventListener('loadedmetadata', restore)
        if (at > 0 && at < (v.duration || Infinity)) v.currentTime = at
        if (wasPlaying) v.play().catch(() => {})
      }
      v.addEventListener('loadedmetadata', restore)
    }
    await initPlayer()

    // 上游降级时明确告知，避免用户以为切换没生效
    if (r.actual && r.actual !== br) {
      toast(`该 MV 最高仅 ${qLabel(r.actual)}，已切到可用画质`, 'info')
    }
  } catch (e) {
    toast('切换画质失败：' + (e?.message || '未知错误'), 'error')
  } finally {
    switching.value = false
  }
}

/** 点击外部关闭画质菜单 */
function onDocClick(e) {
  if (!qualityOpen.value) return
  if (e.target?.closest?.('.quality-picker')) return
  qualityOpen.value = false
}

onMounted(() => {
  loadData()
  document.addEventListener('click', onDocClick)
})

/**
 * 下载 MV。
 * 复用主进程的下载管理器（它本身是通用 HTTP Range 下载器，支持断点续传），
 * 只需显式传 ext=mp4 —— 音质档位推导出来的会是 mp3/flac，对视频是错的。
 * 文件名带画质后缀：不同档位若同名会互相覆盖，也让用户看得出下的是哪一档。
 */
async function downloadMv() {
  if (!url.value || downloading.value) return
  downloading.value = true
  try {
    const q = actualQuality.value || currentQuality.value
    const suffix = q ? ` (${q}P)` : ''
    const r = await downloads.add({
      songId: `mv:${route.params.id}${q ? ':' + q : ''}`,
      title: `${mv.value?.name || `MV ${route.params.id}`}${suffix}`,
      artist: mv.value?.artistName || '未知歌手',
      url: url.value,
      ext: 'mp4',
      cover: mv.value?.cover || ''
    })
    // store 内部已统一 toast（成功/重复/失败），这里无需重复提示
    return r
  } catch (e) {
    toast('下载失败：' + (e?.message || '未知错误'), 'error')
  } finally {
    downloading.value = false
  }
}

// /mv/1 → /mv/2 组件复用，需清理旧播放器并重新加载
watch(
  () => route.params.id,
  async (id, old) => {
    if (!id || id === old) return
    cleanup()
    await loadData()
  }
)

onBeforeUnmount(() => {
  cleanup()
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="mv-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <template v-else-if="mv">
      <div class="mv-head">
        <div>
          <h1 class="page-title">{{ mv.name }}</h1>
          <div class="sub">歌手：{{ mv.artistName }} · 播放 {{ mv.playCount }} 次</div>
        </div>
        <button
          v-if="url"
          class="btn small"
          :disabled="downloading"
          :title="downloading ? '正在加入下载队列…' : `下载此 MV（${currentLabel}，支持断点续传）`"
          @click="downloadMv"
        >
          {{ downloading ? '加入中…' : `⇩ 下载 ${currentLabel}` }}
        </button>
      </div>

      <div class="player-wrap">
        <video
          ref="videoRef"
          v-if="url"
          controls
          autoplay
          class="video"
        />

        <!-- 画质选择器：叠在播放器右下角，与流媒体平台习惯一致 -->
        <div v-if="url && showQualityPicker" class="quality-picker" :class="{ open: qualityOpen }">
          <button class="q-btn" :disabled="switching" @click.stop="qualityOpen = !qualityOpen">
            {{ switching ? '切换中…' : currentLabel }}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div v-if="qualityOpen" class="q-menu">
            <button
              v-for="q in qualities"
              :key="q.br"
              class="q-item"
              :class="{ on: q.br === currentQuality }"
              @click.stop="switchQuality(q.br)"
            >
              <span class="q-name">{{ qLabel(q.br) }}</span>
              <span v-if="q.size" class="q-size">{{ (q.size / 1048576).toFixed(0) }}MB</span>
              <span v-if="q.br === currentQuality" class="q-check">✓</span>
            </button>
          </div>
        </div>

        <div v-if="!url" class="no-video">{{ error || '暂无播放地址' }}</div>
        <div v-else-if="error" class="no-video err-overlay">{{ error }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 标题行：左标题右下载按钮 */
.mv-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.page-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin-bottom: 6px;
}
.sub {
  color: var(--text-dim);
  font-size: 13px;
  margin-bottom: 18px;
}
.player-wrap {
  position: relative;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  aspect-ratio: 16/9;
  max-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.player-wrap .err-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
}
.video {
  width: 100%;
  height: 100%;
}
.no-video {
  color: var(--text-faint);
}
.player-wrap .no-video {
  padding: 16px;
  text-align: center;
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}

/* ---- 画质选择器 ---- */
.quality-picker {
  position: absolute;
  right: 14px;
  /* 避开原生 controls 栏（约 40px 高），否则会被压住点不到 */
  bottom: 52px;
  z-index: 5;
}
.q-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(8px);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  transition: background 0.15s var(--ease), transform 0.15s var(--ease);
}
.q-btn:hover { background: rgba(0, 0, 0, 0.82); transform: scale(1.03); }
.q-btn:disabled { opacity: 0.7; cursor: default; transform: none; }
.q-btn svg { width: 13px; height: 13px; transition: transform 0.18s var(--ease); }
.quality-picker.open .q-btn svg { transform: rotate(180deg); }

.q-menu {
  position: absolute;
  right: 0;
  bottom: 34px;
  min-width: 132px;
  background: rgba(24, 24, 26, 0.94);
  backdrop-filter: blur(14px);
  border-radius: 10px;
  padding: 5px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.q-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.82);
  font-size: 12px;
  text-align: left;
  transition: background 0.13s var(--ease), color 0.13s var(--ease);
}
.q-item:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
.q-item.on { color: var(--accent); font-weight: 700; }
.q-name { flex: 1; }
.q-size { font-size: 11px; opacity: 0.6; font-variant-numeric: tabular-nums; }
.q-check { font-size: 11px; }
</style>
