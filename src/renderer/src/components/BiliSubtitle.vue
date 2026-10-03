<script setup>
/**
 * BiliSubtitle.vue — MV 播放页歌词（滚动 + 三行聚焦窗口）
 *
 * ## 显示形态
 *
 * 复用歌曲歌词页（LyricPanel）的滚动观感：
 *   - 歌词列表**整体滚动**，当前句居中（上=已播放完 / 中=正在播放 / 下=等待播放）
 *   - rAF 自定义缓动（easeOutCubic 460ms），连续切行观感连续
 *   - 用户手动翻动后暂停自动跟滚 2.6s，不抢滚动条
 *   - 点击某行可 seek 到该句
 *   - **窗口缩放时立即重新对齐**当前行（无动画直跳），避免字号变化后错位
 *
 * 与 LyricPanel 的区别：
 *   - 容器是**三行高的窄窗口**（不是整屏），叠在视频上，不遮挡画面主体
 *   - 上下行用遮罩渐隐（而非整屏模糊背景），保证视频可见
 *   - 数据源可以是 B 站自带字幕或网易云歌词（父组件统一成同结构）
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  /** 歌词行 [{ time, text, trans? }]，按时间升序 */
  lines: { type: Array, default: () => [] },
  /** 当前播放时间（秒） */
  time: { type: Number, default: 0 },
  /** 是否显示翻译 */
  showTrans: { type: Boolean, default: true },
  /** 当前行索引（由父组件算好传入） */
  activeIndex: { type: Number, default: -1 },
  /**
   * 控制条是否可见。
   * 控制条隐藏时歌词整体**下移**贴近底部（与歌曲歌词页一致）——
   * 否则控制条消失后歌词会悬在半空，下方留一大片空白。
   */
  controlsVisible: { type: Boolean, default: true }
})

const emit = defineEmits(['seek'])

const listRef = ref(null)

/* ================= 滚动：rAF 自定义缓动 =================
 * 与 LyricPanel 同一套算法，保证两处观感一致。
 */
let scrollRaf = 0
let userScrollUntil = 0

function centerLine(idx, animate = true) {
  const list = listRef.value
  if (!list) return
  const el = list.querySelector(`[data-idx="${idx}"]`)
  if (!el) return
  const rect = list.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const target = list.scrollTop + (elRect.top - rect.top) - (rect.height - elRect.height) / 2
  const clamped = Math.max(0, Math.min(target, list.scrollHeight - list.clientHeight))
  if (!animate) {
    list.scrollTop = clamped
    return
  }
  if (performance.now() < userScrollUntil) return
  cancelAnimationFrame(scrollRaf)
  const from = list.scrollTop
  if (Math.abs(clamped - from) < 1) return
  const start = performance.now()
  const dur = 460
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur)
    const e = 1 - (1 - t) ** 3 // easeOutCubic
    list.scrollTop = from + (clamped - from) * e
    if (t < 1) scrollRaf = requestAnimationFrame(step)
  }
  scrollRaf = requestAnimationFrame(step)
}

/** 用户滚轮翻动：中止动画并暂停自动跟滚 */
function onUserScroll() {
  cancelAnimationFrame(scrollRaf)
  userScrollUntil = performance.now() + 2600
}

/** 点击歌词行：seek 到该句（点击即表示要跟着这句走） */
function onLineClick(line) {
  userScrollUntil = 0
  emit('seek', line.time)
}

/**
 * 窗口缩放：媒体查询改字号 → 行高变化 → 立即重新对齐（无动画）。
 * 这是「自适应跟随窗口放大缩小」的关键：不做这一步，缩放后当前行会偏离中心。
 */
function onResize() {
  cancelAnimationFrame(scrollRaf)
  if (props.activeIndex >= 0) centerLine(props.activeIndex, false)
}

watch(
  () => props.activeIndex,
  (idx) => {
    if (idx >= 0) centerLine(idx)
  }
)

// 歌词数组被替换（切歌/换源）：主动滚回当前行，避免停在上一首的位置
watch(
  () => props.lines,
  async () => {
    await nextTick()
    if (!listRef.value) return
    if (props.activeIndex >= 0) centerLine(props.activeIndex, false)
    else listRef.value.scrollTop = 0
  }
)

onMounted(() => {
  window.addEventListener('resize', onResize)
  nextTick(() => {
    if (props.activeIndex >= 0) centerLine(props.activeIndex, false)
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  cancelAnimationFrame(scrollRaf)
})

const hasContent = computed(() => props.lines.length > 0)
</script>

<template>
  <div v-if="hasContent" class="bs-wrap" :class="{ down: !controlsVisible }">
    <div
      ref="listRef"
      class="bs-list"
      @wheel.passive="onUserScroll"
      @touchmove.passive="onUserScroll"
    >
      <!-- 顶部/底部留白：让首末句也能滚到中间 -->
      <div class="bs-pad"></div>
      <p
        v-for="(line, i) in lines"
        :key="i"
        :data-idx="i"
        class="bs-line"
        :class="{ cur: i === activeIndex }"
        :title="'跳转到此句'"
        @click="onLineClick(line)"
      >
        {{ line.text }}
        <span v-if="showTrans && line.trans" class="bs-trans">{{ line.trans }}</span>
      </p>
      <div class="bs-pad"></div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 三行高的窄窗口：
 *   --bs-font 随窗口自适应，行高由字号推导 → 窗口放大时歌词跟着变大
 *
 * 位置随控制条显隐变化（与歌曲歌词页一致的「下沉」行为）：
 *   控制条可见 → bottom 96px（避让进度条 + 按钮行）
 *   控制条隐藏 → bottom 24px（贴近底部，不留悬空）
 */
.bs-wrap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 96px;
  z-index: 4;
  display: flex;
  justify-content: center;
  pointer-events: none; /* 容器不挡视频点击，只有歌词行可点 */
  padding: 0 8%;
  box-sizing: border-box;
  transition: bottom 0.22s var(--ease, ease);
}
/* 控制条隐藏：歌词整体下移贴近底部 */
.bs-wrap.down { bottom: 24px; }

.bs-list {
  --bs-font: clamp(15px, 1.5vw, 21px);
  --bs-line-h: calc(var(--bs-font) * 2.1);
  position: relative;
  width: min(100%, 900px);
  /* 三行窗口：高度正好容纳 3 行 */
  height: calc(var(--bs-line-h) * 3);
  overflow-y: auto;
  scrollbar-width: none;
  pointer-events: auto;
  /* 上下渐隐：超出三行的内容淡出，形成「聚焦中间」的观感 */
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 22%,
    #000 78%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    #000 22%,
    #000 78%,
    transparent 100%
  );
}
.bs-list::-webkit-scrollbar { display: none; }

/* 首末留白：让第一句/最后一句也能滚到窗口中间 */
.bs-pad { height: var(--bs-line-h); }

.bs-line {
  min-height: var(--bs-line-h);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 0 6px;
  box-sizing: border-box;
  text-align: center;
  font-size: var(--bs-font);
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.42);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
  cursor: pointer;
  transition: color 0.25s var(--ease, ease), transform 0.25s var(--ease, ease);
  /* 长句单行截断，避免行高不齐导致滚动位置跳变 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bs-line:hover { color: rgba(255, 255, 255, 0.72); }

/* 当前行：高亮 + 轻微放大 */
.bs-line.cur {
  color: #fff;
  font-weight: 700;
  transform: scale(1.06);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.95);
}

.bs-trans {
  font-size: 0.68em;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.bs-line.cur .bs-trans { color: rgba(255, 255, 255, 0.88); }

/* 大窗口适度放大字号（窗口放大 → 歌词跟着变大） */
@media (min-width: 1400px) {
  .bs-list { --bs-font: clamp(17px, 1.35vw, 24px); }
}
@media (min-height: 900px) {
  .bs-list { --bs-font: clamp(16px, 1.5vw, 23px); }
}
</style>
