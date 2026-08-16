import { contextBridge, ipcRenderer } from 'electron'

/**
 * 白名单式 IPC 桥（invoke + on 双向都收敛到显式通道列表）：
 * 渲染进程被攻破时也无法触达白名单外的任意主进程 handler，
 * 配合 sandbox: true 隔离 Node 能力。
 * 新增 IPC 通道时必须同步登记到这里。
 */
const INVOKE_ALLOWLIST = new Set([
  // 窗口控制（自定义标题栏）
  'win:minimize',
  'win:toggle-maximize',
  'win:close',
  'win:is-maximized',
  // 通用 API / 设置 / 系统对话框
  'ncm:api',
  'ncm:resolve-link',
  'ncm:server-status',
  'ncm:server-restart',
  'ncm:ffmpeg-version',
  'ncm:ffmpeg-transcode',
  'ncm:save-dialog',
  'ncm:open-folder',
  'ncm:select-folder',
  'ncm:settings-get',
  'ncm:settings-set',
  'ncm:cache-stats',
  'ncm:cache-clear',
  // 本地曲库
  'ncm:library-list',
  'ncm:library-folders',
  'ncm:library-add-folder',
  'ncm:library-scan',
  'ncm:library-edit',
  'ncm:library-remove',
  'ncm:library-export',
  'ncm:library-import',
  // 歌单
  'ncm:playlist-list',
  'ncm:playlist-save',
  'ncm:playlist-remove',
  'ncm:playlist-export-m3u',
  'ncm:playlist-import-m3u',
  // NCM 转换
  'ncm:convert-pick-file',
  'ncm:convert-pick-dir',
  'ncm:convert-batch',
  // 下载
  'ncm:download-add',
  'ncm:download-list',
  'ncm:download-cancel',
  'ncm:download-retry',
  'ncm:download-remove'
])

const EVENT_ALLOWLIST = new Set([
  'win:maximized',
  'ncm:server-status',
  'ncm:library-updated',
  'ncm:convert-progress',
  'ncm:download-progress',
  'ncm:download-done'
])

const api = {
  invoke: (channel, ...args) => {
    if (!INVOKE_ALLOWLIST.has(channel)) {
      return Promise.reject(new Error(`ipc channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, cb) => {
    if (!EVENT_ALLOWLIST.has(channel)) {
      throw new Error(`ipc event not allowed: ${channel}`)
    }
    const listener = (_e, data) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('ncm', api)
