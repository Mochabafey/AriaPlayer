import { defineStore } from 'pinia'
import { ncm } from '../api'

export const useLibraryStore = defineStore('library', {
  state: () => ({
    songs: [],
    folders: [],
    loaded: false,
    scanning: false
  }),
  getters: {
    byId: (s) => (id) => s.songs.find((x) => x.id === id)
  },
  actions: {
    async load() {
      const [songs, folders] = await Promise.all([ncm.libraryList(), ncm.libraryFolders()])
      this.songs = songs || []
      this.folders = folders || []
      this.loaded = true
    },
    async scan() {
      this.scanning = true
      try {
        await ncm.libraryScan()
        await this.load()
      } finally {
        this.scanning = false
      }
    },
    async addFolder(dir) {
      await ncm.libraryAddFolder(dir)
      await this.load()
    },
    /** 移除监控文件夹（不删已入库的歌曲记录） */
    async removeFolder(dir) {
      await ncm.libraryRemoveFolder(dir)
      await this.load()
    },
    async edit(id, fields) {
      const r = await ncm.libraryEdit(id, fields)
      await this.load()
      return r
    },
    async remove(id, opts) {
      await ncm.libraryRemove(id, opts)
      await this.load()
    }
  }
})
