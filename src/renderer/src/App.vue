<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PlayerBar from './components/PlayerBar.vue'
import LyricPanel from './components/LyricPanel.vue'
import { usePlayerStore } from './stores/player'
import { useSettingsStore } from './stores/settings'
import { ncm } from './api'

const player = usePlayerStore()
const settings = useSettingsStore()
const route = useRoute()
const router = useRouter()
const serverState = ref('down')
const sidebarQuery = ref('')

// Apple Music 风格 SVG 图标（SF Symbols 线性风格）
const icons = {
  discover: 'M3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Zm12.5-4.5-4.7 1.4a2 2 0 0 0-1.3 1.3l-1.4 4.7c-.2.6.5 1.3 1.1 1.1l4.7-1.4a2 2 0 0 0 1.3-1.3l1.4-4.7c.2-.6-.5-1.3-1.1-1.1ZM13.4 13.4a1.9 1.9 0 1 1-2.7-2.7 1.9 1.9 0 0 1 2.7 2.7Z',
  library: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM9 4v16M9 12h11',
  resolver: 'M13.5 3.5 6 13h4.5L10.5 20.5 18 11h-4.5l3-7.5Z',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm9.8 15.3-4.3-4.3',
  profile: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-7 15.2C5.9 16 8.7 14.5 12 14.5s6.1 1.5 7 4.7',
  downloads: 'M12 4v9m0 0 4-4m-4 4-4-4M5 19h14',
  settings: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm7.2 3.5c0-.5.4-1 .9-1.1l1-.2a9 9 0 0 0-1.6-3.2l-.9.6a1.1 1.1 0 0 1-1.6-.3 1.1 1.1 0 0 1 .2-1.6l.7-.7a9 9 0 0 0-3-1.9l-.4 1c-.2.5-.7.8-1.2.7a1.1 1.1 0 0 1-1-1V4a9 9 0 0 0-3.6.1l.3 1c.1.5-.1 1.1-.6 1.3-.5.3-1.1.1-1.4-.3l-.6-.9a9 9 0 0 0-3 1.9l.7.7c.4.4.5 1 .2 1.6a1.1 1.1 0 0 1-1.6.3l-.9-.6a9 9 0 0 0-1.6 3.2l1 .2c.5.1.9.6.9 1.1s-.4 1-.9 1.1l-1 .2a9 9 0 0 0 1.6 3.2l.9-.6c.5-.4 1.2-.3 1.6.3.4.5.3 1.2-.2 1.6l-.7.7a9 9 0 0 0 3 1.9l.4-1c.2-.5.7-.8 1.2-.7.5.1.9.6 1 1v.1a9 9 0 0 0 3.6-.1l-.3-1c-.1-.5.1-1.1.6-1.3.5-.3 1.1-.1 1.4.3l.6.9a9 9 0 0 0 3-1.9l-.7-.7a1.1 1.1 0 0 1-.2-1.6 1.1 1.1 0 0 1 1.6-.3l.9.6a9 9 0 0 0 1.6-3.2l-1-.2a1.1 1.1 0 0 1-.9-1.1Z'
}

const navGroups = [
  {
    title: '在线',
    items: [
      { to: '/discover', icon: 'discover', label: '发现' },
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
    title: '系统',
    items: [{ to: '/settings', icon: 'settings', label: '设置' }]
  }
]

onMounted(async () => {
  await settings.load()
  // 恢复持久化音量到播放器（store 默认 0.8，不同步会导致显示与实际音量不一致）
  const v = Number(settings.settings.volume)
  if (Number.isFinite(v) && v >= 0 && v <= 1) player.setVolume(v)
  ncm.onServerStatus((s) => (serverState.value = s))
  ncm.serverStatus().then((s) => (serverState.value = s))
})

function onSidebarSearch() {
  const q = sidebarQuery.value.trim()
  if (!q) return
  router.push({ path: '/search', query: { q } })
  sidebarQuery.value = ''
}

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar glass">
      <!-- 品牌 -->
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V6l11-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16.5" r="2.5"/></svg>
        </div>
        <span class="brand-name">网易牛具</span>
      </div>

      <!-- 搜索框 -->
      <div class="search-box">
        <svg class="search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20.3 20.3-4.3-4.3"/></svg>
        <input
          v-model="sidebarQuery"
          class="search-input"
          placeholder="搜索"
          @keyup.enter="onSidebarSearch"
        />
      </div>

      <!-- 分组导航 -->
      <nav class="nav">
        <div v-for="g in navGroups" :key="g.title" class="nav-group">
          <div class="group-title">{{ g.title }}</div>
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

    <main class="main">
      <div class="content">
        <RouterView v-slot="{ Component }">
          <Transition name="fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </div>
    </main>

    <LyricPanel v-if="player.showLyrics && player.current" />
    <PlayerBar />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  padding-bottom: var(--player-h);
  background: var(--bg);
}

/* ---- 侧边栏（毛玻璃） ---- */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 14px 14px;
  border-right: 1px solid var(--hairline);
}

/* 品牌 */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 8px 16px;
}
.brand-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(145deg, var(--accent), #c2183a);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px var(--accent-glow);
}
.brand-icon svg {
  width: 17px;
  height: 17px;
  color: #fff;
}
.brand-name {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.3px;
}

/* 搜索框 */
.search-box {
  position: relative;
  margin: 0 4px 16px;
}
.search-ico {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 15px;
  height: 15px;
  color: var(--text-faint);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 7px 12px 7px 32px;
  border-radius: 8px;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: background 0.18s var(--ease);
}
.search-input::placeholder { color: var(--text-faint); }
.search-input:focus { background: rgba(255, 255, 255, 0.13); }

/* 分组导航 */
.nav {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.nav-group { display: flex; flex-direction: column; gap: 1px; }
.group-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.5px;
  padding: 0 12px 6px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-radius: 7px;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  transition: background 0.15s var(--ease);
}
.nav-item:hover { background: rgba(255, 255, 255, 0.07); }
.nav-item.active { background: rgba(255, 255, 255, 0.1); }
.nav-icon {
  width: 19px;
  height: 19px;
  color: var(--accent);
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

/* ---- 主内容区 ---- */
.main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.content {
  flex: 1;
  overflow-y: auto;
  padding: 30px 34px 26px;
}
</style>
