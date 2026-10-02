/**
 * 音量曲线：滑块位置 → 实际振幅的映射。
 *
 * ## 为什么需要曲线
 *
 * 直接把滑块值当振幅设给 `el.volume` 会让「前段太陡」：
 * 人耳对响度的感知是**对数**的（感知响度 ∝ 20·log10(振幅)），
 * 而线性振幅下 0.5 只有 -6dB —— 所以「调一半感觉没小多少」，
 * 而低段（0.05~0.2）反而变化剧烈。
 *
 * 实测反馈：本应用滑块 13% 比网易云 21% 还响。原因是两者振幅相差约 26 倍：
 *   网易云 21% → 振幅约 0.013
 *   线性实现 13% → 振幅 0.13
 * 主流播放器（网易云 / Spotify / Apple Music）都把滑块映射到指数曲线，
 * 让「滑块走一半 ≈ 感知音量减半」。
 *
 * ## 曲线选择
 *
 * 用三次方 `amp = slider³`：
 *   滑块 13% → 振幅 0.0022
 *   滑块 21% → 振幅 0.0093
 *   滑块 50% → 振幅 0.125
 *   滑块 100% → 振幅 1.0
 * 低音量段足够细腻（适合夜间），手感接近网易云。
 *
 * ## 设计约定
 *
 * 全应用状态与 UI 一律保存/显示**滑块位置**（0..1），
 * 只在最后一步设置媒体元素时调用本函数换算成振幅。
 * 这样设置持久化格式不变（0.8 仍是 80% 位置），UI 显示也符合直觉。
 */

/** 曲线指数：3 = 三次方 */
const EXPONENT = 3

/**
 * 滑块位置（0..1）→ 实际振幅（0..1）。
 * @param {number} slider 滑块位置
 * @returns {number} 应设置给 el.volume 的振幅
 */
export function ampOf(slider) {
  const s = Number(slider)
  if (!Number.isFinite(s) || s <= 0) return 0
  if (s >= 1) return 1
  return Math.pow(s, EXPONENT)
}

/**
 * 实际振幅 → 滑块位置（ampOf 的反函数）。
 * 用于从外部读到的振幅反推滑块位置（如接管已存在的媒体元素时）。
 */
export function sliderOf(amp) {
  const a = Number(amp)
  if (!Number.isFinite(a) || a <= 0) return 0
  if (a >= 1) return 1
  return Math.pow(a, 1 / EXPONENT)
}
