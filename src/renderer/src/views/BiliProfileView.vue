<script setup>
/**
 * BiliProfileView.vue — B 站个人中心
 *
 * 覆盖：个人主页头部 / 收藏夹 / 观看历史 / 稍后再看 / 关注列表 /
 *       追番追剧 / 点赞 / 投币 / 关注的收藏夹。
 *
 * ## 设计要点
 *
 * 1. **Tab 懒加载**：只在切到某个 Tab 时才请求它的数据（各接口独立，
 *    一次性全拉会打 9 个请求，慢且浪费）。切换过的 Tab 数据会缓存，
 *    再切回来不重复请求（除非手动刷新）。
 *
 * 2. **分页方式不统一**（实测）：
 *    - 收藏内容 / 关注 / 追番 / 点赞 / 投币 → 页码 `pn`
 *    - 观看历史 → **游标**（把上次返回的 cursor 原样回传）
 *    故历史单独走 cursor 分支。
 *
 * 3. **未登录 / 隐藏列表**：
 *    - 未登录 → 显示登录引导
 *    - 点赞/投币列表被用户设为私密 → B 站返回 -400，主进程归一化成
 *      `hidden: true`，这里显示「该列表未公开」而非报错。
 *
 * 4. **点视频跳回 B 站 MV 页播放**：复用 BiliView 的播放能力，
 *    通过路由 query 传 bvid（BiliView 已在 onMounted 里读 `?bvid=`）。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { bili, imgUrl } from '../api'
import { toast } from '../utils/toast'

const router = useRouter()

/* ---------------- 登录态 ---------------- */

const login = ref({ loggedIn: false })
const loading = ref(true)

/* ---------------- Tab 定义 ---------------- */

const TABS = [
  { key: 'fav', label: '收藏夹' },
  { key: 'history', label: '观看历史' },
  { key: 'toview', label: '稍后再看' },
  { key: 'followings', label: '关注' },
  { key: 'bangumi', label: '追番' },
  { key: 'likes', label: '点赞' },
  { key: 'coins', label: '投币' },
  { key: 'collected', label: '收藏的收藏夹' }
]
const tab = ref('fav')

/* ---------------- 个人主页头部 ---------------- */

const profile = ref(null)

/* ---------------- 各 Tab 的数据（独立存放，互不干扰） ---------------- */

const favFolders = ref([])          // 收藏夹列表
const favCurrent = ref(null)        // 当前打开的收藏夹
const favItems = ref([])
const favTotal = ref(0)
const favPage = ref(1)
const favHasMore = ref(false)

const history = ref([])
const historyCursor = ref(null)

const toview = ref([])

const followList = ref([])
const followTotal = ref(0)
const followPage = ref(1)

const bangumi = ref([])
const bangumiTotal = ref(0)
const bangumiPage = ref(1)
/** 追番筛选：0=全部 1=想看 2=在看 3=看过 */
const bangumiStatus = ref(0)
const BANGUMI_STATUS = [
  { v: 0, label: '全部' },
  { v: 1, label: '想看' },
  { v: 2, label: '在看' },
  { v: 3, label: '看过' }
]

const likes = ref([])
const likesHidden = ref(false)
const likesPage = ref(1)
const likesHasMore = ref(false)

const coins = ref([])
const coinsHidden = ref(false)
const coinsPage = ref(1)
const coinsHasMore = ref(false)

const collected = ref([])
const collectedTotal = ref(0)

/** 已经加载过的 Tab（避免重复请求） */
const loaded = ref({})
const busy = ref(false)

const PAGE_SIZE = 20

/* ---------------- 工具 ---------------- */

function fmtDur(sec) {
  const s = Number(sec) || 0
  if (s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${m}:${String(ss).padStart(2, '0')}`
}

function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return String(v)
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts) * 1000)
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  const p = (x) => String(x).padStart(2, '0')
  // 跨年才显示年份
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 归一化错误提示（主进程已把常见错误转成 reason） */
function errText(r) {
  if (r?.reason === 'not-login') return '请先登录 B 站'
  if (r?.reason === 'error') return r.message || '请求失败'
  return '请求失败'
}

/* ---------------- 加载逻辑 ---------------- */

async function loadLogin() {
  try {
    login.value = await bili.loginStatus()
  } catch {
    login.value = { loggedIn: false }
  }
}

async function loadProfile() {
  const r = await bili.spaceInfo()
  if (r?.ok) profile.value = r.info
}

/** 收藏夹列表 */
async function loadFavFolders() {
  const r = await bili.favFolders()
  if (r?.ok) {
    favFolders.value = r.list
    // 默认自动打开第一个收藏夹（通常是「默认收藏夹」）
    if (r.list.length && !favCurrent.value) {
      await openFolder(r.list[0])
    }
  } else {
    toast(errText(r), 'error')
  }
}

/** 打开某个收藏夹并拉第一页 */
async function openFolder(f) {
  favCurrent.value = f
  favItems.value = []
  favPage.value = 1
  await loadFavItems(1)
}

async function loadFavItems(page) {
  if (!favCurrent.value) return
  busy.value = true
  try {
    const r = await bili.favItems(favCurrent.value.id, page, PAGE_SIZE)
    if (r?.ok) {
      favItems.value = page === 1 ? r.items : [...favItems.value, ...r.items]
      favTotal.value = r.total
      favHasMore.value = r.hasMore
      favPage.value = page
    } else {
      toast(errText(r), 'error')
    }
  } finally {
    busy.value = false
  }
}

/** 观看历史（游标分页；append=true 时追加） */
async function loadHistory(append = false) {
  busy.value = true
  try {
    const r = await bili.history(append ? historyCursor.value : null, PAGE_SIZE)
    if (r?.ok) {
      history.value = append ? [...history.value, ...r.items] : r.items
      historyCursor.value = r.cursor
    } else {
      toast(errText(r), 'error')
    }
  } finally {
    busy.value = false
  }
}

async function loadToview() {
  const r = await bili.toview()
  if (r?.ok) toview.value = r.list
  else toast(errText(r), 'error')
}

async function loadFollowings(page = 1) {
  busy.value = true
  try {
    const r = await bili.followings(null, page, PAGE_SIZE)
    if (r?.ok) {
      followList.value = page === 1 ? r.items : [...followList.value, ...r.items]
      followTotal.value = r.total
      followPage.value = page
    } else {
      toast(errText(r), 'error')
    }
  } finally {
    busy.value = false
  }
}

async function loadBangumi(page = 1) {
  busy.value = true
  try {
    const r = await bili.bangumi(null, 1, page, PAGE_SIZE, bangumiStatus.value)
    if (r?.ok) {
      bangumi.value = page === 1 ? r.items : [...bangumi.value, ...r.items]
      bangumiTotal.value = r.total
      bangumiPage.value = page
    } else {
      toast(errText(r), 'error')
    }
  } finally {
    busy.value = false
  }
}

async function loadLikes(page = 1) {
  busy.value = true
  try {
    const r = await bili.likes(null, page, PAGE_SIZE)
    if (r?.ok) {
      likes.value = page === 1 ? r.items : [...likes.value, ...r.items]
      likesHidden.value = !!r.hidden
      likesPage.value = page
      likesHasMore.value = !!r.hasMore
    } else toast(errText(r), 'error')
  } finally {
    busy.value = false
  }
}

async function loadCoins(page = 1) {
  busy.value = true
  try {
    const r = await bili.coins(null, page, PAGE_SIZE)
    if (r?.ok) {
      coins.value = page === 1 ? r.items : [...coins.value, ...r.items]
      coinsHidden.value = !!r.hidden
      coinsPage.value = page
      coinsHasMore.value = !!r.hasMore
    } else toast(errText(r), 'error')
  } finally {
    busy.value = false
  }
}

async function loadCollected() {
  const r = await bili.collectedFolders(null, 1, PAGE_SIZE)
  if (r?.ok) {
    collected.value = r.items
    collectedTotal.value = r.total
  } else toast(errText(r), 'error')
}

/** 按 Tab 分发加载（首次进入才请求） */
async function ensureTab(key, force = false) {
  if (loaded.value[key] && !force) return
  switch (key) {
    case 'fav': await loadFavFolders(); break
    case 'history': await loadHistory(false); break
    case 'toview': await loadToview(); break
    case 'followings': await loadFollowings(1); break
    case 'bangumi': await loadBangumi(1); break
    case 'likes': await loadLikes(); break
    case 'coins': await loadCoins(); break
    case 'collected': await loadCollected(); break
  }
  loaded.value[key] = true
}

/** 切 Tab */
function switchTab(key) {
  tab.value = key
  if (login.value.loggedIn) ensureTab(key)
}

/** 手动刷新当前 Tab */
async function refresh() {
  loaded.value[tab.value] = false
  await ensureTab(tab.value, true)
  toast('已刷新', 'success')
}

/** 切换追番筛选 */
async function setBangumiStatus(v) {
  if (bangumiStatus.value === v) return
  bangumiStatus.value = v
  bangumiPage.value = 1
  await loadBangumi(1)
}

/* ---------------- 交互 ---------------- */

/** 打开视频 → 跳回 B 站 MV 页播放 */
function openVideo(v) {
  if (!v?.bvid) {
    // 番剧等非 bvid 体系：用系统浏览器打开
    if (v?.url) window.open(v.url, '_blank')
    return
  }
  router.push({ path: '/bili', query: { bvid: v.bvid } })
}

/** 打开 up 主主页（用 B 站网页，应用内暂不做 up 主页） */
function openUp(mid) {
  if (mid) window.open(`https://space.bilibili.com/${mid}`, '_blank')
}

/** 打开收藏夹归属页 */
function openCollectedFolder(f) {
  if (f?.id) router.push({ path: '/bili/profile', query: { folder: String(f.id) } })
}

function relogin() {
  router.push('/bili')
}

/* ---------------- 生命周期 ---------------- */

onMounted(async () => {
  loading.value = true
  await loadLogin()
  if (login.value.loggedIn) {
    // 并行拉「主页头部」与「默认 Tab」，两者互不依赖
    await Promise.all([loadProfile(), ensureTab(tab.value)])
  }
  loading.value = false
})

// 从 B 站页登录后切回来时，重新检测登录态
watch(() => login.value.loggedIn, (v) => {
  if (v) {
    loadProfile()
    ensureTab(tab.value, true)
  }
})
</script>

<template>
  <div class="bp">
    <!-- 加载中 -->
    <div v-if="loading" class="placeholder">加载中…</div>

    <!-- 未登录 -->
    <div v-else-if="!login.loggedIn" class="placeholder">
      <p>需要登录 B 站才能查看个人主页、收藏夹与观看历史。</p>
      <button class="btn" @click="relogin">去登录</button>
    </div>

    <template v-else>
      <!-- 个人主页头部 -->
      <div v-if="profile" class="hero">
        <img v-if="profile.banner" class="hero-banner" :src="imgUrl(profile.banner)" alt="" />
        <div class="hero-body">
          <img class="hero-face" :src="imgUrl(profile.face)" alt="" />
          <div class="hero-info">
            <div class="hero-name-row">
              <span class="hero-name">{{ profile.name }}</span>
              <span class="hero-level">Lv{{ profile.level }}</span>
              <span v-if="profile.vip" class="vip">{{ profile.vipLabel || '大会员' }}</span>
              <span v-if="profile.official" class="official">{{ profile.official }}</span>
            </div>
            <div v-if="profile.sign" class="hero-sign">{{ profile.sign }}</div>
            <div class="hero-stats">
              <span><b>{{ fmtCount(profile.following) }}</b> 关注</span>
              <span><b>{{ fmtCount(profile.follower) }}</b> 粉丝</span>
              <span v-if="profile.coins"><b>{{ profile.coins }}</b> 硬币</span>
              <span class="hero-mid">UID {{ profile.mid }}</span>
            </div>
          </div>
          <button class="btn small ghost" @click="refresh">刷新</button>
        </div>
      </div>

      <!-- Tab 栏 -->
      <div class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ on: tab === t.key }"
          @click="switchTab(t.key)"
        >{{ t.label }}</button>
      </div>

      <!-- ========== 收藏夹 ========== -->
      <div v-if="tab === 'fav'" class="pane">
        <div v-if="!favFolders.length" class="placeholder">还没有收藏夹</div>
        <template v-else>
          <!-- 收藏夹选择条 -->
          <div class="folder-bar">
            <button
              v-for="f in favFolders"
              :key="f.id"
              class="folder-chip"
              :class="{ on: favCurrent && favCurrent.id === f.id }"
              @click="openFolder(f)"
            >
              {{ f.title }}
              <span class="chip-count">{{ f.mediaCount }}</span>
            </button>
          </div>

          <div v-if="!favItems.length" class="placeholder">
            {{ busy ? '加载中…' : '这个收藏夹是空的' }}
          </div>
          <div v-else class="grid">
            <div v-for="v in favItems" :key="v.bvid || v.aid" class="card" @click="openVideo(v)">
              <div class="cover">
                <img :src="imgUrl(v.cover)" alt="" loading="lazy" />
                <span v-if="v.duration" class="dur">{{ fmtDur(v.duration) }}</span>
                <span v-if="v.play" class="play-count">▶ {{ fmtCount(v.play) }}</span>
              </div>
              <div class="c-title" :title="v.title">{{ v.title }}</div>
              <div class="c-author">{{ v.author }}</div>
            </div>
          </div>

          <div v-if="favHasMore" class="more-row">
            <button class="btn small ghost" :disabled="busy" @click="loadFavItems(favPage + 1)">
              {{ busy ? '加载中…' : `加载更多（共 ${favTotal} 个）` }}
            </button>
          </div>
        </template>
      </div>

      <!-- ========== 观看历史 ========== -->
      <div v-else-if="tab === 'history'" class="pane">
        <div v-if="!history.length" class="placeholder">
          {{ busy ? '加载中…' : '还没有观看记录' }}
        </div>
        <div v-else class="grid">
          <div v-for="v in history" :key="v.bvid + '_' + v.viewAt" class="card" @click="openVideo(v)">
            <div class="cover">
              <img :src="imgUrl(v.cover)" alt="" loading="lazy" />
              <span v-if="v.duration" class="dur">{{ fmtDur(v.duration) }}</span>
              <!-- 观看进度条：直观显示看到哪儿了 -->
              <div v-if="v.progress > 0 && v.duration > 0" class="progress-bar">
                <i :style="{ width: Math.min(100, (v.progress / v.duration) * 100) + '%' }" />
              </div>
            </div>
            <div class="c-title" :title="v.title">{{ v.title }}</div>
            <div class="c-author">
              {{ v.author }}
              <span class="c-time">{{ fmtDate(v.viewAt) }}</span>
            </div>
          </div>
        </div>
        <div v-if="history.length && historyCursor" class="more-row">
          <button class="btn small ghost" :disabled="busy" @click="loadHistory(true)">
            {{ busy ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>

      <!-- ========== 稍后再看 ========== -->
      <div v-else-if="tab === 'toview'" class="pane">
        <div v-if="!toview.length" class="placeholder">稍后再看是空的</div>
        <div v-else class="grid">
          <div v-for="v in toview" :key="v.bvid || v.aid" class="card" @click="openVideo(v)">
            <div class="cover">
              <img :src="imgUrl(v.cover)" alt="" loading="lazy" />
              <span v-if="v.duration" class="dur">{{ fmtDur(v.duration) }}</span>
              <span v-if="v.play" class="play-count">▶ {{ fmtCount(v.play) }}</span>
            </div>
            <div class="c-title" :title="v.title">{{ v.title }}</div>
            <div class="c-author">{{ v.author }}</div>
          </div>
        </div>
      </div>

      <!-- ========== 关注 ========== -->
      <div v-else-if="tab === 'followings'" class="pane">
        <div v-if="!followList.length" class="placeholder">
          {{ busy ? '加载中…' : '还没有关注任何人' }}
        </div>
        <div v-else class="up-grid">
          <div v-for="u in followList" :key="u.mid" class="up-card" @click="openUp(u.mid)">
            <img class="up-face" :src="imgUrl(u.face)" alt="" loading="lazy" />
            <div class="up-name" :title="u.name">{{ u.name }}</div>
            <div v-if="u.sign" class="up-sign" :title="u.sign">{{ u.sign }}</div>
            <div class="up-tags">
              <span v-if="u.vip" class="vip">大会员</span>
              <span v-if="u.official" class="official">{{ u.official }}</span>
            </div>
          </div>
        </div>
        <div v-if="followList.length < followTotal" class="more-row">
          <button class="btn small ghost" :disabled="busy" @click="loadFollowings(followPage + 1)">
            {{ busy ? '加载中…' : `加载更多（共 ${followTotal} 个）` }}
          </button>
        </div>
      </div>

      <!-- ========== 追番 ========== -->
      <div v-else-if="tab === 'bangumi'" class="pane">
        <div class="filter-row">
          <button
            v-for="s in BANGUMI_STATUS"
            :key="s.v"
            class="filter-chip"
            :class="{ on: bangumiStatus === s.v }"
            @click="setBangumiStatus(s.v)"
          >{{ s.label }}</button>
        </div>
        <div v-if="!bangumi.length" class="placeholder">
          {{ busy ? '加载中…' : '这个分类下没有内容' }}
        </div>
        <div v-else class="grid">
          <div v-for="b in bangumi" :key="b.seasonId || b.mediaId" class="card" @click="openVideo(b)">
            <div class="cover">
              <img :src="imgUrl(b.cover)" alt="" loading="lazy" />
              <span v-if="b.badge" class="badge">{{ b.badge }}</span>
              <span v-if="b.progress" class="play-count">{{ b.progress }}</span>
            </div>
            <div class="c-title" :title="b.title">{{ b.title }}</div>
            <div class="c-author">
              {{ b.typeName }}
              <span v-if="b.isFinish" class="c-time">已完结</span>
            </div>
          </div>
        </div>
        <div v-if="bangumi.length < bangumiTotal" class="more-row">
          <button class="btn small ghost" :disabled="busy" @click="loadBangumi(bangumiPage + 1)">
            {{ busy ? '加载中…' : `加载更多（共 ${bangumiTotal} 个）` }}
          </button>
        </div>
      </div>

      <!-- ========== 点赞 ========== -->
      <div v-else-if="tab === 'likes'" class="pane">
        <div v-if="likesHidden" class="placeholder">该列表未公开（B 站隐私设置）</div>
        <div v-else-if="!likes.length" class="placeholder">还没有点赞过视频</div>
        <div v-else class="grid">
          <div v-for="v in likes" :key="v.bvid || v.aid" class="card" @click="openVideo(v)">
            <div class="cover">
              <img :src="imgUrl(v.cover)" alt="" loading="lazy" />
              <span v-if="v.duration" class="dur">{{ fmtDur(v.duration) }}</span>
              <span v-if="v.play" class="play-count">▶ {{ fmtCount(v.play) }}</span>
            </div>
            <div class="c-title" :title="v.title">{{ v.title }}</div>
            <div class="c-author">{{ v.author }}</div>
          </div>
        </div>
        <div v-if="likesHasMore" class="more-row">
          <button class="btn small ghost" :disabled="busy" @click="loadLikes(likesPage + 1)">
            {{ busy ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>

      <!-- ========== 投币 ========== -->
      <div v-else-if="tab === 'coins'" class="pane">
        <div v-if="coinsHidden" class="placeholder">该列表未公开（B 站隐私设置）</div>
        <div v-else-if="!coins.length" class="placeholder">还没有投币过视频</div>
        <div v-else class="grid">
          <div v-for="v in coins" :key="v.bvid || v.aid" class="card" @click="openVideo(v)">
            <div class="cover">
              <img :src="imgUrl(v.cover)" alt="" loading="lazy" />
              <span v-if="v.duration" class="dur">{{ fmtDur(v.duration) }}</span>
            </div>
            <div class="c-title" :title="v.title">{{ v.title }}</div>
            <div class="c-author">{{ v.author }}</div>
          </div>
        </div>
        <div v-if="coinsHasMore" class="more-row">
          <button class="btn small ghost" :disabled="busy" @click="loadCoins(coinsPage + 1)">
            {{ busy ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>

      <!-- ========== 收藏的收藏夹 ========== -->
      <div v-else-if="tab === 'collected'" class="pane">
        <div v-if="!collected.length" class="placeholder">还没有收藏别人的收藏夹</div>
        <div v-else class="folder-grid">
          <div
            v-for="f in collected"
            :key="f.id"
            class="folder-card"
            @click="openCollectedFolder(f)"
          >
            <div class="fc-title" :title="f.title">{{ f.title }}</div>
            <div class="fc-meta">
              <span>{{ f.mediaCount }} 个内容</span>
              <span v-if="f.owner">来自 {{ f.owner }}</span>
            </div>
          </div>
        </div>
        <div v-if="collected.length && collected.length < collectedTotal" class="more-row">
          <span class="more-hint">共 {{ collectedTotal }} 个</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bp { padding-bottom: 24px; }

.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 60px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

/* ---- 个人主页头部 ---- */
.hero {
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
  margin-bottom: 18px;
}
.hero-banner { width: 100%; height: 120px; object-fit: cover; display: block; }
.hero-body {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 16px;
  /* 无 banner 时补上边距，避免贴顶 */
  margin-top: -34px;
}
.hero-face {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 3px solid var(--bg-card);
  background: var(--bg-hover);
  flex: none;
}
.hero-info { flex: 1; min-width: 0; padding-top: 34px; }
.hero-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hero-name { font-size: 17px; font-weight: 700; }
.hero-level {
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  border-radius: 3px;
  padding: 1px 5px;
}
.vip {
  font-size: 11px;
  font-weight: 600;
  color: #b8860b;
  background: linear-gradient(135deg, #ffe9a8, #ffd062);
  border-radius: 3px;
  padding: 1px 5px;
}
.official {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 5px;
}
.hero-sign {
  font-size: 12.5px;
  color: var(--text-dim);
  margin-top: 6px;
  line-height: 1.5;
}
.hero-stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12.5px;
  color: var(--text-dim);
  margin-top: 8px;
}
.hero-stats b { color: var(--text); font-weight: 600; }
.hero-mid { color: var(--text-faint); }

/* ---- Tab 栏 ---- */
.tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.tab {
  font-size: 13px;
  color: var(--text-dim);
  padding: 8px 12px;
  border-radius: 8px 8px 0 0;
  border-bottom: 2px solid transparent;
  transition: color 0.15s var(--ease), background 0.15s var(--ease);
}
.tab:hover { background: var(--bg-hover); color: var(--text); }
.tab.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

.pane { min-height: 200px; }

/* ---- 收藏夹选择条 ---- */
.folder-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.folder-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 5px 12px;
  transition: all 0.15s var(--ease);
}
.folder-chip:hover { border-color: var(--border-strong); color: var(--text); }
.folder-chip.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
.chip-count {
  font-size: 11px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

/* ---- 筛选条（追番状态）---- */
.filter-row { display: flex; gap: 8px; margin-bottom: 14px; }
.filter-chip {
  font-size: 12.5px;
  color: var(--text-dim);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 4px 14px;
  transition: all 0.15s var(--ease);
}
.filter-chip:hover { border-color: var(--border-strong); color: var(--text); }
.filter-chip.on { color: #fff; background: var(--accent); border-color: var(--accent); }

/* ---- 视频网格（与 BiliView 保持一致）---- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
.card { cursor: pointer; }
.cover {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-hover);
  transition: transform 0.18s var(--ease), box-shadow 0.18s var(--ease);
}
.card:hover .cover { transform: translateY(-3px); box-shadow: var(--shadow-lg); }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dur, .play-count, .badge {
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
.badge { top: 6px; bottom: auto; left: 6px; background: var(--accent); }
/* 观看进度条（历史 Tab） */
.progress-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(0, 0, 0, 0.35);
}
.progress-bar i { display: block; height: 100%; background: var(--accent); }
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
.c-time { color: var(--text-faint); margin-left: 6px; }

/* ---- up 主网格 ---- */
.up-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}
.up-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 16px 12px;
  border-radius: var(--radius);
  background: var(--bg-card);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s var(--ease);
}
.up-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
.up-face {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--bg-hover);
}
.up-name {
  font-size: 13px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up-sign {
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.up-tags { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; }

/* ---- 收藏夹卡片 ---- */
.folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.folder-card {
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--bg-card);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s var(--ease);
}
.folder-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
.fc-title { font-size: 13.5px; font-weight: 600; margin-bottom: 6px; }
.fc-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-dim);
  flex-wrap: wrap;
}

/* ---- 加载更多 ---- */
.more-row { display: flex; justify-content: center; margin-top: 20px; }
.more-hint { font-size: 12.5px; color: var(--text-faint); }
</style>
