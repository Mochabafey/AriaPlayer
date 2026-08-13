<script setup>
import { ref, onMounted } from 'vue'
import { ncm } from '../api'
import { useDownloadsStore } from '../stores/downloads'
import { fmtSize } from '../utils/format'

const downloads = useDownloadsStore()
const openFolders = ref({})

const statusMeta = {
  pending: { label: '等待中', cls: '' },
  downloading: { label: '下载中', cls: 'active' },
  paused: { label: '已暂停', cls: 'paused' },
  done: { label: '已完成', cls: 'done' },
  failed: { label: '失败', cls: 'failed' }
}

function statusOf(t) {
  return statusMeta[t.status] || { label: t.status, cls: '' }
}

function progressOf(t) {
  if (!t.total) return t.status === 'done' ? 100 : 0
  return Math.min(100, Math.round((t.received / t.total) * 100))
}

function openFile(t) {
  if (t.path) ncm.openFolder(t.path)
}

onMounted(() => {
  downloads.load()
  downloads.watch()
})
</script>

<template>
  <div class="downloads">
    <h1 class="page-title">下载</h1>
    <p class="desc">默认保存目录可在「设置」中修改</p>

    <div v-if="!downloads.tasks.length" class="placeholder">
      暂无下载任务<br />
      <span class="sub">从搜索、歌单、解析页点击 ⇩ 即可下载</span>
    </div>

    <div class="list">
      <div v-for="t in downloads.tasks" :key="t.id" class="task">
        <div class="t-info">
          <div class="t-title">{{ t.title }}</div>
          <div class="t-artist">{{ t.artist }} · {{ t.ext.toUpperCase() }}</div>
        </div>

        <div class="t-progress">
          <div class="bar">
            <div class="fill" :class="statusOf(t).cls" :style="{ width: progressOf(t) + '%' }"></div>
          </div>
          <div class="t-meta">
            <span :class="statusOf(t).cls">{{ statusOf(t).label }}</span>
            <span v-if="t.status === 'downloading'">{{ fmtSize(t.received) }} / {{ fmtSize(t.total) }}</span>
            <span v-else-if="t.status === 'done'">{{ fmtSize(t.total) }}</span>
            <span v-else-if="t.error" class="err">{{ t.error }}</span>
          </div>
        </div>

        <div class="t-ops">
          <button v-if="t.status === 'downloading' || t.status === 'pending'" class="op" title="暂停" @click="downloads.cancel(t.id)">⏸</button>
          <button v-else-if="t.status === 'paused' || t.status === 'failed'" class="op" title="重试" @click="downloads.retry(t.id)">↻</button>
          <button v-if="t.status === 'done'" class="op" title="打开所在文件夹" @click="openFile(t)">📁</button>
          <button class="op" title="删除记录" @click="downloads.remove(t.id, { deleteFile: false })">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 22px;
  margin-bottom: 6px;
}
.desc {
  color: var(--text-faint);
  font-size: 12px;
  margin-bottom: 20px;
}
.placeholder {
  color: var(--text-faint);
  text-align: center;
  padding: 80px 0;
}
.placeholder .sub {
  font-size: 12px;
  color: var(--text-faint);
  opacity: 0.7;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.task {
  display: flex;
  align-items: center;
  gap: 18px;
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 14px 18px;
  box-shadow: var(--shadow-sm);
  transition: background 0.18s var(--ease), box-shadow 0.18s var(--ease);
}
.task:hover {
  background: var(--bg-hover);
  box-shadow: var(--shadow);
}
.t-info {
  width: 240px;
  flex-shrink: 0;
  min-width: 0;
}
.t-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.t-artist {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 3px;
}
.t-progress {
  flex: 1;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: #2c2c2c;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--text-dim);
  border-radius: 3px;
  transition: width 0.2s;
}
.fill.active {
  background: var(--accent);
}
.fill.done {
  background: var(--green);
}
.fill.failed {
  background: var(--accent);
  opacity: 0.6;
}
.t-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 6px;
}
.t-meta .active {
  color: var(--accent);
}
.t-meta .done {
  color: var(--green);
}
.t-meta .failed {
  color: var(--accent);
}
.t-meta .err {
  color: var(--accent);
}
.t-ops {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.op {
  color: var(--text-dim);
  padding: 6px;
  font-size: 14px;
}
.op:hover {
  color: var(--text);
}
</style>
