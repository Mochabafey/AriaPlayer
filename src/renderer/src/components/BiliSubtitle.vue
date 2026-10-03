<script setup>
/**
 * BiliSubtitle.vue — 三行字幕式歌词（叠在视频画面上）
 *
 * 显示形态（参照歌词页的滚动效果，但只保留三行）：
 *   ┌──────────────────────────┐
 *   │      下一句（等待播放）    │  暗淡
 *   │    ● 当前句（正在播放）    │  高亮 + 放大
 *   │      上一句（已播放完）    │  暗淡
 *   └──────────────────────────┘
 *
 * 与歌曲歌词页（LyricPanel）的区别：
 *   - 只显示三行，不做整列表滚动（MV 画面为主，不遮挡）
 *   - 叠在视频上、进度条上方，不占布局
 *   - 数据源可以是 B 站自带字幕或网易云歌词（父组件统一转成同结构）
 *
 * 切换用 CSS 过渡而非重排列表，避免每句歌词都触发 DOM 增删。
 */
import { computed } from 'vue'

const props = defineProps({
  /** 歌词行 [{ time, text, trans? }]，按时间升序 */
  lines: { type: Array, default: () => [] },
  /** 当前播放时间（秒） */
  time: { type: Number, default: 0 },
  /** 是否显示翻译 */
  showTrans: { type: Boolean, default: true },
  /** 数据来源标签（如「网易云 · 波西米亚狂想曲」/「B站字幕」） */
  sourceLabel: { type: String, default: '' },
  /** 当前行索引（由父组件算好传入，避免重复计算） */
  activeIndex: { type: Number, default: -1 }
})

const active = computed(() => props.activeIndex)

/** 上一句 / 当前句 / 下一句 */
const prevLine = computed(() => (active.value > 0 ? props.lines[active.value - 1] : null))
const curLine = computed(() => (active.value >= 0 ? props.lines[active.value] : null))
const nextLine = computed(() =>
  active.value >= 0 && active.value + 1 < props.lines.length ? props.lines[active.value + 1] : null
)

/** 前奏阶段（还没到第一句）：把第一句当作「下一句」预告 */
const introLine = computed(() => (active.value < 0 && props.lines.length ? props.lines[0] : null))

const hasContent = computed(() => props.lines.length > 0)
</script>

<template>
  <div v-if="hasContent" class="bs-wrap">
    <!-- 来源标签：让用户知道歌词是哪来的，匹配错了也便于察觉 -->
    <div v-if="sourceLabel" class="bs-source">{{ sourceLabel }}</div>

    <div class="bs-lines">
      <!-- 前奏：还没到第一句时预告首句 -->
      <div v-if="introLine && active < 0" class="bs-line dim">{{ introLine.text }}</div>
      <!-- 上一句（已播放完） -->
      <div v-else class="bs-line dim" :class="{ empty: !prevLine }">
        {{ prevLine?.text || '' }}
      </div>

      <!-- 当前句（正在播放）：高亮 + 放大 -->
      <div class="bs-line cur" :class="{ empty: !curLine }">
        <span class="bs-text">{{ curLine?.text || '' }}</span>
        <span v-if="showTrans && curLine?.trans" class="bs-trans">{{ curLine.trans }}</span>
      </div>

      <!-- 下一句（等待播放） -->
      <div class="bs-line dim" :class="{ empty: !nextLine }">
        {{ nextLine?.text || '' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.bs-wrap {
  position: absolute;
  left: 0;
  right: 0;
  /* 位于进度条上方：进度条在 bottom 0~46px 区间，字幕贴其上方 */
  bottom: 62px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none; /* 不挡视频点击 */
  padding: 0 8%;
  box-sizing: border-box;
}

.bs-source {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.42);
  background: rgba(0, 0, 0, 0.32);
  padding: 2px 8px;
  border-radius: 8px;
  backdrop-filter: blur(4px);
  max-width: 70%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bs-lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.bs-line {
  max-width: 100%;
  text-align: center;
  line-height: 1.4;
  transition: color 0.25s var(--ease, ease), opacity 0.25s var(--ease, ease),
    transform 0.25s var(--ease, ease), font-size 0.25s var(--ease, ease);
}

/* 上下两行：暗淡、略小 */
.bs-line.dim {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.45);
  opacity: 0.85;
  /* 单行截断，避免长句把布局撑开 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
}
.bs-line.dim.empty { opacity: 0; }

/* 中间行：高亮放大 + 描边保证任何画面下可读 */
.bs-line.cur {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 19px;
  font-weight: 700;
  color: #fff;
  transform: scale(1.02);
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 0.9);
}
.bs-line.cur.empty { opacity: 0; }
.bs-text {
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bs-trans {
  font-size: 12.5px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 大窗口适度放大 */
@media (min-height: 900px) {
  .bs-line.dim { font-size: 15px; }
  .bs-line.cur { font-size: 21px; }
  .bs-trans { font-size: 13.5px; }
}
</style>
