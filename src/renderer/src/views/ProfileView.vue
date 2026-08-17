<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api, imgUrl, qqmusic } from '../api'
import { usePlayerStore } from '../stores/player'
import { toast } from '../utils/toast'
import { PLATFORM_LOGOS } from '../utils/mergeSongs'
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

// ---- QQ 音乐扫码登录 ----
const qqLogged = ref(false)
const qqNick = ref('')
const qqQrImg = ref('')
const qqQrTip = ref('')
const qqQrKey = ref(null) // { qrsig, token }
const qqServerOk = ref(false)
let qqQrTimer = null

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
  // QQ 音乐登录态 + 服务状态
  try {
    qqServerOk.value = (await qqmusic.serverStatus()) === 'ready'
    const [nick, ck] = await Promise.all([qqmusic.getNick(), qqmusic.getCookie()])
    qqNick.value = nick || ''
    qqLogged.value = !!(ck && nick)
  } catch { /* QQ 服务未就绪 */ }
})

onUnmounted(() => {
  if (qrTimer) clearInterval(qrTimer)
  if (qqQrTimer) clearInterval(qqQrTimer)
})

async function loadUserData() {
  const uid = user.value.userId || user.value.accountId
  if (!uid) return
  const [pl, lk, rc] = await Promise.allSettled([
    api('user_playlist', { uid, limit: 100 }),
    api('likelist', { uid }),
    api('record_recent_song', { limit: 100 })
  ])
  if (pl.status === 'fulfilled') myPlaylists.value = pl.value.playlist || []
  if (lk.status === 'fulfilled' && lk.value.ids?.length) {
    const d = await api('song_detail', { ids: lk.value.ids.slice(0, 50).join(',') })
    likeSongs.value = d.songs || []
  }
  if (rc.status === 'fulfilled') {
    // 接口返回的是播放记录（每项仅含 data.songId），不是完整歌曲对象，
    // 需汇总 id 再查 song_detail，否则 SongTable 渲染出空白行
    const list = rc.value.data?.list || []
    const ids = list.map((x) => x?.data?.songId ?? x?.songId).filter(Boolean)
    if (ids.length) {
      try {
        const d = await api('song_detail', { ids: ids.slice(0, 100).join(',') })
        recentSongs.value = d.songs || []
      } catch {
        recentSongs.value = []
      }
    } else {
      recentSongs.value = list
    }
  }
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
  // 注意：login_qr_check 的 800（过期）/802（已扫码）通过 body.code 返回，
  // api() 封装对非 200 code 会抛异常，因此成功与异常两条路径都要取 code
  let code = null
  try {
    const r = await api('login_qr_check', { key: qrKey.value, timestamp: Date.now() })
    code = r.code
  } catch (e) {
    code = e.code
  }
  if (code === 800) {
    qrState.value = 'expired'
    qrTip.value = '二维码已过期，请点击刷新'
    clearInterval(qrTimer)
  } else if (code === 802) {
    qrState.value = 'scanned'
    qrTip.value = '已扫码，请在手机上确认'
  } else if (code === 803) {
    qrState.value = 'done'
    qrTip.value = '登录成功！'
    clearInterval(qrTimer)
    const st = await api('login_status')
    if (st.data?.profile && !st.data.account?.anonimousUser) {
      user.value = st.data.profile
      await loadUserData()
    }
  }
}

async function phoneLogin() {
  if (!phone.value || !password.value) return toast('请输入手机号和密码', 'error')
  try {
    await api('login_cellphone', { phone: phone.value, password: password.value })
    const s = await api('login_status')
    const acc = s.data?.account
    if (acc && !acc.anonimousUser && s.data.profile) {
      user.value = s.data.profile
      await loadUserData()
      showPhone.value = false
    } else {
      toast('登录失败：未获取到有效账号信息', 'error')
    }
  } catch (e) {
    toast('登录失败：' + e.message, 'error')
  }
}

async function logout() {
  await api('logout')
  user.value = null
  myPlaylists.value = []
  likeSongs.value = []
  recentSongs.value = []
}

// ---- QQ 音乐扫码登录 ----
async function qqStartQr() {
  qqQrImg.value = ''
  qqQrTip.value = '正在生成二维码…'
  qqQrKey.value = null
  if (qqQrTimer) clearInterval(qqQrTimer)
  qqQrTimer = null
  try {
    const qr = await qqmusic.loginQr()
    console.log('[qq-login] qr received, image len =', qr.image.length, 'qrsig =', (qr.qrsig || '').slice(0, 8))
    qqQrKey.value = { qrsig: qr.qrsig, token: qr.token, cookie: qr.cookie || '' }
    qqQrImg.value = qr.image
    qqQrTip.value = '请使用 QQ 手机版扫码登录'
    qqQrTimer = setInterval(qqCheckQr, 2000)
  } catch (e) {
    const msg = '二维码生成失败：' + (e?.message || e)
    console.log('[qq-login] qr failed:', e?.message || e)
    qqQrTip.value = msg + '，请检查网络后重试'
    toast(msg, 'error')
  }
}

async function qqCheckQr() {
  if (!qqQrKey.value) return
  try {
    const r = await qqmusic.loginCheck(qqQrKey.value.qrsig, qqQrKey.value.token, qqQrKey.value.cookie)
    console.log('[qq-login] poll code =', r.code, 'msg =', r.msg, 'nick =', r.nick, 'cookieLen =', (r.cookie || '').length)
    const msg = r.msg || ''
    if (r.code === 0) {
      qqLogged.value = true
      qqNick.value = r.nick || qqNick.value
      qqQrImg.value = ''
      qqQrTip.value = ''
      if (qqQrTimer) clearInterval(qqQrTimer)
      qqQrTimer = null
      toast('QQ 音乐登录成功')
      return
    }
    // 66/65 = 等待扫码；67 = 已扫码待手机确认（服务端消息「二维码认证中」，不是失效！）
    if (r.code === 67) {
      qqQrTip.value = '已扫码，请在手机上确认登录'
      return // 继续轮询，等手机确认后变 0
    }
    // 真正的失效：服务端明确提示已失效/已过期（注意「未失效」不能误判）
    if (/已失效|已过期|失效，请|过期，请|已扫码登录/.test(msg)) {
      qqQrTip.value = '二维码已失效，请点击刷新'
      if (qqQrTimer) clearInterval(qqQrTimer)
      qqQrTimer = null
      return
    }
    if (/确认/.test(msg)) {
      qqQrTip.value = '已扫码，请在手机上确认登录'
      return
    }
    qqQrTip.value = '等待扫码…'
  } catch (e) {
    // 轮询出错：停止轮询并提示（避免无限静默重试）
    console.log('[qq-login] poll error:', e?.message || e)
    if (qqQrTimer) clearInterval(qqQrTimer)
    qqQrTimer = null
    qqQrTip.value = '轮询出错：' + (e?.message || e) + '，请点击刷新重试'
    toast('QQ 登录轮询出错：' + (e?.message || e), 'error')
  }
}

async function qqLogout() {
  await qqmusic.loginClear()
  qqLogged.value = false
  qqNick.value = ''
  qqQrImg.value = ''
  qqQrKey.value = null
  if (qqQrTimer) clearInterval(qqQrTimer)
  qqQrTimer = null
  toast('已退出 QQ 音乐')
}
</script>

<template>
  <div class="profile">
    <h1 class="page-title">我的</h1>

    <!-- QQ 音乐扫码登录（多音源第二源） -->
    <section class="qq-sec">
      <div class="qq-head">
        <span class="qq-logo" v-html="PLATFORM_LOGOS.qq"></span>
        <div class="qq-info">
          <div class="qq-title">QQ 音乐</div>
          <div class="dim">解锁 VIP / 版权歌曲播放 · 多音源第二源</div>
        </div>
        <span class="qq-status" :class="{ ok: qqLogged, down: !qqServerOk }">
          {{ qqLogged ? ('已登录' + (qqNick ? '：' + qqNick : '')) : (!qqServerOk ? '服务未就绪' : '未登录') }}
        </span>
      </div>

      <div v-if="!qqLogged" class="qq-login">
        <button v-if="!qqQrImg" class="btn" @click="qqStartQr">扫码登录 QQ 音乐</button>
        <div v-else class="qq-qr">
          <img :src="qqQrImg" alt="QQ 登录二维码" class="qr-img" />
          <p class="qr-tip" :class="{ expired: qqQrTip.includes('失效') }">{{ qqQrTip }}</p>
          <button class="btn ghost small" @click="qqStartQr">刷新二维码</button>
        </div>
      </div>
      <div v-else class="qq-logged">
        <span class="qq-nick">✓ 已登录</span>
        <button class="btn ghost small" @click="qqLogout">退出登录</button>
      </div>
    </section>

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
.qq-sec {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  margin-bottom: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.qq-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.qq-logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(49, 194, 124, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.qq-logo :deep(svg) {
  width: 22px;
  height: 22px;
}
.qq-info {
  min-width: 0;
}
.qq-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 2px;
}
.qq-status {
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-elevated);
  border-radius: 999px;
  padding: 4px 12px;
  white-space: nowrap;
}
.qq-status.ok {
  color: #1f9d5c;
  background: rgba(49, 194, 124, 0.12);
}
.qq-status.down {
  color: #e0803a;
}
.qq-login,
.qq-logged {
  display: flex;
  align-items: center;
  gap: 12px;
}
.qq-qr {
  display: flex;
  align-items: center;
  gap: 12px;
}
.qq-qr .qr-img {
  width: 132px;
  height: 132px;
  border-radius: 10px;
  background: #fff;
  padding: 6px;
}
.qq-qr .qr-tip {
  font-size: 13px;
  color: var(--text-dim);
}
.qq-qr .qr-tip.expired {
  color: #e0803a;
}
.qq-nick {
  font-size: 13px;
  color: #1f9d5c;
  font-weight: 600;
}
</style>
