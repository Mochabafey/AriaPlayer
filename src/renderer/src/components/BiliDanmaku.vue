<script setup>
/**
 * BiliDanmaku.vue — 弹幕层
 *
 * ## 为什么不用「每次 timeupdate 重建 + animationDelay」
 *
 * 最初的实现是每次时间推进都整批重建 DOM，靠 `animationDelay` 让弹幕
 * 「到点出现」。但 timeupdate 每 250ms 触发一次，每次都会重设 animationDelay，
 * **CSS 动画被反复重置**——表现为弹幕一跳一跳（每 250ms 回到起点重新跑）。
 *
 * ## 现在的方案：一次性挂载 + CSS 动画自行推进
 *
 *   - 弹幕只在进入时间窗时**挂载一次**，挂载时算好 animation-delay
 *     （负值=从动画中途开始，正值=延迟启动）
 *   - 之后**不再修改**该元素的动画相关样式 → CSS 动画连续跑完，不重置
 *   - 用 `key` 保证同一弹幕不会被重新创建（Vue 复用已有 DOM）
 *
 * 这样 JS 只在「有新弹幕进入窗口」时才动 DOM，时间推进不触发任何重排。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  /** 弹幕列表 [{ time, text, mode, color, size }]，按时间升序 */
  list: { type: Array, default: () => [] },
  /** 当前播放时间（秒） */
  time: { type: Number, default: 0 },
  /** 是否显示 */
  enabled: { type: Boolean, default: true },
  /** 不透明度 0~1 */
  opacity: { type: Number, default: 0.9 },
  /** 字号缩放 0.5~2 */
  fontScale: { type: Number, default: 1 },
  /** 显示区域占容器高度的比例（0.25~1） */
  displayArea: { type: Number, default: 1 },
  /** 是否正在播放（暂停时冻结动画） */
  playing: { type: Boolean, default: true },
  /**
   * 弹幕合并：短时间内**内容相同**的弹幕合并为一条，显示「内容 xN」。
   *
   * 参考 NipaPlay-Reload 的合并弹幕设计（DanmakuContentItem.countText）。
   * 好处：刷屏的重复弹幕（「前方高能」「awsl」）不会占满轨道，
   * 既提升可读性也降低渲染量。
   */
  merge: { type: Boolean, default: true },
  /** 合并窗口（秒）：该时间内的相同内容视为同一条 */
  mergeWindow: { type: Number, default: 3 }
})

const wrapRef = ref(null)
const containerH = ref(0)
const containerW = ref(0)

/** 轨道高度（px） */
const LANE_H = 26
/** 滚动弹幕穿过一屏的基准时长（秒） */
const SCROLL_SEC = 9
/** 顶部/底部停留时长（秒） */
const FIXED_SEC = 5
/**
 * 滚动弹幕的安全间距（占容器宽度的比例）。
 *
 * 同一轨道相邻两条弹幕之间留出的水平空隙，避免文字挨得过近。
 * 参考 NipaPlay-Reload 的 `_safetyMarginRatio`（约 2%~5%）。
 */
const SAFETY_RATIO = 0.03
/** 时间窗：提前多久挂载（秒） */
const LEAD = 1.5
/**
 * 时间窗：滞后多久卸载（秒）。
 *
 * 必须 ≥ 滚动动画时长（SCROLL_SEC），否则弹幕还没跑完就被卸载 ——
 * 表现为弹幕刚出现就消失（实测：滞后 1s 时弹幕只显示 0.2 秒）。
 * 这里取 SCROLL_SEC + 1 作为余量。
 */
const LAG = SCROLL_SEC + 1

const laneCount = computed(() =>
  Math.max(1, Math.floor((containerH.value * props.displayArea) / LANE_H))
)

/**
 * 已挂载的弹幕：key → item。
 *
 * 用 Map 而非数组：需要按 key 增量增删，且已挂载的项**不再重算**
 * （重算会改 animationDelay，导致动画重置）。
 */
const mounted = ref([])
/** 已挂载项的 key 集合（快速判重） */
let mountedKeys = new Set()
/** 轨道占用：lane → 释放时刻（播放时间轴） */
let laneFreeAt = []
/** 顶部/底部占用：`mode-lane` → 释放时刻 */
let fixedFreeAt = {}

/** 估算文本宽度（中日韩/全角按 1em，其余 0.55em） */
function estimateWidth(text, fontSize) {
  let units = 0
  for (const ch of String(text)) {
    units += /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : 0.55
  }
  return Math.ceil(units * fontSize)
}

/**
 * 增量更新：只处理「新进入窗口」与「已离开窗口」的弹幕。
 *
 * 关键：**已挂载的项完全不动** —— 它们的 animation-delay/duration 保持原值，
 * CSS 动画连续推进，不会因为 timeupdate 而重置。
 */
function update() {
  if (!props.enabled || !props.list.length || !containerW.value) {
    if (mounted.value.length) {
      mounted.value = []
      mountedKeys = new Set()
      laneFreeAt = []
      fixedFreeAt = {}
    }
    return
  }
  const t = props.time
  const winStart = t - LAG
  const winEnd = t + SCROLL_SEC + LEAD

  // ---- 1. 卸载已离开窗口的 ----
  if (mounted.value.length) {
    const kept = []
    for (const m of mounted.value) {
      if (m.dmTime >= winStart && m.dmTime <= winEnd) kept.push(m)
      else mountedKeys.delete(m.key)
    }
    if (kept.length !== mounted.value.length) mounted.value = kept
  }

  // ---- 2. 挂载新进入窗口的 ----
  // 二分找窗口起点
  let lo = 0
  let hi = props.list.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (props.list[mid].time < winStart) lo = mid + 1
    else hi = mid
  }

  const added = []
  for (let i = lo; i < props.list.length; i++) {
    const d = props.list[i]
    if (d.time > winEnd) break
    const key = `${d.time}-${i}`
    if (mountedKeys.has(key)) continue

    const isScroll = d.mode === 1 || d.mode === 2 || d.mode === 3 || d.mode === 6
    const isTop = d.mode === 5
    const isBottom = d.mode === 4
    if (!isScroll && !isTop && !isBottom) continue

    /**
     * 合并：窗口内**内容相同**的弹幕归为一条，显示「内容 xN」。
     *
     * 只在滚动弹幕上做（顶部/底部本就少，合并意义不大）。
     * 合并后的文本会重新估宽，故轨道计算用的是合并后的宽度。
     */
    let text = d.text
    let mergeCount = 1
    if (props.merge && isScroll) {
      const win = props.mergeWindow
      // 向前看窗口内的相同内容（含自己）
      let n = 1
      for (let j = i + 1; j < props.list.length; j++) {
        const nx = props.list[j]
        if (nx.time - d.time > win) break
        if (nx.text === d.text && (nx.mode === d.mode || (nx.mode <= 3 && d.mode <= 3))) {
          n++
          // 标记为已消费，避免后续重复渲染
          mountedKeys.add(`${nx.time}-${j}`)
        }
      }
      if (n > 1) {
        mergeCount = n
        text = `${d.text} x${n}`
      }
    }

    const fontSize = Math.max(
      12,
      Math.round((d.size || 25) * props.fontScale * (containerW.value / 1000) * 0.62)
    )
    const textW = estimateWidth(text, fontSize)
    const speed = (containerW.value + textW) / SCROLL_SEC
    const duration = (containerW.value + textW) / speed

    /**
     * animation-delay：
     *   正值 = 该弹幕还没到，延迟这么久后启动（元素已在 DOM 里待命）
     *   负值 = 该弹幕已出现过，从动画中途接上（seek 场景）
     * 这个值**只在挂载时算一次**，之后不再改 —— 这是不跳的关键。
     */
    const delay = d.time - t

    let lane = -1
    if (isScroll) {
      /**
       * 滚动弹幕轨道分配：**每轨道下次可用时间**（贪心，避免逐一碰撞）。
       *
       * 公式参考 NipaPlay-Reload（lib/widgets/danmaku_container.dart）：
       *
       *     nextAvailable = time + D × (W + margin) / (S + W)
       *
       *   D      = 滚动总时长（本实现 SCROLL_SEC）
       *   W      = 本条弹幕文本宽度
       *   margin = 安全间距（屏宽的固定比例）
       *   S      = 容器宽度
       *
       * 含义：本条的**尾部**完全离开右边缘（并留出安全间距）所需的时间。
       * 原实现用 `textW / speed`（仅"完全进入屏幕"）—— 那时上一条的尾部
       * 还贴着右边缘，两条会挨得过近甚至视觉重叠。
       */
      const safetyMargin = containerW.value * SAFETY_RATIO
      const nextAvail = d.time + SCROLL_SEC * ((textW + safetyMargin) / (containerW.value + textW))
      for (let L = 0; L < laneCount.value; L++) {
        if ((laneFreeAt[L] ?? -Infinity) <= d.time) {
          laneFreeAt[L] = nextAvail
          lane = L
          break
        }
      }
      if (lane < 0) continue
    } else {
      for (let L = 0; L < Math.min(3, laneCount.value); L++) {
        const k = `${d.mode}-${L}`
        if ((fixedFreeAt[k] ?? -Infinity) <= d.time) {
          fixedFreeAt[k] = d.time + FIXED_SEC
          lane = L
          break
        }
      }
      if (lane < 0) continue
    }

    mountedKeys.add(key)
    added.push({
      key,
      dmTime: d.time,
      text,
      mergeCount,
      color: d.color || '#fff',
      fontSize,
      textW,
      isScroll,
      isTop,
      isBottom,
      lane,
      delay,
      duration
    })
  }

  if (added.length) mounted.value = [...mounted.value, ...added]
}

/**
 * 滚动弹幕的动画样式。
 *
 * 只在元素首次渲染时计算（配合 :key，Vue 不会重建已有元素）。
 * 位移用具体像素：CSS 的 translateX(100%) 相对**元素自身宽度**，
 * 而滚动需要「容器右边缘外 → 左边缘外」，距离 = 容器宽 + 文本宽。
 */
function scrollStyle(d) {
  return {
    '--dm-from': containerW.value + 'px',
    '--dm-to': -d.textW + 'px',
    animationDuration: d.duration + 's',
    animationDelay: d.delay + 's'
  }
}

/** 观察容器尺寸 */
let ro = null
onMounted(() => {
  const el = wrapRef.value?.parentElement || wrapRef.value
  if (!el) return
  const measure = () => {
    const r = el.getBoundingClientRect()
    containerW.value = Math.round(r.width)
    containerH.value = Math.round(r.height)
  }
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const before = containerW.value
      measure()
      // 尺寸变了：已挂载弹幕的滚动距离失效，整批重建（尺寸变化很少见）
      if (before !== containerW.value) {
        mounted.value = []
        mountedKeys = new Set()
        laneFreeAt = []
        fixedFreeAt = {}
        nextTick(update)
      }
    })
    ro.observe(el)
  }
  nextTick(update)
})

onBeforeUnmount(() => {
  try { ro?.disconnect() } catch { /* ignore */ }
})

// 时间推进：只做增量（已挂载项不动，故不会重置动画）
watch(() => props.time, update)
// 列表/开关/缩放/区域变化：整批重建
watch(
  () => [props.list, props.enabled, props.fontScale, props.displayArea, laneCount.value],
  () => {
    mounted.value = []
    mountedKeys = new Set()
    laneFreeAt = []
    fixedFreeAt = {}
    nextTick(update)
  }
)
</script>

<template>
  <div
    v-if="enabled"
    ref="wrapRef"
    class="dm-wrap"
    :class="{ paused: !playing }"
    :style="{ opacity }"
  >
    <div
      v-for="d in mounted"
      :key="d.key"
      v-memo="[d.key]"
      class="dm-item"
      :class="{ scroll: d.isScroll, top: d.isTop, bottom: d.isBottom }"
      :style="{
        color: d.color,
        fontSize: d.fontSize + 'px',
        ...(d.isScroll
          ? { top: d.lane * LANE_H + 4 + 'px', ...scrollStyle(d) }
          : {
              top: d.isTop ? d.lane * LANE_H + 8 + 'px' : 'auto',
              bottom: d.isBottom ? d.lane * LANE_H + 8 + 'px' : 'auto',
              animationDelay: d.delay + 's'
            })
      }"
    >
      {{ d.text }}
    </div>
  </div>
</template>

<style scoped>
/*
 * 弹幕层：铺满播放器，不接收鼠标事件（否则挡住视频点击/进度条）。
 * z-index 3 —— 视频之上、歌词（4）与控制条（5）之下。
 */
.dm-wrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 3;
  transition: opacity 0.2s var(--ease, ease);
}

/* 暂停时冻结所有弹幕动画（与 B 站行为一致） */
.dm-wrap.paused .dm-item {
  animation-play-state: paused;
}

.dm-item {
  position: absolute;
  left: 0;
  white-space: nowrap;
  font-weight: 600;
  line-height: 1.2;
  /* 描边保证任何画面下可读 */
  text-shadow: 1px 0 1px rgba(0, 0, 0, 0.85), 0 1px 1px rgba(0, 0, 0, 0.85),
    -1px 0 1px rgba(0, 0, 0, 0.85), 0 -1px 1px rgba(0, 0, 0, 0.85);
  will-change: transform;
}

/* 滚动弹幕：从容器右边缘外 → 左边缘外（起止值由 JS 按实际宽度给出） */
.dm-item.scroll {
  animation-name: dm-scroll;
  animation-timing-function: linear;
  animation-fill-mode: both;
  transform: translateX(var(--dm-from, 100vw));
}
@keyframes dm-scroll {
  from { transform: translateX(var(--dm-from, 100vw)); }
  to { transform: translateX(var(--dm-to, -100vw)); }
}

/* 顶部 / 底部：水平居中，停留数秒后淡出 */
.dm-item.top,
.dm-item.bottom {
  left: 50%;
  animation-name: dm-fixed;
  animation-duration: 5s;
  animation-timing-function: linear;
  animation-fill-mode: both;
}
@keyframes dm-fixed {
  0% { opacity: 0; transform: translateX(-50%) scale(0.96); }
  5% { opacity: 1; transform: translateX(-50%) scale(1); }
  90% { opacity: 1; transform: translateX(-50%) scale(1); }
  100% { opacity: 0; transform: translateX(-50%) scale(1); }
}
</style>
