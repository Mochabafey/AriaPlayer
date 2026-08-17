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
