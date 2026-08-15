<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import Hls from 'hls.js'
import { api } from '../api'
import { NcmProxyLoader } from '../utils/hlsLoader'

const route = useRoute()
const loading = ref(true)
const mv = ref(null)
const url = ref('')
const error = ref('')
const videoRef = ref(null)
let hls = null

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

async function loadData() {
  loading.value = true
  error.value = ''
  mv.value = null
  url.value = ''
  try {
    const [d, u] = await Promise.allSettled([
      api('mv_detail', { mvid: route.params.id }),
      api('mv_url', { id: route.params.id })
    ])
    if (d.status === 'fulfilled') mv.value = d.value.data
    if (u.status === 'fulfilled') {
      const urls = u.value.data || []
      url.value = urls.find((x) => x.url)?.url || ''
    }
    if (!url.value) error.value = '未获取到播放地址'
  } catch (e) {
    error.value = '加载失败：' + e.message
  } finally {
    loading.value = false
    await nextTick()
    await initPlayer()
  }
}

onMounted(loadData)

// /mv/1 → /mv/2 组件复用，需清理旧播放器并重新加载
watch(
  () => route.params.id,
  async (id, old) => {
    if (!id || id === old) return
    cleanup()
    await loadData()
  }
)

onBeforeUnmount(cleanup)
</script>

<template>
  <div class="mv-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <template v-else-if="mv">
      <h1 class="page-title">{{ mv.name }}</h1>
      <div class="sub">歌手：{{ mv.artistName }} · 播放 {{ mv.playCount }} 次</div>

      <div class="player-wrap">
        <video
          ref="videoRef"
          v-if="url"
          controls
          autoplay
          class="video"
        />
        <div v-if="!url" class="no-video">{{ error || '暂无播放地址' }}</div>
        <div v-else-if="error" class="no-video err-overlay">{{ error }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
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
</style>
