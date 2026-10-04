/**
 * 托盘与开机自启。
 *
 * ## 托盘
 *
 * 关闭窗口时可选「最小化到托盘继续播放」——音乐播放器的常见预期：
 * 关掉窗口不等于退出，后台还能继续放歌。
 *
 * 托盘图标在打包版取 resources/icon.png（Windows 需 .ico 才清晰，
 * 但 PNG 在 Electron 里也能用，只是高 DPI 下略糊；见下方 getIcon 的兜底）。
 *
 * ## 开机自启
 *
 * 用 Electron 内置的 app.setLoginItemSettings（Windows 注册表 Run 项 /
 * macOS LaunchAgent / Linux .desktop），不自己写注册表。
 *
 * 两个可配置项：
 *   - autoLaunch: 开机自启
 *   - startMinimized: 自启时最小化到托盘（不弹窗打扰）
 *
 * 注意：Windows 上 setLoginItemSettings 对 **开发模式**（electron.exe .）
 * 会写入带项目路径的启动项，意义不大；打包版才真正可用。故在开发模式下
 * 只记录设置、不写注册表，避免污染系统。
 */
import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'

let tray = null
let quitting = false

/** 托盘图标：优先用 resources/icon.png；找不到时返回空图（Tray 不崩但无图标） */
function getIcon() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'icon.png'),
        path.join(process.resourcesPath, 'app.asar', 'resources', 'icon.png')
      ]
    : [
        path.join(app.getAppPath(), 'resources', 'icon.png')
      ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p)
        if (!img.isEmpty()) return img
      }
    } catch { /* 继续尝试下一个 */ }
  }
  return nativeImage.createEmpty()
}

/**
 * 创建托盘图标与菜单。
 *
 * @param {object} opts
 * @param {() => BrowserWindow|null} opts.getWindow 取主窗口（可能已被关闭重建）
 * @param {() => boolean} opts.isPlaying 当前是否在播放（菜单文案用）
 * @param {() => void} opts.onTogglePlay 播放/暂停回调
 * @param {() => void} opts.onQuit 真正退出（清理服务后 quit）
 */
export function createTray(opts) {
  if (tray) return tray

  const icon = getIcon()
  tray = new Tray(icon)
  tray.setToolTip('咏叹调 - Aria Player')

  const rebuild = () => {
    const playing = opts.isPlaying?.() ?? false
    const menu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => showWindow(opts.getWindow)
      },
      {
        label: playing ? '暂停' : '播放',
        click: () => opts.onTogglePlay?.()
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          opts.onQuit?.()
        }
      }
    ])
    tray.setContextMenu(menu)
  }

  rebuild()
  // 左键单击：切换窗口显示（Windows 习惯）
  tray.on('click', () => showWindow(opts.getWindow))

  return { tray, rebuild }
}

/** 刷新托盘菜单（播放状态变化时调用） */
export function refreshTray() {
  if (!tray) return
  // 重建菜单以更新「播放/暂停」文案
  const menu = tray.contextMenu
  if (menu) tray.setContextMenu(menu)
}

/** 显示并聚焦主窗口（可能已隐藏或最小化） */
export function showWindow(getWindow) {
  const win = getWindow?.()
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  return true
}

/** 销毁托盘 */
export function destroyTray() {
  if (tray) {
    try { tray.destroy() } catch { /* ignore */ }
    tray = null
  }
}

export function isQuitting() {
  return quitting
}

export function markQuitting() {
  quitting = true
}

/**
 * 同步开机自启设置到系统。
 *
 * @param {boolean} enabled 是否开机自启
 * @param {boolean} startMinimized 自启时是否最小化（作为启动参数传给自身）
 */
export function applyAutoLaunch(enabled, startMinimized = true) {
  // 开发模式下不写系统启动项：那会写入带 electron.exe + 项目路径的条目，
  // 卸载/换目录后变成僵尸启动项，且对用户没有实际意义。
  if (!app.isPackaged) {
    console.log(`[auto-launch] 开发模式，跳过系统写入（enabled=${enabled}, minimized=${startMinimized}）`)
    return { applied: false, reason: 'dev-mode' }
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      // Windows：自启时传参，主进程据此决定是否隐藏窗口
      args: enabled && startMinimized ? ['--start-minimized'] : [],
      // macOS 专用：登录时隐藏（不弹 Dock）
      openAsHidden: enabled && startMinimized
    })
    console.log(`[auto-launch] 已${enabled ? '开启' : '关闭'}开机自启（minimized=${startMinimized}）`)
    return { applied: true }
  } catch (e) {
    console.error('[auto-launch] 设置失败', e)
    return { applied: false, reason: e.message }
  }
}

/** 读取系统当前的自启状态（可能与设置库不一致，以系统为准显示） */
export function getAutoLaunchState() {
  try {
    if (!app.isPackaged) return { enabled: false, devMode: true }
    const s = app.getLoginItemSettings()
    return { enabled: !!s.openAtLogin, devMode: false }
  } catch {
    return { enabled: false, devMode: false }
  }
}

/** 本次启动是否由「开机自启 + 最小化」触发 */
export function isStartMinimized() {
  return process.argv.includes('--start-minimized')
}
