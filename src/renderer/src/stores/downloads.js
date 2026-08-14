import { defineStore } from 'pinia'
import { ncm } from '../api'

export const useDownloadsStore = defineStore('downloads', {
  state: () => ({
    tasks: [],
    loaded: false
  }),
  actions: {
    async load() {
      this.tasks = (await ncm.downloadList()) || []
      this.loaded = true
    },
    async add(info) {
      const r = await ncm.downloadAdd(info)
      if (r.ok) await this.load()
      else if (r.message) alert(r.message) // duplicated / no-url 等明确提示
      return r
    },
    async cancel(id) {
      await ncm.downloadCancel(id)
      await this.load()
    },
    async retry(id) {
      await ncm.downloadRetry(id)
      await this.load()
    },
    async remove(id, opts) {
      await ncm.downloadRemove(id, opts)
      await this.load()
    },
    watch() {
      ncm.onDownloadProgress((t) => {
        const i = this.tasks.findIndex((x) => x.id === t.id)
        if (i >= 0) this.tasks[i] = t
        else this.tasks.unshift(t)
      })
      ncm.onDownloadDone((t) => {
        const i = this.tasks.findIndex((x) => x.id === t.id)
        if (i >= 0) this.tasks[i] = t
      })
    }
  }
})
