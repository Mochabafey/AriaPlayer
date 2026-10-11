<script setup>
/**
 * 通用右键菜单。
 *
 * 用 Teleport 挂到 body：菜单要浮在**所有**内容之上，若留在原 DOM 位置，
 * 会被祖先的 overflow/transform/stacking context 裁掉或压住
 *（本项目的列表容器有 overflow: auto，菜单会在边缘被剪）。
 *
 * 定位策略：优先向右下展开，接近视口边缘时翻转到左侧/上方，
 * 并做 8px 内边距收边 —— 避免菜单被窗口边缘截断。
 */
import { ref, watch, nextTick, onUnmounted } from 'vue'

const props = defineProps({
  /** 是否显示 */
  show: { type: Boolean, default: false },
  /** 鼠标位置 {x, y} */
  at: { type: Object, default: () => ({ x: 0, y: 0 }) },
  /** 菜单项：[{ label, icon?, danger?, disabled?, divider?, action }] */
  items: { type: Array, default: () => [] }
})

const emit = defineEmits(['close'])

const menuEl = ref(null)
const pos = ref({ x: 0, y: 0 })

/** 计算最终位置：先按鼠标点放，超出视口则翻转 */
async function place() {
  pos.value = { x: props.at.x, y: props.at.y }
  await nextTick()
  const el = menuEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const pad = 8
  let { x, y } = props.at
  if (x + r.width > window.innerWidth - pad) x = Math.max(pad, props.at.x - r.width)
  if (y + r.height > window.innerHeight - pad) y = Math.max(pad, props.at.y - r.height)
  pos.value = { x, y }
}

watch(
  () => [props.show, props.at.x, props.at.y],
  ([s]) => { if (s) place() }
)

/** 点击别处 / 滚动 / 按 Esc 都关闭 —— 菜单不该在页面变动后停留在原位 */
function onDocDown(e) {
  if (!props.show) return
  if (menuEl.value && menuEl.value.contains(e.target)) return
  emit('close')
}
function onKey(e) {
  if (props.show && e.key === 'Escape') emit('close')
}
function onScroll() {
  if (props.show) emit('close')
}

document.addEventListener('mousedown', onDocDown, true)
document.addEventListener('keydown', onKey)
window.addEventListener('scroll', onScroll, true)
window.addEventListener('resize', onScroll)
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
})

function pick(item) {
  if (item.disabled || item.divider) return
  emit('close')
  item.action?.()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      ref="menuEl"
      class="ctx-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @contextmenu.prevent
    >
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.divider" class="ctx-divider"></div>
        <button
          v-else
          class="ctx-item"
          :class="{ danger: it.danger, disabled: it.disabled }"
          :disabled="it.disabled"
          @click="pick(it)"
        >
          <span v-if="it.icon" class="ctx-icon">{{ it.icon }}</span>
          <span class="ctx-label">{{ it.label }}</span>
          <span v-if="it.hint" class="ctx-hint">{{ it.hint }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 176px;
  padding: 5px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.1);
  animation: ctx-in 0.1s var(--ease);
}
@keyframes ctx-in {
  from { opacity: 0; transform: scale(0.97) translateY(-2px); }
  to { opacity: 1; transform: none; }
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  transition: background 0.12s;
}
.ctx-item:hover:not(.disabled) {
  background: var(--bg-hover);
}
.ctx-item.danger {
  color: var(--accent);
}
.ctx-item.danger:hover:not(.disabled) {
  background: var(--accent-dim);
}
.ctx-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctx-icon {
  width: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.ctx-item.danger .ctx-icon {
  color: var(--accent);
}
.ctx-label {
  flex: 1;
  white-space: nowrap;
}
.ctx-hint {
  font-size: 11px;
  color: var(--text-faint);
}
.ctx-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--hairline);
}
</style>
