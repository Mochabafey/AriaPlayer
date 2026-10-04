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
 * ## 开发模式的处理（踩过的坑）
 *
 * 原实现在 `!app.isPackaged` 时**直接 return，什么都不做**。这导致：
 *   - 用户（或开发者）在开发版里开关自启，系统毫无变化
 *   - `getAutoLaunchState()` 同样直接返回 `enabled:false`，
 *     UI 永远显示「与系统实际状态不一致」，**反复开关也修不好**
 *   - 更糟的是：安装版写过注册表项后，开发版读不到它，
 *     用户会以为功能坏了
 *
 * 现在的做法：**照常读写**（Electron 的 setLoginItemSettings 在开发模式
 * 下也能工作 —— 它写的是 electron.exe + 项目路径），同时返回 `devMode:true`
 * 让 UI 明确提示「当前是开发模式，自启项指向开发环境」。
 *
 * 为什么不干脆禁用：用户无法区分「功能没生效」与「开发模式不写」，
 * 只会认为坏了。明确读写 + 明确提示，行为可预期。
 *
 * @param {boolean} enabled 是否开机自启
 * @param {boolean} startMinimized 自启时是否最小化（作为启动参数传给自身）
 */
export function applyAutoLaunch(enabled, startMinimized = true) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      // Windows：自启时传参，主进程据此决定是否隐藏窗口
      args: enabled && startMinimized ? ['--start-minimized'] : [],
      // macOS 专用：登录时隐藏（不弹 Dock）
      openAsHidden: enabled && startMinimized
    })
    const dev = !app.isPackaged
    console.log(
      `[auto-launch] 已${enabled ? '开启' : '关闭'}开机自启` +
      `（minimized=${startMinimized}${dev ? '，开发模式' : ''}）`
    )
    return { applied: true, devMode: dev }
  } catch (e) {
    console.error('[auto-launch] 设置失败', e)
    return { applied: false, reason: e.message }
  }
}

/**
 * 读取系统当前的自启状态（以系统为准，而非设置库）。
 *
 * ## 为什么不能只用 app.getLoginItemSettings()（踩过的坑）
 *
 * 实测（Electron 43 / Windows）：
 *
 *     开发模式:
 *       setLoginItemSettings 写入的项名是 "electron.app.Electron"
 *       但 getLoginItemSettings().openAtLogin 恒为 **false**
 *       —— 它按可执行文件路径匹配，而开发模式下 execPath 是 electron.exe，
 *          与注册表里的项对不上。只有 launchItems 数组里能看到真实项。
 *
 *     安装版:
 *       项名是 "electron.app.<productName>"，openAtLogin 正常。
 *
 * 后果：开发版 UI 永远显示「与系统实际状态不一致」，反复开关也修不好 ——
 * 用户只会认为功能坏了。
 *
 * ## 现在的做法
 *
 * 优先读 Electron 的 `launchItems`（它列的是真实注册表项，开发/打包都能看到），
 * 并额外用 `executableWillLaunchAtLogin` 交叉验证。
 * Windows 上还可直接查注册表兜底（见 readAutoLaunchFromRegistry）。
 */
export function getAutoLaunchState() {
  const devMode = !app.isPackaged
  try {
    const s = app.getLoginItemSettings()
    /**
     * 判定「是否已开启」的优先级：
     *   1. openAtLogin —— 打包版的权威值
     *   2. launchItems 里是否存在指向本应用可执行文件的启用项 ——
     *      开发版唯一可靠的来源（openAtLogin 在开发版恒 false）
     *   3. Windows 注册表直查 —— 前两者都拿不到时的兜底
     */
    let enabled = !!s.openAtLogin
    if (!enabled && Array.isArray(s.launchItems)) {
      const exePath = app.getPath('exe')
      const exeName = path.basename(exePath).toLowerCase()
      enabled = s.launchItems.some((it) => {
        if (!it || it.enabled === false) return false
        const p = String(it.path || '').toLowerCase()
        // 匹配「同一个可执行文件」：完整路径相同，或文件名相同
        //（开发版注册表里存的是 electron.exe 全路径，与 execPath 一致）
        return p === exePath.toLowerCase() || path.basename(p) === exeName
      })
    }
    if (!enabled && process.platform === 'win32') {
      enabled = readAutoLaunchFromRegistry() != null
    }
    return { enabled, devMode }
  } catch (e) {
    console.error('[auto-launch] 读取失败', e)
    return { enabled: false, devMode }
  }
}

/**
 * 直接从 Windows 注册表读自启项（开发版下 Electron 的 API 不可靠时的兜底）。
 *
 * 项名规则：`electron.app.<app.getName()>`。
 * 返回命令行字符串（含参数），未找到返回 null。
 */
function readAutoLaunchFromRegistry() {
  if (process.platform !== 'win32') return null
  try {
    const { execFileSync } = require('child_process')
    const keyName = `electron.app.${app.getName()}`
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', keyName],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const m = out.match(/REG_SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    // reg query 在项不存在时以非 0 退出
    return null
  }
}

/** 本次启动是否由「开机自启 + 最小化」触发 */
export function isStartMinimized() {
  return process.argv.includes('--start-minimized')
}
