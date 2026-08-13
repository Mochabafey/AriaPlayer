<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import PlayerBar from './components/PlayerBar.vue'
import LyricPanel from './components/LyricPanel.vue'
import { usePlayerStore } from './stores/player'
import { useSettingsStore } from './stores/settings'

const player = usePlayerStore()
const settings = useSettingsStore()
const route = useRoute()
const serverState = ref('down')

const navs = [
  { to: '/discover', icon: '◈', label: '发现' },
  { to: '/library', icon: '▤', label: '曲库' },
  { to: '/resolver', icon: '⌁', label: '解析' },
  { to: '/search', icon: '⌕', label: '搜索' },
  { to: '/profile', icon: '☺', label: '我的' },
  { to: '/downloads', icon: '⇩', label: '下载' },
  { to: '/settings', icon: '⚙', label: '设置' }
]

onMounted(() => {
  settings.load()
  const { ncm } = window
  ncm.onServerStatus((s) => (serverState.value = s))
  ncm.invoke('ncm:server-status').then((s) => (serverState.value = s))
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="logo">
        <span class="logo-icon">♪</span>
        <div>
          <div class="logo-name">网易牛具</div>
          <div class="logo-sub">Netease Track Resolver</div>
        </div>
      </div>
      <nav class="nav">
        <RouterLink
          v-for="n in navs"
          :key="n.to"
          :to="n.to"
          class="nav-item"
          :class="{ active: route.path.startsWith(n.to) }"
        >
          <span class="nav-icon">{{ n.icon }}</span>
          <span>{{ n.label }}</span>
        </RouterLink>
      </nav>
      <div class="server-state" :class="serverState">
        <span class="dot"></span>
        {{ serverState === 'ready' ? '服务运行中' : serverState === 'starting' ? '服务启动中…' : serverState === 'missing' ? '服务缺失' : '服务未就绪' }}
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
}
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 20px;
}
.logo-icon {
  width: 40px;
  height: 40px;
  border-radius: 11px;
  background: linear-gradient(135deg, var(--accent), var(--accent-soft));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  color: #fff;
  box-shadow: 0 4px 14px rgba(236, 65, 65, 0.35);
  transition: transform 0.3s var(--ease-spring);
}
.logo:hover .logo-icon {
  transform: rotate(-8deg) scale(1.05);
}
.logo-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.logo-sub {
  font-size: 10px;
  color: var(--text-faint);
  letter-spacing: 0.3px;
  margin-top: 1px;
}
.nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 14px;
  transition: background 0.18s var(--ease), color 0.18s var(--ease);
}
.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nav-item.active {
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  bottom: 20%;
  width: 3px;
  border-radius: 3px;
  background: var(--accent);
}
.nav-icon {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 14px;
  background: transparent;
  transition: background 0.18s var(--ease);
}
.nav-item:hover .nav-icon {
  background: var(--bg-active);
}
.nav-item.active .nav-icon {
  background: var(--accent-dim);
}
.server-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
}
.server-state.ready .dot {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.server-state.starting .dot {
  background: #f0a020;
  animation: blink 1s infinite;
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}
.main {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.content {
  flex: 1;
  overflow-y: auto;
  padding: 26px 30px 22px;
}
</style>
