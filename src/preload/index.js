import { contextBridge, ipcRenderer } from 'electron'

/**
 * 白名单式 IPC 桥：
 * window.ncm.invoke(channel, ...args)  — 主进程 invoke 调用
 * window.ncm.on(channel, cb)           — 订阅主进程事件，返回取消订阅函数
 */
const api = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('ncm', api)
