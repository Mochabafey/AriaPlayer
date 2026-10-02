import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'

/**
 * 音量条交互（PlayerBar 与 LyricPanel 共用一套）。
 *
 * 抽出原因：原先两个组件各写一份几乎相同的音量逻辑，导致
 *   - 静音状态互不同步（PlayerBar 静音后 LyricPanel 仍显示有声）
 *   - 沉浸页缺 hover 百分比提示
 *   - 拖动反馈的 bug 只在一侧、且都不生效（见下）
 *
 * 精准度：把「按像素取比例」升级为
 *   - 亚像素定位（getBoundingClientRect 已足够，不做取整）
 *   - 拖拽时按下标吸附到 1% 整数，避免 34.9999% 这类抖动显示
 *   - 滚轮按 5% 步进微调
 *   - hover 气泡显示整数百分比
 */

/** 音量变化步进（滚轮 / 键盘） */
const STEP = 0.05
/** 拖拽时吸附精度：1%（100 档），比默认连续值更可控 */
const SNAP = 100

export function useVolumeSlider() {
  const player = usePlayerStore()
  const settings = useSettingsStore()

  const trackRef = ref(null)
  const dragging = ref(false)
  const hoverRatio = ref(-1)
  const muted = ref(false)
  /** 静音前的音量，取消静音时恢复 */
  let mutedVolume = 0.8

  /** 显示百分比：静音恒为 0 */
  const volumeDisplay = computed(() => (muted.value ? 0 : Math.round(player.volume * 100)))

  /** 从指针事件取 0..1 比例（不吸附，供 hover 气泡实时跟随） */
  function ratioFromEvent(el, e) {
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (!rect.width) return 0
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  }

  /** 吸附到 1% 整数档，避免拖动时显示 33.9999% 之类的抖动 */
  function snap(v) {
    return Math.round(v * SNAP) / SNAP
  }

  function applyFromEvent(e, doSnap = true) {
    const r = ratioFromEvent(trackRef.value, e)
    player.setVolume(doSnap ? snap(r) : r)
  }

  /* ---- 点击 + 拖拽 ---- */
  function onDown(e) {
    dragging.value = true
    applyFromEvent(e)
    // 拖动期间监听 window：指针移出音量条也不断（体验关键）
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  function onMove(e) {
    if (dragging.value) applyFromEvent(e)
  }
  function onUp() {
    dragging.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }

  /* ---- hover 百分比提示 ---- */
  function onHover(e) {
    hoverRatio.value = ratioFromEvent(trackRef.value, e)
  }
  function onLeave() {
    hoverRatio.value = -1
  }

  /* ---- 滚轮微调：向上 +5%，向下 -5% ---- */
  function onWheel(e) {
    // 阻止页面滚动（音量条上的滚轮只用于调音量）
    e.preventDefault()
    const delta = e.deltaY > 0 ? -STEP : STEP
    const next = Math.min(1, Math.max(0, snap(player.volume + delta)))
    player.setVolume(next)
    // 滚轮时同步更新气泡，让用户看到当前值
    hoverRatio.value = next
  }

  /* ---- 静音切换 ---- */
  function toggleMute() {
    if (muted.value) {
      player.setVolume(mutedVolume || 0.8)
      muted.value = false
    } else {
      mutedVolume = player.volume
      player.setVolume(0)
      muted.value = true
    }
  }

  /** 音量被调到非 0（拖拽/滚轮/快捷键）时自动解除静音 */
  watch(
    () => player.volume,
    (v) => {
      if (v > 0 && muted.value) muted.value = false
    }
  )

  /** 恢复上次的静音状态（音量值由 settings 持久化，静音是独立开关） */
  const savedMuted = settings.settings.muted
  if (savedMuted) {
    muted.value = true
    mutedVolume = Number(settings.settings.volumeBeforeMute) || 0.8
  }
  watch(muted, (m) => {
    settings.set('muted', m)
    if (m) settings.set('volumeBeforeMute', mutedVolume)
  })

  onBeforeUnmount(() => {
    // 组件卸载时摘掉 window 监听，避免残留（拖动中切页会泄漏）
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  })

  return {
    trackRef,
    dragging,
    hoverRatio,
    muted,
    volumeDisplay,
    onDown,
    onHover,
    onLeave,
    onWheel,
    toggleMute
  }
}
