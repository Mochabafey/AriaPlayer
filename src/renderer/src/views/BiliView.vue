<script setup>
/**
 * BiliView.vue — B 站 MV 源页面
 *
 * 功能：
 *   - 搜索 B 站视频（按歌名/关键词）
 *   - 点击播放（自动选最优路径：durl 直出 / DASH 合流）
 *   - 画质切换（未登录最高 480P，登录后解锁 1080P/4K）
 *   - 扫码登录
 *
 * 播放路径说明（见主进程 biliClient.js）：
 *   proxy → durl 单文件，直接播
 *   ready → 已缓存的合流文件
 *   merge → 需要 ffmpeg 合流，轮询进度
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { bili } from '../api'
import { toast } from '../utils/toast'
import BiliPlayer from '../components/BiliPlayer.vue'
import { imgUrl } from '../api'

const route = useRoute()
const router = useRouter()

const keyword = ref('')
const searching = ref(false)
const results = ref([])
const searched = ref(false)

/** 当前播放的视频信息 */
const current = ref(null)
/** 可播地址 */
const playUrl = ref('')
/** 合流中 */
const merging = ref(false)
const mergePercent = ref(0)
const mergeText = ref('')
let mergeTimer = null

/** 画质 */
const qualities = ref([])
const currentQuality = ref(0)
/** 当前流的编码（排障与提示用） */
const currentCodecs = ref('')

/** 登录 */
const login = ref({ loggedIn: false })
const qr = ref(null)
const qrStatus = ref('')
let qrTimer = null

/** 播放页展开 */
const playerOpen = ref(false)

onMounted(async () => {
  await refreshLogin()
  // 支持从 MV 页带歌名跳过来
  const q = String(route.query.q || '').trim()
  if (q) {
    keyword.value = q
    await doSearch()
  }
})

onBeforeUnmount(() => {
  clearInterval(mergeTimer)
  clearInterval(qrTimer)
})

async function refreshLogin() {
  try {
    login.value = await bili.loginStatus()
  } catch {
    login.value = { loggedIn: false }
  }
}

async function doSearch() {
  const kw = keyword.value.trim()
  if (!kw || searching.value) return
  searching.value = true
  try {
    const r = await bili.search(kw, 1, 24)
    results.value = r.list || []
    searched.value = true
    if (!results.value.length) toast('没有搜到相关视频', 'info')
  } catch (e) {
    toast('搜索失败：' + (e?.message || '未知错误'), 'error')
  } finally {
    searching.value = false
  }
}

/** 画质名 → { id, name } 列表（来自上游 accept_quality/accept_description） */
function buildQualities(ids, descs) {
  return (ids || []).map((id, i) => ({ id, name: (descs || [])[i] || `${id}` }))
}

/**
 * 播放指定视频。
 * 流程：video-info 拿 cid → resolve 取流 → 按 mode 处理
 */
async function play(v) {
  current.value = v
  playerOpen.value = true
  playUrl.value = ''
  merging.value = false
  mergePercent.value = 0
  qualities.value = []
  clearInterval(mergeTimer)

  try {
    const info = await bili.videoInfo(v.bvid)
    current.value = { ...v, cid: info.cid, pages: info.pages, stat: info.stat, desc: info.desc }
    await resolveAndPlay(info.cid)
  } catch (e) {
    toast('加载视频失败：' + (e?.message || '未知错误'), 'error')
    playerOpen.value = false
  }
}

/** 取流并播放（quality 为空则用默认档位） */
async function resolveAndPlay(cid, quality) {
  const bvid = current.value?.bvid
  if (!bvid || !cid) return
  try {
    const r = await bili.resolve(bvid, cid, quality, !quality)

    qualities.value = buildQualities(r.acceptQuality, r.acceptDesc)
    currentQuality.value = r.quality || 0
    currentCodecs.value = r.codecs || ''

    // HEVC 提示：Chromium 默认不支持 HEVC 解码，只有 HEVC 编码时画面会黑屏
    //（时长正常、音频能播，但 videoWidth=0）
    if (r.hevcOnly) {
      toast('该画质仅提供 HEVC 编码，当前环境可能无法解码（可尝试其他清晰度）', 'warning')
    }

    if (r.mode === 'proxy') {
      // durl 单文件：直接播。
      // 必须显式带 ref=https://www.bilibili.com/ —— B 站 CDN 校验防盗链，
      // 用 ncm-audio 协议默认的网易云 Referer 会被拒（实测 upstream 403）。
      // 虽然主进程也会按域名推断，但 B 站边缘节点域名五花八门
      //（xxx.edge.mountaintoys.cn 之类），显式指定更可靠。
      playUrl.value = `ncm-audio://stream?url=${encodeURIComponent(r.url)}&ref=${encodeURIComponent('https://www.bilibili.com/')}`
      return
    }
    if (r.mode === 'ready') {
      playUrl.value = `ncm-audio://local?path=${encodeURIComponent(r.file)}`
      return
    }
    // mode === 'merge'：轮询合流进度
    merging.value = true
    mergeText.value = `正在合流 ${r.qualityName || ''}`
    await pollMerge(r.key)
  } catch (e) {
    toast('取流失败：' + (e?.message || '未知错误'), 'error')
    merging.value = false
  }
}

/** 轮询合流进度直到完成 */
function pollMerge(key) {
  return new Promise((resolve) => {
    let ticks = 0
    clearInterval(mergeTimer)
    mergeTimer = setInterval(async () => {
      ticks++
      try {
        const s = await bili.mergeStatus(key)
        if (s.error) {
          clearInterval(mergeTimer)
          merging.value = false
          toast('合流失败：' + s.error, 'error')
          return resolve()
        }
        if (s.done && s.file) {
          clearInterval(mergeTimer)
          merging.value = false
          playUrl.value = `ncm-audio://local?path=${encodeURIComponent(s.file)}`
          return resolve()
        }
        // 进度估算：合流无总时长（远程流），按已用时间做渐进反馈
        mergePercent.value = Math.min(95, ticks * 6)
        if (s.time) mergeText.value = `正在合流 ${s.time}${s.speed ? ' · ' + s.speed : ''}`
      } catch { /* 继续轮询 */ }
      // 超时保护：5 分钟
      if (ticks > 300) {
        clearInterval(mergeTimer)
        merging.value = false
        toast('合流超时，请重试', 'error')
        resolve()
      }
    }, 1000)
  })
}

/** 切画质 */
async function onQualityChange(qid) {
  if (!current.value?.cid) return
  const v = playUrl.value
  const wasPlaying = !!v
  playUrl.value = ''
  await resolveAndPlay(current.value.cid, qid)
  if (wasPlaying && playUrl.value) {
    // 位置保持由 BiliPlayer 内部处理（url 变化时重新加载），
    // 这里只提示用户
    toast('已切换清晰度', 'success')
  }
}

/* ---------------- 扫码登录 ---------------- */

async function startLogin() {
  try {
    const r = await bili.loginQr()
    qr.value = r
    qrStatus.value = 'waiting'
    clearInterval(qrTimer)
    qrTimer = setInterval(async () => {
      try {
        const s = await bili.loginPoll(r.qrcodeKey)
        qrStatus.value = s.status
        if (s.status === 'success') {
          clearInterval(qrTimer)
          qr.value = null
          await refreshLogin()
          toast(`登录成功${s.uname ? '：' + s.uname : ''}`, 'success')
          // 重新取流以应用高清
          if (current.value?.cid) await resolveAndPlay(current.value.cid, currentQuality.value)
        } else if (s.status === 'expired') {
          clearInterval(qrTimer)
          toast('二维码已失效，请重新获取', 'error')
        }
      } catch { /* 继续轮询 */ }
    }, 2000)
  } catch (e) {
    toast('获取二维码失败：' + (e?.message || '未知错误'), 'error')
  }
}

function cancelLogin() {
  clearInterval(qrTimer)
  qr.value = null
  qrStatus.value = ''
}

async function doLogout() {
  await bili.logout()
  await refreshLogin()
  toast('已退出 B 站账号', 'info')
}

/** 关掉播放器 */
function closePlayer() {
  playerOpen.value = false
  playUrl.value = ''
  current.value = null
  clearInterval(mergeTimer)
  merging.value = false
}

function fmtDur(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function fmtCount(n) {
  if (!n) return '0'
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

const qrStatusText = computed(() => ({
  waiting: '请用 B 站客户端扫码',
  scanned: '已扫码，请在手机上确认',
  expired: '二维码已失效',
  success: '登录成功'
}[qrStatus.value] || '请扫码'))
</script>

<template>
  <div class="bili">
    <!-- 播放器（展开时覆盖列表） -->
    <div v-if="playerOpen && current" class="player-area">
      <div class="pa-head">
        <button class="back-btn" @click="closePlayer">← 返回列表</button>
        <div class="pa-title" :title="current.title">{{ current.title }}</div>
      </div>
      <BiliPlayer
        :url="playUrl"
        :title="current.title"
        :author="current.author"
        :poster="current.pic"
        :qualities="qualities"
        :quality="currentQuality"
        :merging="merging"
        :merge-percent="mergePercent"
        :merge-text="mergeText"
        @quality-change="onQualityChange"
      />
      <div class="pa-meta">
        <span>{{ current.author }}</span>
        <span v-if="current.duration">时长 {{ fmtDur(current.duration) }}</span>
        <span v-if="current.stat">播放 {{ fmtCount(current.stat.view) }} · 弹幕 {{ fmtCount(current.stat.danmaku) }}</span>
        <span v-if="currentCodecs" class="codec" :title="'当前流编码：' + currentCodecs">
          {{ currentCodecs.split('.')[0].toUpperCase() }}
        </span>
        <span v-if="!login.loggedIn" class="tip">未登录最高 480P，扫码登录可解锁 1080P/4K</span>
      </div>
    </div>

    <template v-else>
      <!-- 头部 -->
      <div class="head">
        <h1 class="page-title">B 站 MV</h1>
        <div class="login-area">
          <template v-if="login.loggedIn">
            <img v-if="login.face" class="avatar" :src="imgUrl(login.face)" alt="" />
            <span class="uname">{{ login.uname }}</span>
            <span v-if="login.vip" class="vip">大会员</span>
            <button class="btn small ghost" @click="doLogout">退出</button>
          </template>
          <button v-else class="btn small" @click="startLogin">扫码登录 B 站</button>
        </div>
      </div>

      <!-- 搜索 -->
      <div class="search-row">
        <input
          v-model="keyword"
          class="input"
          placeholder="搜索 B 站视频（歌名、歌手、MV…）"
          @keyup.enter="doSearch"
        />
        <button class="btn" :disabled="searching" @click="doSearch">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
      </div>

      <p v-if="!searched" class="hint">
        输入关键词搜索 B 站视频。未登录最高 480P；扫码登录后可解锁 1080P / 4K（取决于账号会员状态）。
      </p>

      <!-- 结果网格 -->
      <div v-if="results.length" class="grid">
        <div v-for="v in results" :key="v.bvid" class="card" @click="play(v)">
          <div class="cover">
            <img :src="imgUrl(v.pic)" alt="" loading="lazy" />
            <span class="dur">{{ fmtDur(v.duration) }}</span>
            <span class="play-count">▶ {{ fmtCount(v.play) }}</span>
          </div>
          <div class="c-title" :title="v.title">{{ v.title }}</div>
          <div class="c-author">{{ v.author }}</div>
        </div>
      </div>

      <div v-else-if="searched && !searching" class="placeholder">没有搜到相关视频</div>
    </template>

    <!-- 扫码登录弹窗 -->
    <div v-if="qr" class="qr-mask" @click.self="cancelLogin">
      <div class="qr-box">
        <div class="qr-title">扫码登录 B 站</div>
        <div class="qr-img-wrap">
          <img :src="`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qr.url)}`" alt="二维码" />
        </div>
        <div class="qr-status" :class="qrStatus">{{ qrStatusText }}</div>
        <button class="btn small ghost" @click="cancelLogin">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bili { padding-bottom: 20px; }

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.page-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
}
.login-area {
  display: flex;
  align-items: center;
  gap: 9px;
}
.avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
.uname { font-size: 13px; font-weight: 600; }
.vip {
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #fb7299, #fc9db8);
  padding: 2px 7px;
  border-radius: 9px;
}

.search-row {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  max-width: 640px;
}
.search-row .input { flex: 1; }

.hint {
  color: var(--text-faint);
  font-size: 13px;
  padding: 26px 0;
  line-height: 1.7;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 18px;
}
.card { cursor: pointer; }
.cover {
  position: relative;
  aspect-ratio: 16/9;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-card);
  box-shadow: var(--shadow-cover);
  transition: transform 0.25s var(--ease-spring), box-shadow 0.25s var(--ease);
}
.card:hover .cover { transform: translateY(-3px); box-shadow: var(--shadow-lg); }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dur, .play-count {
  position: absolute;
  bottom: 6px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  padding: 1px 5px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.dur { right: 6px; }
.play-count { left: 6px; }
.c-title {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.c-author { font-size: 12px; color: var(--text-dim); margin-top: 3px; }

.placeholder { color: var(--text-faint); text-align: center; padding: 60px 0; }

/* 播放区 */
.player-area { display: flex; flex-direction: column; gap: 12px; }
.pa-head { display: flex; align-items: center; gap: 12px; }
.back-btn {
  font-size: 13px;
  color: var(--text-dim);
  padding: 5px 10px;
  border-radius: 6px;
  transition: background 0.15s var(--ease), color 0.15s var(--ease);
}
.back-btn:hover { background: var(--bg-hover); color: var(--text); }
.pa-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pa-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.pa-meta .tip { color: var(--accent); }
.pa-meta .codec {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}

/* 二维码弹窗 */
.qr-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.qr-box {
  background: var(--bg-elev);
  border-radius: var(--radius-lg);
  padding: 24px 28px;
  text-align: center;
  box-shadow: var(--shadow-lg);
}
.qr-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; }
.qr-img-wrap {
  width: 180px;
  height: 180px;
  margin: 0 auto 14px;
  background: #fff;
  border-radius: 8px;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.qr-img-wrap img { width: 100%; height: 100%; }
.qr-status { font-size: 13px; color: var(--text-dim); margin-bottom: 16px; }
.qr-status.scanned { color: var(--accent); font-weight: 600; }
.qr-status.expired { color: #ff9f0a; }
</style>
