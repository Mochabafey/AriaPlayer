<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'

const route = useRoute()
const loading = ref(true)
const mv = ref(null)
const url = ref('')
const error = ref('')

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
      if (url.value && url.value.endsWith('.m3u8')) {
        // m3u8 需 hls 播放（此处直接用原生支持或提示）
        error.value = '该 MV 为 m3u8 流，当前版本暂不支持在线播放'
        url.value = ''
      }
    }
    if (!url.value && !error.value) error.value = '未获取到播放地址'
  } catch (e) {
    error.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="mv-detail">
    <div v-if="loading" class="placeholder">加载中…</div>
    <template v-else-if="mv">
      <h1 class="page-title">{{ mv.name }}</h1>
      <div class="sub">歌手：{{ mv.artistName }} · 播放 {{ mv.playCount }} 次</div>

      <div class="player-wrap">
        <video v-if="url" :src="`ncm-audio://stream?url=${encodeURIComponent(url)}`" controls autoplay class="video" />
        <div v-else class="no-video">{{ error || '暂无播放地址' }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 22px;
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
