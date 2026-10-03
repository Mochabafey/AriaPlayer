import { defineStore } from 'pinia'
import { ncm } from '../api'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: {
      downloadDir: '',
      quality: '320000',
      enableUnblock: true,
      enableFlac: true,
      volume: 0.8,
      // 静音是独立开关：volume 保留实际音量值（静音时不清零持久化值），
      // 这样重启后取消静音能恢复到静音前的音量
      muted: false,
      volumeBeforeMute: 0.8,
      // MV 画质偏好（0 = 自动选最高可用；否则为具体档位如 480/720/1080）
      mvQuality: 0,
      // B 站视频画质偏好（0 = 自动选最高可用；否则为 B 站画质 id 如 80=1080P）
      // 与 mvQuality 分开：两边的档位体系不同（网易云 r 值 vs B 站 qn id）
      biliQuality: 0,
      // B 站歌词偏好
      //   biliLyricSource: 'auto' | 'netease' | 'bili'  —— 歌词来源
      //     auto = 两源并行取，择优（行数多的更完整）
      //     netease = 只用网易云（通常带翻译，最完整）
      //     bili = 只用 B 站自带 CC 字幕（与视频天然同步）
      //   biliShowTrans: 是否显示翻译（与歌曲页的 showTranslation 分开，
      //     因为 MV 页用户更可能只想看原文或只想看译文）
      biliLyricSource: 'auto',
      biliShowTrans: true,
      /**
       * 歌词区域高斯模糊背景。
       * 视频画面花哨时（动画 MV、现场演出）纯文字容易看不清，
       * 在歌词块背后加一层背景模糊 + 轻微压暗可显著提升可读性。
       */
      biliLyricBlur: true,
      playMode: 'list',
      showTranslation: true,
      audioCacheLimitMB: 2048,
      lastConvertPath: '',
      musicSource: 'netease' // 默认音源: 'netease' | 'qq'
    },
    loaded: false
  }),
  getters: {
    qualityLabel: (s) => {
      const map = { '128000': '128k 标准', '320000': '320k 高品', lossless: 'FLAC 无损' }
      return map[s.settings.quality] || s.settings.quality
    }
  },
  actions: {
    async load() {
      if (this.loaded) return
      const s = await ncm.settingsGet()
      this.settings = { ...this.settings, ...s }
      this.loaded = true
    },
    async set(key, value) {
      this.settings[key] = value
      const s = await ncm.settingsSet(key, value)
      this.settings = { ...this.settings, ...s }
    },
    async pickDownloadDir() {
      const dir = await ncm.librarySelectFolder()
      if (dir) await this.set('downloadDir', dir)
      return dir
    }
  }
})
