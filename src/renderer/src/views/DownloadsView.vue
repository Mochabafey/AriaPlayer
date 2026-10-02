<script setup>
import { ref, computed, onMounted } from 'vue'
import { ncm } from '../api'
import { useDownloadsStore } from '../stores/downloads'
import { fmtSize } from '../utils/format'
import { toast } from '../utils/toast'

const downloads = useDownloadsStore()
const openFolders = ref({})

const doneCount = computed(() => downloads.tasks.filter((t) => t.status === 'done').length)
const failCount = computed(() => downloads.tasks.filter((t) => t.status === 'failed' || t.status === 'paused').length)

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

async function onClearCompleted() {
  const n = doneCount.value
  if (!n) return
  await downloads.clearCompleted()
  toast(`已清空 ${n} 条完成记录`, 'success')
}

async function onRetryFailed() {
  const n = failCount.value
  if (!n) return
  await downloads.retryFailed()
  toast(`已重试 ${n} 个任务`, 'success')
}

onMounted(() => {
  downloads.load()
  downloads.watch()
})
</script>

<template>
  <div class="downloads">
    <div class="head">
      <h1 class="page-title">下载</h1>
      <div class="head-actions">
        <button v-if="failCount" class="btn small ghost" @click="onRetryFailed">↻ 重试失败 ({{ failCount }})</button>
        <button v-if="doneCount" class="btn small ghost" @click="onClearCompleted">✕ 清空完成 ({{ doneCount }})</button>
      </div>
    </div>
    <p class="desc">默认保存目录可在「设置」中修改</p>

    <!-- 汇总栏：多个任务时一眼看到整体进度与速度，不用逐个看 -->
    <div v-if="downloads.activeCount" class="summary">
      <div class="sum-left">
        <span class="sum-spin"></span>
        <span class="sum-text">
          {{ downloads.activeCount }} 个任务下载中 · 总进度 {{ Math.round(downloads.overallProgress * 100) }}%
        </span>
      </div>
      <div class="sum-bar">
        <div class="sum-fill" :style="{ width: downloads.overallProgress * 100 + '%' }"></div>
      </div>
    </div>

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
            <span v-if="t.status === 'downloading'">
              {{ progressOf(t) }}% · {{ fmtSize(t.received) }} / {{ fmtSize(t.total) }}
            </span>
            <!-- 暂停/失败但已有进度：明确告知可从断点继续，而不是让用户
                 担心「是不是要重下」而不敢点重试 -->
            <span v-else-if="(t.status === 'paused' || t.status === 'failed') && t.received > 0" class="resumable">
              已下载 {{ fmtSize(t.received) }}，可从断点继续
            </span>
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
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.page-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
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

/* 汇总栏：整体进度 */
.summary {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--accent-dim);
  border: 1px solid rgba(254, 44, 85, 0.18);
  border-radius: var(--radius);
  padding: 10px 16px;
  margin-bottom: 16px;
}
.sum-left {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-shrink: 0;
}
/* 旋转小圈：静态文字容易被忽略，转起来才有"正在进行"的感觉 */
.sum-spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid var(--accent-dim);
  border-top-color: var(--accent);
  animation: sum-spin 0.8s linear infinite;
}
@keyframes sum-spin { to { transform: rotate(360deg); } }
.sum-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
}
.sum-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: rgba(254, 44, 85, 0.15);
  overflow: hidden;
}
.sum-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.3s var(--ease-out);
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
  /* 原实现硬编码 #2c2c2c（深色主题残留），在浅色主题下是一条突兀的黑条 */
  background: var(--bg-active);
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
/* 可续传提示：绿色系，与「失败」的红色区分开（这是好消息不是坏消息） */
.t-meta .resumable {
  color: var(--green);
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
