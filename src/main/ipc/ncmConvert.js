import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { decryptNcmFile, collectNcmFiles } from '../ncm/ncmDecrypt.mjs'

/**
 * .ncm 批量转换 IPC：
 *   ncm:convert-pick-dir   选目录
 *   ncm:convert-batch      批量转换（递归扫描 .ncm → 解密 → mp3/flac + 封面 + mp3 标签）
 *   事件 ncm:convert-progress
 */
export function registerNcmConvertIpc(getWindow) {
  let converting = false

  const send = (payload) => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('ncm:convert-progress', payload)
  }

  ipcMain.handle('ncm:convert-pick-dir', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择包含 .ncm 文件的目录',
      properties: ['openDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('ncm:convert-batch', async (_e, { dir, recursive = true, outputDir = null } = {}) => {
    if (converting) return { ok: false, error: '已有转换任务进行中' }
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在' }
    converting = true
    try {
      const files = collectNcmFiles(dir)
      const total = files.length
      if (!total) return { ok: true, total: 0, results: [] }

      const out = outputDir || path.join(dir, 'converted')
      const coverDir = path.join(out, '.covers')
      fs.mkdirSync(out, { recursive: true })

      const results = []
      let done = 0
      let okCount = 0
      let failCount = 0

      for (const f of files) {
        done++
        const base = path.basename(f)
        send({ done, total, current: base })
        const r = await decryptNcmFile(f, { outputDir: out, coverDir, writeTags: true })
        if (r.ok) {
          okCount++
          results.push({ file: f, outPath: r.outPath, format: r.format, ok: true, wroteTag: r.wroteTag, title: r.meta?.title || '', artist: r.meta?.artist || '' })
        } else {
          failCount++
          results.push({ file: f, ok: false, error: r.error })
        }
        send({ done, total, ok: okCount, fail: failCount, current: base })
      }
      return { ok: true, total, ok: okCount, fail: failCount, results, outputDir: out }
    } finally {
      converting = false
    }
  })
}
