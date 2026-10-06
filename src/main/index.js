import { app, BrowserWindow, protocol, shell, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { registerAudioProtocol } from './audioProtocol.js'
import { NcmServer } from './ncmServer.js'
import { QqMusicServer } from './qqMusicServer.js'
import { registerApiIpc } from './ipc/api.js'
import { registerDownloadIpc } from './ipc/download.js'
import { registerLibraryIpc } from './ipc/library.js'
import { registerPlaylistIpc } from './ipc/playlist.js'
import { registerNcmConvertIpc } from './ipc/ncmConvert.js'
import { registerQqMusicIpc } from './ipc/qqmusic.js'
import { registerBiliIpc } from './ipc/bilibili.js'
import { initDb, closeDb } from './db/index.js'
import { settingsRepo } from './db/settings.js'
import { initAudioCache } from './audioCache.js'
import { initBiliCache } from './biliStream.js'
import {
  createTray,
  destroyTray,
  showWindow,
  markQuitting,
  isQuitting,
  applyAutoLaunch,
  getAutoLaunchState,
  isStartMinimized
} from './tray.js'

// 自定义协议需在 app ready 前注册特权。
// standard+secure：让 Chromium 按标准协议（类似 http）处理 ncm-audio://，
// media 元素对「标准协议」的 seek/缓存/取消语义与自定义 scheme 不同——
// 缺 standard 时 media seek 可能被误判失败（MEDIA_ERR_NETWORK 卡死）
//
// corsEnabled：允许该协议参与 CORS 校验。
// 页面运行在 file:// 下（打包版 loadFile），hls.js 内部用 fetch/XHR 加载
// m3u8 与分片 —— 从 file:// origin 发起的跨源请求会被 Chromium 在**发出前**
// 就以 CORS 拒绝（响应头补 Access-Control-Allow-Origin 也没用，因为请求根本
// 没到协议处理器）。必须开这个标志才能让 fetch 正常读到响应。
// media 元素（<video>）走独立加载路径不受此限，所以直连 mp4 一直没问题，
// 直到引入 HLS 才暴露。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ncm-audio',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

// 关键：Chromium 网络栈只认系统代理（不认 NO_PROXY 环境变量）。
// 本机系统代理配置残留（如失效的 127.0.0.1:10808）会让渲染进程加载
// localhost:5173（dev 页面）等本地请求挂起 → 白屏卡死。
// 必须在 app ready 前让 Chromium 绕过代理访问本地地址。
app.commandLine.appendSwitch('proxy-bypass-list', 'localhost;127.0.0.1;[::1]')
// 调试用：远程调试端口（排障时打开；正常使用不受影响）
if (process.env.NCM_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.NCM_DEBUG_PORT)
}

// 兜底：静默 EPIPE 等管道断开错误，避免触发"JavaScript error"弹窗
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || e.code === 'ECONNRESET' || e.code === 'ENOTCONN')) return
  console.error('[main] uncaughtException', e)
})
// Promise 内炸掉的错默认静默丢弃（Node 行为），统一落日志便于排障
process.on('unhandledRejection', (e) => {
  console.error('[main] unhandledRejection', e)
})

let mainWindow = null
const server = new NcmServer()
const qqMusicServer = new QqMusicServer()
let downloadManager = null

/** 托盘模式是否开启（关闭窗口时驻留后台而非退出） */
function trayEnabled() {
  try { return settingsRepo.get('minimizeToTray') === true } catch { return false }
}

/**
 * 托盘实例。
 * 声明位置提到使用之前（`let` 有 TDZ，写在后面虽然实际不会触发，
 * 但容易在重构时踩坑）。
 */
let trayInstance = null

/** 启动时是否最小化到托盘（**独立开关**，不依赖托盘模式） */
function startMinimizedEnabled() {
  try { return settingsRepo.get('startMinimized') === true } catch { return false }
}

/**
 * 本次启动是否应该直接最小化到托盘。
 *
 * 三个来源任一满足即可（对齐 VRCX 的「以最小化的形式启动」独立开关）：
 *   1. 设置里的「启动时最小化」开关 —— 用户显式开启，手动启动也生效
 *   2. 命令行带 `--start-minimized` —— 开机自启项里写入的参数
 *
 * 注意：**不再要求托盘模式开启**。
 * 原实现写成 `isStartMinimized() && trayEnabled()`，导致「最小化启动」
 * 依赖「最小化到托盘」—— 用户只开前者时完全不生效，且看不出原因。
 * 两者语义本就不同：
 *   - 启动时最小化：控制**启动那一刻**的窗口可见性
 *   - 最小化到托盘：控制**点关闭按钮时**的行为
 * 现在独立判断；若启动时最小化但托盘未开，仍会建一个临时托盘图标
 * （否则窗口藏起来后用户没有任何入口把它叫回来）。
 */
function shouldStartMinimized() {
  return startMinimizedEnabled() || isStartMinimized()
}

/**
 * 初始化托盘（若需要）。
 *
 * 创建时机：
 *   - 用户开了「最小化到托盘」→ 启动即建（点关闭时要用）
 *   - 本次要最小化启动 → 也要建（否则窗口藏起来后没有入口唤回）
 */
function initTrayIfEnabled() {
  if (!trayEnabled() && !shouldStartMinimized()) return
  if (trayInstance) return // 已创建
  trayInstance = createTray({
    getWindow: () => mainWindow,
    isPlaying: () => playingFlag,
    onTogglePlay: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('player:toggle-play')
      }
    },
    onQuit: () => {
      markQuitting()
      app.quit()
    }
  })
}

/** 播放态标志（渲染层经 IPC 同步，供托盘菜单文案使用） */
let playingFlag = false

/** 应用托盘相关 IPC 与设置应用 */
function registerTrayIpc() {
  // 渲染层同步播放态 → 托盘菜单显示「播放/暂停」
  ipcMain.handle('win:set-playing', (_e, playing) => {
    playingFlag = !!playing
    return true
  })

  // 查询/设置托盘模式
  ipcMain.handle('win:get-tray-settings', () => {
    const sys = getAutoLaunchState()
    return {
      minimizeToTray: trayEnabled(),
      autoLaunch: (() => {
        try { return settingsRepo.get('autoLaunch') === true } catch { return false }
      })(),
      startMinimized: startMinimizedEnabled(),
      // 系统实际状态（可能与设置库不一致，供 UI 提示）
      systemAutoLaunch: sys.enabled,
      devMode: sys.devMode
    }
  })

  // 修改设置（同时同步到系统）
  ipcMain.handle('win:set-tray-settings', (_e, patch = {}) => {
    if (typeof patch.minimizeToTray === 'boolean') {
      settingsRepo.set('minimizeToTray', patch.minimizeToTray)
      if (patch.minimizeToTray) {
        initTrayIfEnabled()
      } else if (!startMinimizedEnabled()) {
        // 关掉托盘模式：仅当「启动时最小化」也关着时才销毁托盘
        //（否则下次最小化启动就没有唤回入口了）
        destroyTray()
        trayInstance = null
      }
    }
    if (typeof patch.startMinimized === 'boolean') {
      settingsRepo.set('startMinimized', patch.startMinimized)
      // 开了「启动时最小化」也要保证托盘存在（窗口藏起来后需要入口唤回）
      if (patch.startMinimized) initTrayIfEnabled()
    }
    if (typeof patch.autoLaunch === 'boolean') {
      settingsRepo.set('autoLaunch', patch.autoLaunch)
      applyAutoLaunch(patch.autoLaunch, startMinimizedEnabled())
    }
    // 「启动时最小化」变化时，若自启已开启需重写注册表参数（args 变了）
    if (typeof patch.startMinimized === 'boolean') {
      try {
        if (settingsRepo.get('autoLaunch') === true) {
          applyAutoLaunch(true, patch.startMinimized)
        }
      } catch { /* ignore */ }
    }
    return { ok: true }
  })
}

/**
 * 一次性迁移：`startMinimized` 语义变更（v0.3.5 → 当前）。
 *
 * 旧语义：「**自启时**最小化到托盘」，默认值 **true**（只在开机自启时生效）。
 * 新语义：「**启动时**最小化到托盘」独立开关，默认值 **false**
 *        （对齐 VRCX 的「以最小化的形式启动」）。
 *
 * 问题：旧版本从未写过这个键（只是 DEFAULTS 里给了 true），所以
 * `settingsRepo.has('startMinimized')` 为 false 时说明是旧数据，
 * 此时若沿用旧默认值 true，全新/升级用户双击后窗口直接消失，
 * 会以为程序没启动。
 *
 * 处理：从未显式设置过 → 显式写入 false（新默认值）；
 *       用户自己设过 → 保留其选择。
 */
function migrateStartMinimized() {
  try {
    if (settingsRepo.has('startMinimized')) return
    settingsRepo.set('startMinimized', false)
    console.log('[settings] startMinimized 迁移为新默认值 false（独立开关语义）')
  } catch (e) {
    console.error('[settings] startMinimized 迁移失败', e)
  }
}

/**
 * 启动时把设置里的自启状态同步到系统（用户可能在别处改过注册表）。
 *
 * 开发模式也照常同步 —— 见 tray.js 的 applyAutoLaunch 注释：
 * 静默跳过会让 UI 永远显示「不一致」且开关无效，用户只会认为功能坏了。
 * 现在改为「照常读写 + UI 明确提示开发模式」。
 */
function syncAutoLaunchOnBoot() {
  try {
    const want = settingsRepo.get('autoLaunch') === true
    const sys = getAutoLaunchState()
    if (want !== sys.enabled) {
      console.log(`[auto-launch] 系统状态(${sys.enabled})与设置(${want})不一致，同步为 ${want}`)
      applyAutoLaunch(want, startMinimizedEnabled())
    }
  } catch (e) {
    console.error('[auto-launch] 启动同步失败', e)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    title: '咏叹调 - Aria Player',
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    frame: false, // 无边框：去掉系统标题栏白条，窗口控制嵌在页面 header 内
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // preload 只用 contextBridge/ipcRenderer，无 Node 依赖
    }
  })

  // ---- 自定义标题栏：窗口控制（渲染层经通用 invoke 桥调用） ----
  ipcMain.handle('win:minimize', () => mainWindow?.minimize())
  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('win:close', () => mainWindow?.close())
  ipcMain.handle('win:is-maximized', () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
  // F11 沉浸全屏（渲染层歌词页/任意处调用）
  ipcMain.handle('win:set-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return mainWindow.isFullScreen()
  })
  ipcMain.handle('win:is-fullscreen', () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen())
  // 最大化状态变化广播（渲染层切换 还原/最大化 图标）
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaxState)
  mainWindow.on('unmaximize', sendMaxState)

  mainWindow.once('ready-to-show', () => {
    /**
     * 最小化启动：不弹窗，直接进托盘。
     *
     * 触发条件（见 shouldStartMinimized）：
     *   - 设置里开了「启动时最小化」→ 手动双击启动也生效
     *   - 命令行带 `--start-minimized` → 开机自启项写入的参数
     *
     * 两者独立于「最小化到托盘」—— 那是控制点关闭按钮的行为，
     * 语义不同（原实现错误地把两者绑在一起）。
     */
    if (shouldStartMinimized()) {
      console.log('[window] 最小化启动：窗口不显示，驻留托盘')
      // 确保有托盘图标，否则用户没有入口唤回窗口
      initTrayIfEnabled()
      return
    }
    mainWindow.show()
  })

  /**
   * 关闭窗口 → 最小化到托盘（可配置）。
   *
   * 音乐播放器的常见预期：点关闭 ≠ 退出，后台继续放歌。
   * 仅在「托盘模式开启」时拦截；否则维持原行为（直接退出）。
   *
   * 注意必须用 isQuitting() 区分「用户点关闭」与「真的退出」
   *（托盘菜单的退出 / app.quit()），否则会退不掉。
   */
  mainWindow.on('close', (e) => {
    if (isQuitting()) return // 真退出，放行
    if (!trayEnabled()) return // 未开托盘模式，维持原行为（退出）
    e.preventDefault()
    mainWindow.hide()
    console.log('[window] 已最小化到托盘（后台继续运行）')
  })

  // 兜底：若 ready-to-show 因渲染卡住/加载慢未触发，5s 后强制显示窗口并居中
  setTimeout(() => {
    /**
     * 超时兜底：ready-to-show 未触发时强制显示窗口（防白屏卡死无窗口可用）。
     *
     * ⚠️ 但**最小化启动时必须跳过** —— 否则用户选了「静默驻留托盘」，
     * 5 秒后窗口自己弹出来，与设置相悖。
     * 这种情况下托盘图标已建好，用户随时能唤回，不存在「无窗口可用」的问题。
     */
    if (shouldStartMinimized()) {
      console.log('[window] 最小化启动模式，跳过超时强制显示')
    } else if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.center()
      mainWindow.show()
      console.log('[window] 超时兜底强制显示窗口')
    }
    // 检查渲染进程实际状态（诊断白屏/未加载）
    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        const st = await mainWindow.webContents.executeJavaScript(`({
          ready: document.readyState,
          url: location.href,
          bodyLen: document.body ? document.body.innerHTML.length : -1,
          hasNav: document.querySelectorAll('.nav-item').length,
          title: document.title
        })`)
        console.log('[window] 渲染状态:', JSON.stringify(st))
      } catch (e) {
        console.log('[window] 渲染检查失败:', e.message)
      }
    }, 4000)
  }, 5000)

  // 渲染进程 console 转发到主进程日志（排障用；dev 下输出到终端）
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['v', 'i', 'w', 'e'][level] || '?'
    console.log(`[renderer:${tag}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
  })

  // 页面加载状态诊断
  mainWindow.webContents.on('did-start-loading', () => console.log('[load] start-loading'))
  mainWindow.webContents.on('did-stop-loading', () => console.log('[load] stop-loading'))
  mainWindow.webContents.on('did-finish-load', () => console.log('[load] finish-load'))
  mainWindow.webContents.on('did-frame-finish-load', (_e, isMain) => {
    if (isMain) console.log('[load] main-frame-finish-load')
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[load] FAIL code=${code} desc=${desc} url=${url ? url.slice(0, 100) : ''}`)
  })
  mainWindow.webContents.on('did-fail-provisional-load', (_e, code, desc, url) => {
    console.log(`[load] PROV-FAIL code=${code} desc=${desc} url=${url ? url.slice(0, 100) : ''}`)
  })
  mainWindow.webContents.on('did-start-navigation', (_e, url) => {
    if (url.startsWith('http')) console.log('[load] nav->', url.slice(0, 80))
  })
  // 渲染进程内资源加载错误（404/超时等）
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // console-message 已在上面处理，这里只补充
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
  qqMusicServer.onStatusChange = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('qqmusic:server-status', status)
    }
  }

  downloadManager = registerDownloadIpc(() => mainWindow, () => server)
  registerApiIpc(() => server)
  registerQqMusicIpc(() => qqMusicServer)
  registerLibraryIpc(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ncm:library-updated', {})
    }
  })
  registerPlaylistIpc()
  registerNcmConvertIpc(() => mainWindow)
  // 传入 ncm server：B 站字幕/歌词功能需要经私有通道搜网易云
  registerBiliIpc(() => server)

  // 托盘 + 开机自启：先做设置迁移，再同步系统自启状态，最后按需建托盘
  migrateStartMinimized()
  syncAutoLaunchOnBoot()
  registerTrayIpc()
  initTrayIfEnabled()

  createWindow()

  /**
   * 内置服务启动策略：**网易云立即启动，QQ 音乐懒启动**。
   *
   * QQ 音乐用 ts-node 实时编译 TS，实测冷启动 4.9s（网易云仅 0.6s），
   * 而它是可选音源 —— 多数用户开机后只用网易云。原先与网易云并行启动，
   * 虽不叠加耗时，但会抢 CPU/磁盘（开机时其他自启程序也在抢），
   * 间接拖慢网易云就绪；还白占一个 215MB 子进程。
   *
   * 改为懒启动后，首屏只等服务更快的网易云。
   * QQ 音乐在首次用到时由 ipc/qqmusic.js 的 requireReadyServer() 拉起。
   *
   * 若用户开了「启动时预加载 QQ 音乐」（settings.qqPreload），则仍并行启动 ——
   * 给常用 QQ 音源的用户的折中选项。
   */
  const qqPreload = (() => {
    try { return settingsRepo.get('qqPreload') === 'true' } catch { return false }
  })()

  const ok = await server.start().catch((e) => {
    console.error('[bootstrap] ncm-server start threw', e)
    return false
  })
  if (!ok) {
    console.error('[bootstrap] ncm-server failed to start')
  }

  if (qqPreload) {
    // 用户显式要求预加载：并行启动，不阻塞网易云就绪
    qqMusicServer.start().catch((e) => {
      console.error('[bootstrap] qqmusic-server start threw', e)
      return false
    })
  } else {
    console.log('[bootstrap] QQ 音乐服务懒启动（首次使用时拉起）')
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
        // 0. 检查是否有全屏遮罩（LyricPanel）挡住点击
        const mask = await w.webContents.executeJavaScript(`({
          lyricPanel: !!document.querySelector('.lyric-panel'),
          modal: !!document.querySelector('.modal-mask'),
          playError: !!document.querySelector('.play-error'),
          overlayCount: [...document.querySelectorAll('*')].filter(el => {
            const st = getComputedStyle(el)
            return st.position === 'fixed' && parseFloat(st.zIndex || 0) >= 100 && el.offsetWidth > 0
          }).map(el => el.className).slice(0, 6)
        })`)
        console.log('[probe] 遮罩检查:', JSON.stringify(mask))

        // 1. 真实 DOM 点击侧边栏导航（模拟用户点击）
        const navTest = await w.webContents.executeJavaScript(`(async () => {
          const results = []
          const navs = [...document.querySelectorAll('.nav-item')]
          for (const a of navs) {
            const target = a.getAttribute('href')
            a.click()
            await new Promise(r => setTimeout(r, 1200))
            results.push({
              target,
              now: location.hash,
              contentLen: (document.querySelector('.content')?.innerText || '').length
            })
          }
          return results
        })()`)
        console.log('[probe] 导航点击测试:', JSON.stringify(navTest, null, 1))

        // 2. 发现页卡片点击测试（若在发现页）
        const cardTest = await w.webContents.executeJavaScript(`(async () => {
          await new Promise(r => { location.hash = '#/discover'; setTimeout(r, 1500) })
          const card = document.querySelector('.playlist-card')
          if (!card) return '无卡片可点'
          const before = location.hash
          card.click()
          await new Promise(r => setTimeout(r, 1500))
          return { before, after: location.hash, contentLen: (document.querySelector('.content')?.innerText || '').length }
        })()`)
        console.log('[probe] 卡片点击测试:', JSON.stringify(cardTest))

        const routes = ['#/discover', '#/library', '#/resolver', '#/search', '#/downloads', '#/settings']
        const shotDir = require('path').join(app.getPath('temp'), 'ntr-shots')
        require('fs').mkdirSync(shotDir, { recursive: true })
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
          // 截图保存
          try {
            const img = await w.webContents.capturePage()
            require('fs').writeFileSync(require('path').join(shotDir, r.replace(/[#/]/g, '_') + '.png'), img.toPNG())
          } catch (e) { console.log('[probe] 截图失败', r, e.message) }
        }
        console.log('[probe] 截图目录:', shotDir)
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
  /**
   * 第二个实例被启动时（用户双击快捷方式 / 再次运行 exe）→ 唤回已有窗口。
   *
   * ## ⚠️ 必须显式 show()（实测踩过）
   *
   * 原实现只做了 `restore()` + `focus()`，但**窗口被隐藏到托盘时
   * `hide()` 之后 `isMinimized()` 是 false** —— restore 不生效，
   * 而 `focus()` 对隐藏窗口**不会让它显示**。
   *
   * 症状：用户开了「以最小化的形式启动」或点了关闭按钮驻留托盘后，
   * 再双击快捷方式完全没反应，看起来像程序坏了。
   *
   * 正确顺序：restore（处理最小化）→ show（处理隐藏）→ focus（置前）。
   * 用 showWindow() 统一处理，它内部已包含这三步。
   */
  app.on('second-instance', () => {
    console.log('[second-instance] 检测到第二个实例，唤回窗口')
    if (!mainWindow || mainWindow.isDestroyed()) {
      // 窗口已被销毁（理论上不会，因为托盘模式下不退出）→ 重建
      console.log('[second-instance] 窗口不存在，重建')
      createWindow()
      return
    }
    const before = {
      visible: mainWindow.isVisible(),
      minimized: mainWindow.isMinimized()
    }
    console.log('[second-instance] 唤回前:', JSON.stringify(before))
    showWindow(() => mainWindow)
    console.log('[second-instance] 唤回后:', JSON.stringify({
      visible: mainWindow.isVisible(),
      minimized: mainWindow.isMinimized()
    }))
  })

  app.whenReady().then(() => {
    initDb() // SQLite（含旧 JSON 数据自动迁移）——必须在所有 IPC 注册前就绪
    initAudioCache() // 音频持久缓存：建目录、清半成品、LRU 收敛
    initBiliCache() // B 站合流缓存：清 .part 半成品、按上限淘汰
    registerAudioProtocol()
    bootstrap()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // 托盘模式下窗口关闭只是隐藏，不该退出应用（否则后台播放无从谈起）
    if (trayEnabled() && !isQuitting()) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async () => {
    markQuitting() // 标记真退出：让窗口 close 拦截器放行
    destroyTray()
    await server.stop()
    await qqMusicServer.stop()
    closeDb()
  })
}
