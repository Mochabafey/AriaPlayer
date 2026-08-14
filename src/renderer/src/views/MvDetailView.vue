<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
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
          error.value = '网络错误，播放失败'
          hls?.recoverMediaError()
        } else if (data.type === 'mediaError') {
          error.value = '媒体解码错误'
          hls?.destroy()
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

onMounted(async () => {
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
})

onBeforeUnmount(() => {
  if (hls) hls.destroy()
})
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
        <div v-else class="no-video">{{ error || '暂无播放地址' }}</div>
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
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  aspect-ratio: 16/9;
  max-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video {
  width: 100%;
  height: 100%;
}
.no-video {
  color: var(--text-faint);
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}
</style>
