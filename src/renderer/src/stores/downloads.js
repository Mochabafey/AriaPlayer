import { defineStore } from 'pinia'
import { ncm } from '../api'
import { toast } from '../utils/toast'

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
      else if (r.message) toast(r.message, 'error') // duplicated / no-url 等明确提示
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
    /** 批量清空已完成任务（保留文件） */
    async clearCompleted() {
      await Promise.all(
        this.tasks.filter((t) => t.status === 'done').map((t) => ncm.downloadRemove(t.id, { deleteFile: false }))
      )
      await this.load()
    },
    /** 批量重试失败/暂停的任务 */
    async retryFailed() {
      await Promise.all(
        this.tasks.filter((t) => t.status === 'failed' || t.status === 'paused').map((t) => ncm.downloadRetry(t.id))
      )
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
