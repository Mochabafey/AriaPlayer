import { defineStore } from 'pinia'
import { ncm } from '../api'

/**
 * 本地歌单 store。
 *
 * ## 为什么详情要单独缓存（detailMap）
 *
 * 歌单列表只含元信息（名称/曲目数/封面），而渲染歌单内容需要把 songIds
 * 解析成完整曲目 —— 这一步在主进程做（要查曲库、要读快照）。
 * 若每次切换歌单都请求，来回切会有明显空窗；故按 id 缓存，
 * 并在任何写操作后**只失效被改动的那一个**（不是全清），
 * 避免「改 A 歌单导致 B 歌单重新拉取」的闪烁。
 */
export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    list: [],
    /** id → { playlist, songs, missing } */
    detailMap: {},
    loaded: false,
    loading: false
  }),

  getters: {
    /** 本地歌单（引用曲库） */
    localList: (s) => s.list.filter((p) => p.source === 'local' || p.source === 'm3u'),
    /** 在线导入歌单（快照） */
    onlineList: (s) => s.list.filter((p) => p.source === 'netease' || p.source === 'qq'),
    byId: (s) => (id) => s.list.find((p) => p.id === id) || null,
    /** 曲目数：快照型看 tracks 长度，本地型看 songIds 长度 */
    countOf: () => (p) => {
      if (!p) return 0
      if (Array.isArray(p.tracks)) return p.tracks.length
      return Array.isArray(p.songIds) ? p.songIds.length : 0
    },
    detail: (s) => (id) => s.detailMap[id] || null
  },

  actions: {
    async load() {
      this.loading = true
      try {
        this.list = (await ncm.playlistList()) || []
        this.loaded = true
      } finally {
        this.loading = false
      }
    },

    /** 拉取（或取缓存）歌单详情 */
    async fetchDetail(id, { force = false } = {}) {
      if (!id) return null
      if (!force && this.detailMap[id]) return this.detailMap[id]
      const d = await ncm.playlistDetail(id)
      if (d) this.detailMap[id] = d
      return d
    },

    /** 只失效指定歌单的缓存（写操作后用） */
    invalidate(id) {
      if (id) delete this.detailMap[id]
    },

    invalidateAll() {
      this.detailMap = {}
    },

    async create(name, songIds = []) {
      const p = await ncm.playlistCreate({ name, songIds })
      await this.load()
      return p
    },

    async rename(id, name) {
      const p = await ncm.playlistRename({ id, name })
      await this.load()
      this.invalidate(id)
      return p
    },

    async remove(id) {
      await ncm.playlistRemove(id)
      this.invalidate(id)
      await this.load()
    },

    async addSongs(id, songIds) {
      const r = await ncm.playlistAddSongs({ id, songIds })
      this.invalidate(id)
      await this.load()
      return r
    },

    async removeSongs(id, songIds) {
      const r = await ncm.playlistRemoveSongs({ id, songIds })
      this.invalidate(id)
      await this.load()
      return r
    },

    async reorder(id, orderedIds) {
      await ncm.playlistReorder({ id, orderedIds })
      this.invalidate(id)
    },

    async importNetease(id, name) {
      const r = await ncm.playlistImportNetease({ id, name })
      if (r?.ok) await this.load()
      return r
    },

    async importFile(targetPlaylistId) {
      const r = await ncm.playlistImportFile({ targetPlaylistId })
      if (r?.ok) {
        this.invalidateAll()
        await this.load()
      }
      return r
    }
  }
})
