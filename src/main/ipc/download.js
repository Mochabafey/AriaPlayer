import { ipcMain } from 'electron'
import { DownloadManager } from '../downloadManager.js'

export function registerDownloadIpc(getWindow) {
  const dm = new DownloadManager(getWindow)
  dm.init()

  ipcMain.handle('ncm:download-add', (_e, info) => dm.add(info))
  ipcMain.handle('ncm:download-list', () => dm.list())
  ipcMain.handle('ncm:download-cancel', (_e, id) => dm.cancel(id))
  ipcMain.handle('ncm:download-retry', (_e, id) => dm.retry(id))
  ipcMain.handle('ncm:download-remove', (_e, id, opts) => dm.remove(id, opts))

  return dm
}
