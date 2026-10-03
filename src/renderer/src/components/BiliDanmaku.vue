<script setup>
/**
 * BiliDanmaku.vue — 弹幕层
 *
 * 参照 B 站网页播放器的行为：
 *   - 三种类型：滚动（mode 1/2/3/6）、顶部（5）、底部（4）
 *   - 滚动弹幕分配**轨道**（lane），避免文字重叠
 *   - 用 CSS transform 动画驱动（JS 不参与逐帧计算），几十条同时跑也不卡
 *
 * 性能：弹幕总量可能上万条，**不能全量渲染**。按当前时间二分查找，
 * 只渲染窗口内的（通常 <60 条）；每条由 CSS 动画自己跑完。
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
  displayArea: { type: Number, default: 1 }
})

const wrapRef = ref(null)
const containerH = ref(0)
const containerW = ref(0)

/** 轨道高度（px）—— 与字号联动，B 站约 26px 基准 */
const LANE_H = 26
/** 滚动弹幕穿过一屏的基准时长（秒）—— B 站约 8~10 秒 */
const SCROLL_SEC = 9
/** 顶部/底部弹幕停留时长（秒） */
const FIXED_SEC = 5

/** 可用轨道数（按显示区域高度算） */
const laneCount = computed(() =>
  Math.max(1, Math.floor((containerH.value * props.displayArea) / LANE_H))
)

const active = ref([])

/**
 * 轨道占用记录：lane → 该轨道上一条弹幕的「尾部完全进入屏幕」的时间点。
 *
 * 为什么是这个时刻：滚动弹幕从右侧进入，若上一条的尾巴还没完全进来
 * 就放下一条，两条会重叠。上一条完全进入所需时间 = 文本宽 / 速度。
 */
let laneFreeAt = []
/** 顶部/底部占用的行：`mode-lane` → 释放时间 */
let fixedFreeAt = {}

/**
 * 重建活跃弹幕。
 *
 * 整批重建而非增量：seek 会跳跃式改变时间，增量逻辑在跳跃时容易残留
 * 幽灵弹幕；窗口内条目少（<60），整批重建开销可忽略。
 */
function rebuild() {
  if (!props.enabled || !props.list.length || !containerW.value) {
    active.value = []
    return
  }
  const t = props.time
  // 窗口：往前 1s（让刚过去的还能跑完动画），往后 9s（提前挂载，动画延迟启动）
  const winStart = t - 1
  const winEnd = t + SCROLL_SEC + 1

  // 二分查找窗口起点（list 按 time 升序）
  let lo = 0
  let hi = props.list.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (props.list[mid].time < winStart) lo = mid + 1
    else hi = mid
  }

  const out = []
  laneFreeAt = []
  fixedFreeAt = {}

  for (let i = lo; i < props.list.length; i++) {
    const d = props.list[i]
    if (d.time > winEnd) break

    const isScroll = d.mode === 1 || d.mode === 2 || d.mode === 3 || d.mode === 6
    const isTop = d.mode === 5
    const isBottom = d.mode === 4
    if (!isScroll && !isTop && !isBottom) continue

    // 相对当前时间的延迟（负数=已出现过，从动画中途接上）
    const delay = d.time - t
    if (delay < -1) continue

    // 字号：以 1000px 容器为基准缩放，保证不同窗口下观感一致
    const fontSize = Math.max(
      12,
      Math.round((d.size || 25) * props.fontScale * (containerW.value / 1000) * 0.62)
    )
    const textW = estimateWidth(d.text, fontSize)
    // 速度按容器宽度缩放：宽容器跑得快，保持「约 9 秒穿屏」
    const speed = (containerW.value + textW) / SCROLL_SEC

    let lane = -1
    if (isScroll) {
      // 该弹幕实际开始进入屏幕的时刻（延迟为负时就是当前时间）
      const enterAt = Math.max(t, d.time)
      for (let L = 0; L < laneCount.value; L++) {
        if ((laneFreeAt[L] ?? -Infinity) <= enterAt) {
          // 占用到「本条完全进入屏幕」为止
          laneFreeAt[L] = enterAt + textW / speed
          lane = L
          break
        }
      }
      if (lane < 0) continue // 无空轨道，丢弃（避免堆叠）
    } else {
      // 顶部/底部：占用一行 FIXED_SEC 秒（最多 3 行）
      const enterAt = Math.max(t, d.time)
      for (let L = 0; L < Math.min(3, laneCount.value); L++) {
        const k = `${d.mode}-${L}`
        if ((fixedFreeAt[k] ?? -Infinity) <= enterAt) {
          fixedFreeAt[k] = enterAt + FIXED_SEC
          lane = L
          break
        }
      }
      if (lane < 0) continue
    }

    out.push({
      key: `${d.time}-${i}`,
      text: d.text,
      color: d.color || '#fff',
      fontSize,
      textW,
      isScroll,
      isTop,
      isBottom,
      lane,
      delay,
      duration: (containerW.value + textW) / speed
    })
  }
  active.value = out
}

/** 估算文本宽度（中文/日文/全角按 1em，其余按 0.55em） */
function estimateWidth(text, fontSize) {
  let units = 0
  for (const ch of String(text)) {
    units += /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : 0.55
  }
  return Math.ceil(units * fontSize)
}

/**
 * 滚动动画的起止位移（px）。
 *
 * 用具体像素而非百分比：CSS 的 translateX(100%) 是相对**元素自身宽度**，
 * 而滚动弹幕需要「从容器右边缘外 → 左边缘外」，距离取决于容器宽 + 文本宽。
 */
function scrollStyle(d) {
  const fromX = containerW.value
  const toX = -d.textW
  return {
    // 用 CSS 变量把起止位置传给 keyframes（keyframes 里不能读 JS 变量）
    '--dm-from': fromX + 'px',
    '--dm-to': toX + 'px',
    animationDuration: d.duration + 's',
    animationDelay: d.delay + 's'
  }
}

/** 观察容器尺寸（轨道数、字号、滚动距离都依赖它） */
let ro = null
onMounted(() => {
  const el = wrapRef.value?.parentElement || wrapRef.value
  if (!el) return
  const update = () => {
    const r = el.getBoundingClientRect()
    containerW.value = Math.round(r.width)
    containerH.value = Math.round(r.height)
    nextTick(rebuild)
  }
  update()
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(update)
    ro.observe(el)
  }
})

onBeforeUnmount(() => {
  try { ro?.disconnect() } catch { /* ignore */ }
})

watch(() => props.time, () => rebuild())
watch(
  () => [props.list, props.enabled, props.fontScale, props.displayArea, laneCount.value],
  () => nextTick(rebuild)
)
</script>

<template>
  <div
    v-if="enabled"
    ref="wrapRef"
    class="dm-wrap"
    :style="{ opacity, '--dm-lane-h': LANE_H + 'px' }"
  >
    <div
      v-for="d in active"
      :key="d.key"
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
 * 弹幕层：铺满播放器，但不接收鼠标事件（否则挡住视频点击/进度条）。
 * z-index 3 —— 在视频之上、歌词（4）与控制条（5）之下。
 */
.dm-wrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 3;
  transition: opacity 0.2s var(--ease, ease);
}

.dm-item {
  position: absolute;
  left: 0;
  white-space: nowrap;
  font-weight: 600;
  line-height: 1.2;
  /* 描边保证任何画面下可读（B 站同款做法） */
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
  margin-left: 0;
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
