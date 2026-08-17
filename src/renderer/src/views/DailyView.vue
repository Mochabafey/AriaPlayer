<script setup>
import { ref, onMounted } from 'vue'
import { api, waitServerReady } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'
import { toast } from '../utils/toast'

const player = usePlayerStore()

// 每日推荐日期：如 17/8（日/月）
const now = new Date()
const dailyDay = now.getDate()
const dailyMonth = now.getMonth() + 1

const songs = ref([])
const loading = ref(true)
const serverDown = ref(false)
const notLoggedIn = ref(false)

onMounted(async () => {
  if (!(await waitServerReady())) {
    serverDown.value = true
    loading.value = false
    return
  }
  try {
    const res = await api('recommend_songs')
    const list = res.data?.dailySongs || []
    if (!list.length) notLoggedIn.value = true
    songs.value = list
  } catch (e) {
    toast('获取每日推荐失败：' + (e.message || '未知错误'), 'error')
  } finally {
    loading.value = false
  }
})

function playAll() {
  if (!songs.value.length) return
  player.playList(songs.value)
}
</script>

<template>
  <div class="daily">
    <div class="page-head">
      <h1 class="page-title">
        <span class="d-day">{{ dailyDay }}</span><span class="d-month">/{{ dailyMonth }}</span>
        <span class="d-label">每日推荐</span>
      </h1>
      <button class="btn" :disabled="!songs.length" @click="playAll">
        ▶ 播放全部
      </button>
    </div>

    <p v-if="notLoggedIn" class="hint">
      每日推荐需要登录网易云账号后使用，去
      <RouterLink to="/profile" class="link">个人中心</RouterLink>
      扫码登录吧
    </p>
    <div v-else-if="loading" class="placeholder">加载中…</div>
    <div v-else-if="serverDown" class="placeholder">内置服务未就绪，请稍后重试</div>
    <SongTable v-else-if="songs.length" :songs="songs" />
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.d-day {
  font-size: 44px;
  font-weight: 800;
  line-height: 1;
}
.d-month {
  font-size: 22px;
  font-weight: 700;
}
.d-label {
  font-size: 28px;
  font-weight: 700;
  margin-left: 12px;
}
.hint {
  color: var(--text-faint);
  font-size: 13px;
  padding: 30px 0;
}
.link {
  color: var(--accent);
  text-decoration: underline;
}
.placeholder {
  color: var(--text-faint);
  padding: 40px 0;
  text-align: center;
}
</style>
