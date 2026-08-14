import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { decryptNcmFile, collectNcmFiles, writeTags } from '../ncm/ncmDecrypt.mjs'
import { transcode } from '../ffmpeg.js'
import { stores } from '../store/db.js'

/** 目标格式 → ffmpeg 转码参数（-vn 去视频轨；转码在 IPC 层做，ncmDecrypt 保持纯 JS） */
const FORMAT_OPTS = {
  mp3: ['-vn', '-codec:a', 'libmp3lame', '-q:a', '2'],
  flac: ['-vn', '-codec:a', 'flac', '-compression_level', '5'],
  m4a: ['-vn', '-codec:a', 'aac', '-b:a', '320k'],
  wav: ['-vn', '-acodec', 'pcm_s16le']
}

/**
 * .ncm 批量转换 IPC：
 *   ncm:convert-pick-file  选择单个 .ncm 文件（记住上次路径）
 *   ncm:convert-pick-dir   选择包含 .ncm 的目录（记住上次路径）
 *   ncm:convert-batch      批量转换（递归扫描 .ncm → 解密 → mp3/flac + 封面 + 标签）
 *   事件 ncm:convert-progress
 *
 * 注意：不用 ['openFile','openDirectory'] 组合——Electron 在 Windows 上
 * 该组合有 bug（见 electron#48217），且文件/文件夹选择器行为不明确。
 * 故拆成两个独立入口，无歧义。
 */
export function registerNcmConvertIpc(getWindow) {
  let converting = false

  const send = (payload) => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('ncm:convert-progress', payload)
  }

  // 计算 dialog 的 defaultPath：用上次记住的路径（文件则取所在目录）
  function lastDefaultPath() {
    const lastPath = stores.settings.get('lastConvertPath')
    if (lastPath && fs.existsSync(lastPath)) {
      return fs.statSync(lastPath).isDirectory() ? lastPath : path.dirname(lastPath)
    }
    return undefined
  }

  function saveLastPath(p) {
    stores.settings.set('lastConvertPath', p)
    stores.settings.saveNow()
  }

  async function showPicker(opts) {
    const w = getWindow()
    const r = w && !w.isDestroyed()
      ? await dialog.showOpenDialog(w, opts)
      : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  }

  ipcMain.handle('ncm:convert-pick-file', async () => {
    try {
      const selected = await showPicker({
        title: '选择 .ncm 文件',
        properties: ['openFile'],
        filters: [{ name: '网易云加密音乐', extensions: ['ncm'] }],
        buttonLabel: '选择文件',
        defaultPath: lastDefaultPath()
      })
      if (!selected) return null
      saveLastPath(selected)
      return { type: 'file', path: selected }
    } catch (e) {
      console.error('[ncm-convert] pick-file error', e)
      throw new Error('打开文件选择失败：' + e.message)
    }
  })

  ipcMain.handle('ncm:convert-pick-dir', async () => {
    try {
      const selected = await showPicker({
        title: '选择包含 .ncm 文件的目录',
        properties: ['openDirectory'],
        buttonLabel: '选择目录',
        defaultPath: lastDefaultPath()
      })
      if (!selected) return null
      saveLastPath(selected)
      return { type: 'dir', path: selected }
    } catch (e) {
      console.error('[ncm-convert] pick-dir error', e)
      throw new Error('打开目录选择失败：' + e.message)
    }
  })

  ipcMain.handle('ncm:convert-batch', async (_e, { path: inputPath, recursive = true, outputDir = null, format = 'auto' } = {}) => {
    if (converting) return { ok: false, error: '已有转换任务进行中' }
    if (!inputPath || !fs.existsSync(inputPath)) return { ok: false, error: '路径不存在' }
    // 校验目标格式
    const wantFormat = String(format || 'auto').toLowerCase()
    if (!['auto', 'mp3', 'flac', 'm4a', 'wav'].includes(wantFormat)) {
      return { ok: false, error: `不支持的输出格式：${format}` }
    }
    converting = true
    try {
      // 支持单文件或目录
      const isDir = fs.statSync(inputPath).isDirectory()
      let files
      if (isDir) {
        files = collectNcmFiles(inputPath)
      } else {
        files = path.extname(inputPath).toLowerCase() === '.ncm' ? [inputPath] : []
      }
      const total = files.length
      const baseDir = isDir ? inputPath : path.dirname(inputPath)
      const out = outputDir || path.join(baseDir, 'converted')
      if (!total) return { ok: true, total: 0, results: [], outputDir: out, isDir }

      const coverDir = path.join(out, '.covers')
      fs.mkdirSync(out, { recursive: true })

      const results = []
      let done = 0
      let okCount = 0
      let failCount = 0
      let convertedCount = 0

      for (const f of files) {
        done++
        const base = path.basename(f)
        send({ done, total, current: base })
        const r = await decryptNcmFile(f, { outputDir: out, coverDir, writeTags: false })
        if (r.ok) {
          let finalPath = r.outPath
          let finalFormat = r.format
          let conversionError = null
          // 目标格式 ≠ 源格式 → ffmpeg 转码（失败回退保留源格式）
          if (wantFormat !== 'auto' && wantFormat !== r.format) {
            try {
              const target = path.join(out, path.basename(r.outPath, '.' + r.format) + '.' + wantFormat)
              await transcode(r.outPath, target, FORMAT_OPTS[wantFormat])
              fs.unlinkSync(r.outPath) // 删除源格式中间文件
              finalPath = target
              finalFormat = wantFormat
              convertedCount++
            } catch (e) {
              conversionError = e.message
              console.warn('[ncm-convert] 转码失败，保留源格式:', path.basename(f), e.message)
            }
          }
          // 写标签（按最终格式）
          let wroteTag = false
          let tagError = null
          if (r.meta) {
            try {
              const tr = await writeTags(finalPath, r.meta, r.coverPath, finalFormat)
              wroteTag = tr.wroteTag
              tagError = tr.error || tr.reason || null
            } catch (e) {
              tagError = e.message
            }
          }
          okCount++
          results.push({
            file: f, outPath: finalPath, format: finalFormat, ok: true,
            wroteTag, tagError, conversionError,
            title: r.meta?.title || '', artist: r.meta?.artist || ''
          })
        } else {
          failCount++
          results.push({ file: f, ok: false, error: r.error })
        }
        send({ done, total, ok: okCount, fail: failCount, current: base })
      }
      return { ok: true, total, ok: okCount, fail: failCount, converted: convertedCount, results, outputDir: out, isDir, format: wantFormat }
    } finally {
      converting = false
    }
  })
}
