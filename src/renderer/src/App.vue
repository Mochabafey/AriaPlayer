<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PlayerBar from './components/PlayerBar.vue'
import LyricPanel from './components/LyricPanel.vue'
import AppToast from './components/AppToast.vue'
import { usePlayerStore } from './stores/player'
import { useSettingsStore } from './stores/settings'
import { ncm } from './api'

const player = usePlayerStore()
const settings = useSettingsStore()
const route = useRoute()
const router = useRouter()
const serverState = ref('down')
const sidebarQuery = ref('')
const searchInputRef = ref(null)

// 网易云风格 SVG 图标
const icons = {
  discover: 'M3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Zm12.5-4.5-4.7 1.4a2 2 0 0 0-1.3 1.3l-1.4 4.7c-.2.6.5 1.3 1.1 1.1l4.7-1.4a2 2 0 0 0 1.3-1.3l1.4-4.7c.2-.6-.5-1.3-1.1-1.1ZM13.4 13.4a1.9 1.9 0 1 1-2.7-2.7 1.9 1.9 0 0 1 2.7 2.7Z',
  library: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM9 4v16M9 12h11',
  resolver: 'M13.5 3.5 6 13h4.5L10.5 20.5 18 11h-4.5l3-7.5Z',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm9.8 15.3-4.3-4.3',
  profile: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-7 15.2C5.9 16 8.7 14.5 12 14.5s6.1 1.5 7 4.7',
  downloads: 'M12 4v9m0 0 4-4m-4 4-4-4M5 19h14',
  settings: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm7.2 3.5c0-.5.4-1 .9-1.1l1-.2a9 9 0 0 0-1.6-3.2l-.9.6a1.1 1.1 0 0 1-1.6-.3 1.1 1.1 0 0 1 .2-1.6l.7-.7a9 9 0 0 0-3-1.9l-.4 1c-.2.5-.7.8-1.2.7a1.1 1.1 0 0 1-1-1V4a9 9 0 0 0-3.6.1l.3 1c.1.5-.1 1.1-.6 1.3-.5.3-1.1.1-1.4-.3l-.6-.9a9 9 0 0 0-3 1.9l.7.7c.4.4.5 1 .2 1.6a1.1 1.1 0 0 1-1.6.3l-.9-.6a9 9 0 0 0-1.6 3.2l1 .2c.5.1.9.6.9 1.1s-.4 1-.9 1.1l-1 .2a9 9 0 0 0 1.6 3.2l.9-.6c.5-.4 1.2-.3 1.6.3.4.5.3 1.2-.2 1.6l-.7.7a9 9 0 0 0 3 1.9l.4-1c.2-.5.7-.8 1.2-.7.5.1.9.6 1 1v.1a9 9 0 0 0 3.6-.1l-.3-1c-.1-.5.1-1.1.6-1.3.5-.3 1.1-.1 1.4.3l.6.9a9 9 0 0 0 3-1.9l-.7-.7a1.1 1.1 0 0 1-.2-1.6 1.1 1.1 0 0 1 1.6-.3l.9.6a9 9 0 0 0 1.6-3.2l-1-.2a1.1 1.1 0 0 1-.9-1.1Z',
  back: 'M15 18l-6-6 6-6',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8'
}

const navGroups = [
  {
    title: '',
    items: [
      { to: '/discover', icon: 'discover', label: '推荐' },
      { to: '/search', icon: 'search', label: '搜索' },
      { to: '/resolver', icon: 'resolver', label: '解析' }
    ]
  },
  {
    title: '我的音乐',
    items: [
      { to: '/library', icon: 'library', label: '曲库' },
      { to: '/downloads', icon: 'downloads', label: '下载' },
      { to: '/profile', icon: 'profile', label: '我的' }
    ]
  },
  {
    title: '',
    items: [{ to: '/settings', icon: 'settings', label: '设置' }]
  }
]

/** 全局快捷键：空格 播放/暂停；←/→ 快退/快进 5s；↑/↓ 音量 ±5% */
function onGlobalKeydown(e) {
  const t = e.target
  if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO', 'AUDIO'].includes(t?.tagName)) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  switch (e.code) {
    case 'Space':
      e.preventDefault()
      player.toggle()
      break
    case 'Escape':
      if (player.showLyrics) player.showLyrics = false
      break
    case 'ArrowRight':
      player.seek(player.currentTime + 5)
      break
    case 'ArrowLeft':
      player.seek(Math.max(0, player.currentTime - 5))
      break
    case 'ArrowUp':
      e.preventDefault()
      player.setVolume(Math.min(1, +(player.volume + 0.05).toFixed(2)))
      break
    case 'ArrowDown':
      e.preventDefault()
      player.setVolume(Math.max(0, +(player.volume - 0.05).toFixed(2)))
      break
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeydown)
  await settings.load()
  const v = Number(settings.settings.volume)
  if (Number.isFinite(v) && v >= 0 && v <= 1) player.setVolume(v)
  ncm.onServerStatus((s) => (serverState.value = s))
  ncm.serverStatus().then((s) => (serverState.value = s))
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

function onSidebarSearch() {
  const q = sidebarQuery.value.trim()
  if (!q) return
  router.push({ path: '/search', query: { q } })
  sidebarQuery.value = ''
}

function focusSearch() {
  searchInputRef.value?.focus()
}

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
}
</script>

<template>
  <div class="app-shell">
    <!-- 左侧深色导航栏 -->
    <aside class="sidebar">
      <!-- 品牌 -->
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V6l11-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16.5" r="2.5"/></svg>
        </div>
        <span class="brand-name">网易牛具</span>
      </div>

      <!-- 分组导航 -->
      <nav class="nav">
        <div v-for="g in navGroups" :key="g.title || Math.random()" class="nav-group">
          <div class="group-title" v-if="g.title">{{ g.title }}</div>
          <RouterLink
            v-for="n in g.items"
            :key="n.to"
            :to="n.to"
            class="nav-item"
            :class="{ active: isActive(n.to) }"
          >
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icons[n.icon]"/></svg>
            <span class="nav-label">{{ n.label }}</span>
          </RouterLink>
        </div>
      </nav>

      <!-- 服务状态 -->
      <div class="server-state" :class="serverState">
        <span class="dot"></span>
        {{ serverState === 'ready' ? '服务运行中' : serverState === 'starting' ? '启动中…' : serverState === 'missing' ? '服务缺失' : '未就绪' }}
      </div>
    </aside>

    <!-- 右侧主体 -->
    <div class="right-panel">
      <!-- 顶部标题栏 -->
      <header class="top-header">
        <button class="header-btn back-btn" @click="router.back()" title="返回">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="icons.back"/></svg>
        </button>
        <div class="header-search">
          <svg class="header-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20.3 20.3-4.3-4.3"/></svg>
          <input
            ref="searchInputRef"
            v-model="sidebarQuery"
            class="header-search-input"
            placeholder="搜索音乐、歌手、歌词"
            @keyup.enter="onSidebarSearch"
          />
        </div>
        <div class="header-right">
          <button class="header-btn" title="聚焦搜索" @click="focusSearch">
            <svg class="header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icons.mic"/></svg>
          </button>
          <div class="avatar" title="我的" @click="router.push('/profile')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>
          </div>
        </div>
      </header>

      <!-- 主内容区 -->
      <main class="main">
        <div class="content">
          <RouterView v-slot="{ Component }">
            <Transition name="fade" mode="out-in">
              <component :is="Component" />
            </Transition>
          </RouterView>
        </div>
      </main>
    </div>

    <LyricPanel v-if="player.showLyrics && player.current" />
    <PlayerBar />
    <AppToast />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  padding-bottom: var(--player-h);
  background: var(--bg);
}

/* ---- 左侧白色导航栏（与内容区统一浅色） ---- */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 12px 12px;
  background: var(--bg-elev);
  border-right: 1px solid var(--hairline);
  color: var(--text-dim);
}

/* 品牌 */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 20px;
}
.brand-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand-icon svg {
  width: 18px;
  height: 18px;
  color: #fff;
}
.brand-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.5px;
}

/* 分组导航 */
.nav {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.group-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.5px;
  padding: 0 12px 6px;
  text-transform: uppercase;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  color: var(--text-dim);
  font-size: 14px;
  font-weight: 500;
  transition: background 0.15s var(--ease), color 0.15s var(--ease);
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item.active {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.nav-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

/* 服务状态 */
.server-state {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 12px 2px;
  font-size: 11px;
  color: var(--text-faint);
  border-top: 1px solid var(--hairline);
  margin-top: 10px;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: #555; }
.server-state.ready .dot { background: var(--green); box-shadow: 0 0 6px var(--green); }
.server-state.starting .dot { background: #ff9f0a; animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0.3; } }

/* ---- 右侧面板 ---- */
.right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* ---- 顶部标题栏 ---- */
.top-header {
  height: var(--header-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 20px;
  gap: 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--hairline);
}
.header-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  transition: background 0.15s;
}
.header-btn:hover { background: var(--bg-hover); }
.header-btn svg { width: 18px; height: 18px; }
.header-search {
  flex: 1;
  max-width: 420px;
  position: relative;
}
.header-search-ico {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--text-faint);
  pointer-events: none;
}
.header-search-input {
  width: 100%;
  padding: 8px 16px 8px 40px;
  border-radius: 20px;
  border: none;
  background: var(--bg-hover);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: background 0.18s var(--ease);
}
.header-search-input::placeholder { color: var(--text-faint); }
.header-search-input:focus { background: var(--bg-active); }
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.header-icon { width: 20px; height: 20px; }
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, transform 0.12s var(--ease);
}
.avatar:hover { color: var(--text); background: var(--bg-active); transform: scale(1.05); }
.avatar svg { width: 18px; height: 18px; }

/* ---- 主内容区 ---- */
.main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 20px;
}
</style>
