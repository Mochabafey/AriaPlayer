import { app, BrowserWindow, protocol, shell, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { registerAudioProtocol } from './audioProtocol.js'
import { NcmServer } from './ncmServer.js'
import { registerApiIpc } from './ipc/api.js'
import { registerDownloadIpc } from './ipc/download.js'
import { registerLibraryIpc } from './ipc/library.js'
import { registerPlaylistIpc } from './ipc/playlist.js'
import { registerNcmConvertIpc } from './ipc/ncmConvert.js'
import { flushAll } from './store/db.js'

// 自定义协议需在 app ready 前注册特权
protocol.registerSchemesAsPrivileged([
  { scheme: 'ncm-audio', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
])

// 兜底：静默 EPIPE 等管道断开错误，避免触发"JavaScript error"弹窗
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || e.code === 'ECONNRESET' || e.code === 'ENOTCONN')) return
  console.error('[main] uncaughtException', e)
})

let mainWindow = null
const server = new NcmServer()
let downloadManager = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    title: '网易牛具 - Netease Track Resolver',
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 渲染进程 console 转发到主进程日志（排障用；dev 下输出到终端）
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['v', 'i', 'w', 'e'][level] || '?'
    console.log(`[renderer:${tag}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
  })

  // 渲染进程崩溃/未响应检测
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  mainWindow.webContents.on('unresponsive', () => console.log('[renderer-unresponsive] 渲染进程无响应'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 外链一律交给系统浏览器
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (!url.startsWith('file:')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap() {
  // 通知渲染进程服务状态变化
  server.onStatusChange = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ncm:server-status', status)
    }
  }

  downloadManager = registerDownloadIpc(() => mainWindow, () => server)
  registerApiIpc(() => server)
  registerLibraryIpc(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ncm:library-updated', {})
    }
  })
  registerPlaylistIpc()
  registerNcmConvertIpc(() => mainWindow)

  createWindow()

  // 启动内置 api-enhanced 服务（开发/打包均走子进程）
  const ok = await server.start()
  if (!ok) {
    console.error('[bootstrap] ncm-server failed to start')
  }

  // 烟测模式：服务就绪 + 窗口就绪后打印成功日志并退出（用于 CI/本地验证）
  if (process.env.NCM_SMOKE === '1') {
    const w = mainWindow
    if (w) {
      await new Promise((resolve) => {
        if (w.webContents.isLoading()) {
          w.webContents.once('did-finish-load', resolve)
        } else resolve()
      })
    }
    console.log('SMOKE_OK status=' + server.status)
    setTimeout(() => app.exit(0), 500)
  }

  // 前端探测模式：NCM_PROBE=1 时自动切换所有路由并输出渲染状态（排障用）
  if (process.env.NCM_PROBE === '1') {
    setTimeout(async () => {
      const w = mainWindow
      if (!w || w.isDestroyed()) {
        console.log('[probe] 窗口不可用')
        app.exit(1)
        return
      }
      try {
        const routes = ['#/library', '#/resolver', '#/search', '#/profile', '#/downloads', '#/settings', '#/discover']
        for (const r of routes) {
          await w.webContents.executeJavaScript(`location.hash = ${JSON.stringify(r)}`)
          await new Promise((r2) => setTimeout(r2, 2000))
          const st = await w.webContents.executeJavaScript(`({
            hash: location.hash,
            text: (document.querySelector('.content')?.innerText || '').slice(0, 60),
            imgs: [...document.querySelectorAll('.content img')].filter(i => i.complete && i.naturalWidth > 0).length,
            imgTotal: document.querySelectorAll('.content img').length
          })`)
          console.log(`[probe] ${r} => hash=${st.hash} imgs=${st.imgs}/${st.imgTotal} text="${st.text}"`)
        }
        const imgs = await w.webContents.executeJavaScript(`[...document.querySelectorAll('.content img')].map(i => i.src.slice(0, 90))`)
        console.log('[probe] 图片URL样本:', JSON.stringify(imgs.slice(0, 4)))
      } catch (e) {
        console.log('[probe] 探测异常:', e.message)
      }
      console.log('[probe] DONE')
      setTimeout(() => app.exit(0), 300)
    }, 12000)
  }
}

// 单一实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerAudioProtocol()
    bootstrap()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async () => {
    await server.stop()
    flushAll()
  })
}
