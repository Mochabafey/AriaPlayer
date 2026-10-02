import { defineStore } from 'pinia'
import { ncm } from '../api'
import { toast } from '../utils/toast'

export const useDownloadsStore = defineStore('downloads', {
  state: () => ({
    tasks: [],
    loaded: false,
    /** 已完成但还没提示过的任务 id（用于「下载完成」toast 去重，见 watch()） */
    notifiedDone: new Set()
  }),
  getters: {
    /** 进行中的任务（pending + downloading） */
    activeTasks: (s) => s.tasks.filter((t) => t.status === 'pending' || t.status === 'downloading'),
    /** 进行中任务数：侧边栏角标用 */
    activeCount() {
      return this.activeTasks.length
    },
    /** 失败/暂停的任务数 */
    failedCount: (s) => s.tasks.filter((t) => t.status === 'failed' || t.status === 'paused').length,
    /**
     * 总进度（0..1）：按各任务字节数加权，而非任务数平均——
     * 否则一个 5MB 的小文件和一个 50MB 的大文件各占 50%，进度会失真。
     */
    overallProgress(s) {
      const act = s.tasks.filter((t) => t.status === 'pending' || t.status === 'downloading')
      if (!act.length) return 0
      let recv = 0
      let total = 0
      for (const t of act) {
        recv += t.received || 0
        // total 未知（0）时用 received 兜底，避免整体进度恒为 0
        total += t.total || t.received || 1
      }
      return total > 0 ? Math.min(1, recv / total) : 0
    }
  },
  actions: {
    async load() {
      this.tasks = (await ncm.downloadList()) || []
      this.loaded = true
    },
    /**
     * 加入下载队列。
     * 关键：成功也要给反馈——原实现只在失败时 toast，
     * 成功路径完全静默，用户点完不知道有没有生效（"不知道下没下"）。
     */
    async add(info) {
      const r = await ncm.downloadAdd(info)
      if (r.ok) {
        await this.load()
        // resumed：命中了同 songId 的未完成任务，走的是断点续传而非新建
        if (r.resumed) toast(`继续下载：${info?.title || '歌曲'}`, 'success')
        else toast(`已加入下载队列：${info?.title || '歌曲'}`, 'success')
      } else if (r.reason === 'duplicated') {
        toast(r.message || '该歌曲已在下载列表中', 'info')
      } else {
        toast(r.message || '加入下载失败', 'error')
      }
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
        else this.tasks.unshift(t)
        // 完成提示：每个任务只提示一次。
        // 主进程的 download-done 只发一次，但为防重复事件（重试/重连）导致刷屏，
        // 用 id 集合去重。
        if (t.status === 'done' && !this.notifiedDone.has(t.id)) {
          this.notifiedDone.add(t.id)
          toast(`下载完成：${t.title || '歌曲'}`, 'success')
        }
      })
    }
  }
})
