<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api, imgUrl } from '../api'
import { usePlayerStore } from '../stores/player'
import SongTable from '../components/SongTable.vue'

const router = useRouter()
const player = usePlayerStore()

const user = ref(null)
const loading = ref(true)
const qrKey = ref('')
const qrImg = ref('')
const qrState = ref('') // '' | waiting | scanned | expired
const qrTip = ref('')
const phone = ref('')
const password = ref('')
const showPhone = ref(false)
const myPlaylists = ref([])
const likeSongs = ref([])
const recentSongs = ref([])
let qrTimer = null

onMounted(async () => {
  try {
    const s = await api('login_status')
    // api-enhanced 启动时会自动注册匿名账号（anonimousUser: true, profile: null），
    // 必须排除匿名态，否则一进页面就误显示为已登录、登录入口不出现。
    const acc = s.data?.account
    if (acc && !acc.anonimousUser && s.data.profile) {
      user.value = s.data.profile
      await loadUserData()
    }
  } catch { /* 未登录 */ }
  loading.value = false
})

onUnmounted(() => qrTimer && clearInterval(qrTimer))

async function loadUserData() {
  const uid = user.value.userId || user.value.accountId
  if (!uid) return
  const [pl, lk, rc] = await Promise.allSettled([
    api('user_playlist', { uid, limit: 100 }),
    api('likelist', { uid }),
    api('record_recent_song', { uid, limit: 1 })
  ])
  if (pl.status === 'fulfilled') myPlaylists.value = pl.value.playlist || []
  if (lk.status === 'fulfilled' && lk.value.ids?.length) {
    const d = await api('song_detail', { ids: lk.value.ids.slice(0, 50).join(',') })
    likeSongs.value = d.songs || []
  }
  if (rc.status === 'fulfilled') recentSongs.value = rc.value.data?.list || []
}

async function startQr() {
  qrState.value = 'waiting'
  qrTip.value = '正在生成二维码…'
  qrImg.value = '' // 先清空旧二维码，生成失败时不显示过期旧图
  clearInterval(qrTimer)
  qrTimer = null
  try {
    const key = await api('login_qr_key', { timestamp: Date.now() })
    qrKey.value = key.data.unikey
    const qr = await api('login_qr_create', { key: qrKey.value, qrimg: true, timestamp: Date.now() })
    qrImg.value = qr.data.qrimg
    qrTip.value = '请使用网易云音乐 App 扫码登录'
    qrTimer = setInterval(checkQr, 2000)
  } catch (e) {
    qrState.value = 'expired'
    qrTip.value = '二维码生成失败：' + e.message + '，请检查网络后重试'
    qrImg.value = ''
  }
}

async function checkQr() {
  if (!qrKey.value) return
  try {
    const r = await api('login_qr_check', { key: qrKey.value, timestamp: Date.now() })
    if (r.code === 800) {
      qrState.value = 'expired'
      qrTip.value = '二维码已过期，请点击刷新'
      clearInterval(qrTimer)
    } else if (r.code === 802) {
      qrState.value = 'scanned'
      qrTip.value = '已扫码，请在手机上确认'
    } else if (r.code === 803) {
      qrState.value = 'done'
      qrTip.value = '登录成功！'
      clearInterval(qrTimer)
      // 需要调用一次 check 返回的 cookie 更新
      const st = await api('login_status')
      if (st.data?.profile) {
        user.value = st.data.profile
        await loadUserData()
      } else {
        // 部分版本需用 cookie 再确认
        const s2 = await api('login_status')
        if (s2.data?.profile) user.value = s2.data.profile
        await loadUserData()
      }
    }
  } catch { /* ignore */ }
}

async function phoneLogin() {
  if (!phone.value || !password.value) return alert('请输入手机号和密码')
  try {
    await api('login_cellphone', { phone: phone.value, password: password.value })
    const s = await api('login_status')
    const acc = s.data?.account
    if (acc && !acc.anonimousUser && s.data.profile) {
      user.value = s.data.profile
      await loadUserData()
      showPhone.value = false
    } else {
      alert('登录失败：未获取到有效账号信息')
    }
  } catch (e) {
    alert('登录失败：' + e.message)
  }
}

async function logout() {
  await api('logout')
  user.value = null
  myPlaylists.value = []
  likeSongs.value = []
  recentSongs.value = []
}
</script>

<template>
  <div class="profile">
    <h1 class="page-title">我的</h1>

    <!-- 未登录 -->
    <div v-if="!user && !loading" class="login-box">
      <div class="avatar-placeholder">♪</div>
      <h2>登录网易云账号</h2>
      <p class="dim">登录后可解锁：每日推荐、私人 FM、我的歌单、收藏同步、解锁灰歌</p>

      <template v-if="!showPhone">
        <button v-if="!qrImg" class="btn" @click="startQr">生成登录二维码</button>
        <div v-else class="qr-wrap">
          <img :src="imgUrl(qrImg)" alt="登录二维码" class="qr-img" />
          <p class="qr-tip" :class="{ scanned: qrState === 'scanned', expired: qrState === 'expired' }">{{ qrTip }}</p>
          <button class="btn ghost small" @click="startQr">刷新二维码</button>
        </div>
        <button class="btn ghost" @click="showPhone = true">手机号登录</button>
      </template>

      <template v-else>
        <input v-model="phone" class="input" placeholder="手机号" />
        <input v-model="password" type="password" class="input" placeholder="密码" @keyup.enter="phoneLogin" />
        <button class="btn" @click="phoneLogin">登录</button>
        <button class="btn ghost" @click="showPhone = false">返回扫码</button>
      </template>
    </div>

    <!-- 已登录 -->
    <template v-else-if="user">
      <div class="user-head">
        <img :src="imgUrl(user.avatarUrl + '?param=120y120')" class="avatar" alt="" />
        <div>
          <div class="nick">{{ user.nickname }}</div>
          <div class="dim">{{ user.signature || '这个人很懒，什么都没写' }}</div>
          <button class="btn ghost small logout" @click="logout">退出登录</button>
        </div>
      </div>

      <section class="sec" v-if="myPlaylists.length">
        <div class="sec-head">
          <h2>我的歌单</h2>
        </div>
        <div class="grid">
          <div v-for="p in myPlaylists" :key="p.id" class="playlist-card" @click="router.push('/playlist/' + p.id)">
            <div class="cover-wrap">
              <img :src="imgUrl(p.coverImgUrl + '?param=300y300')" alt="" loading="lazy" />
            </div>
            <div class="name">{{ p.name }}</div>
          </div>
        </div>
      </section>

      <section class="sec" v-if="likeSongs.length">
        <div class="sec-head">
          <h2>我的收藏</h2>
          <button class="btn small ghost" @click="player.playList(likeSongs)">▶ 播放全部</button>
        </div>
        <SongTable :songs="likeSongs" />
      </section>

      <section class="sec" v-if="recentSongs.length">
        <div class="sec-head">
          <h2>最近播放</h2>
        </div>
        <SongTable :songs="recentSongs" />
      </section>
    </template>

    <div v-if="loading" class="placeholder">加载中…</div>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin-bottom: 18px;
}
.login-box {
  max-width: 380px;
  margin: 40px auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
}
.avatar-placeholder {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--accent-dim);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
}
.login-box h2 {
  font-size: 18px;
}
.dim {
  color: var(--text-dim);
  font-size: 13px;
}
.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.qr-img {
  width: 180px;
  height: 180px;
  border-radius: 10px;
  background: #fff;
  padding: 8px;
}
.qr-tip {
  font-size: 13px;
  color: var(--text-dim);
}
.qr-tip.scanned {
  color: #f0a020;
}
.qr-tip.expired {
  color: var(--accent);
}
.user-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 28px;
}
.avatar {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  border: 2px solid var(--accent-dim);
  box-shadow: var(--shadow-sm);
}
.nick {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
  font-weight: 700;
  margin-bottom: 4px;
}
.logout {
  margin-top: 10px;
}
.sec {
  margin-bottom: 28px;
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.sec-head h2 {
  font-size: 17px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}
.playlist-card {
  cursor: pointer;
}
.cover-wrap {
  border-radius: var(--radius);
  overflow: hidden;
  aspect-ratio: 1;
  box-shadow: var(--shadow-sm);
  transition: transform 0.25s var(--ease), box-shadow 0.25s var(--ease);
}
.cover-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s var(--ease);
}
.playlist-card:hover .cover-wrap {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}
.playlist-card:hover .cover-wrap img {
  transform: scale(1.06);
}
.name {
  margin-top: 8px;
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
}
</style>
