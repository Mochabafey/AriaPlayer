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

/**
 * 托盘图标。
 *
 * ## 为什么必须有兜底（踩过的坑）
 *
 * 原先找不到图片就返回 `nativeImage.createEmpty()` —— Tray 不崩，
 * 但托盘区**看不到图标也点不到**。配合「以最小化的形式启动」
 *（窗口启动即隐藏），用户会**完全找不到程序入口**，以为它没启动。
 *
 * 实测踩到：`electron-builder.yml` 的 `extraResources` 漏了 icon.png，
 * 打包版 resources/ 里没有它 → 托盘空白 → 用户报「图标哪去了」。
 *
 * 所以现在三级兜底：
 *   1. 打包/开发路径下的 icon.png
 *   2. app.asar 内的 resources/icon.png
 *   3. **内置生成的纯色圆角方块**（保证托盘永远可见可点）
 *
 * @returns {import('electron').NativeImage}
 */
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
  console.warn('[tray] 未找到 icon.png，使用内置兜底图标（检查 electron-builder.yml 的 extraResources）')
  return makeFallbackIcon()
}

/**
 * 生成一个 16×16 的兜底图标（品牌红底 + 白色圆角块）。
 *
 * ## 为什么用「手写 PNG 编码」而不是内联 base64
 *
 * 最初本娘内联了一段 base64 PNG，但实测它**结构不完整**
 *（`nativeImage.createFromBuffer` 拒绝、图片查看器报 malformed）——
 * 手写的 base64 极易出错且难校验。
 *
 * 改为运行时按 PNG 规范拼字节：IHDR + IDAT(zlib) + IEND，
 * CRC32 用 zlib 自带的实现算。这样**结构一定正确**，也便于以后调颜色。
 *
 * 为什么不用 canvas / sharp：只为一个小图标引入原生依赖不值得。
 *
 * @returns {import('electron').NativeImage}
 */
function makeFallbackIcon() {
  try {
    const zlib = require('zlib')
    const SIZE = 16
    const [R, G, B] = [0xe8, 0x40, 0x4f] // 品牌品红（与播放按钮同色）

    // --- 像素数据：每行 1 字节 filter(0) + SIZE×RGBA ---
    const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
    let o = 0
    for (let y = 0; y < SIZE; y++) {
      raw[o++] = 0 // filter type: None
      for (let x = 0; x < SIZE; x++) {
        // 圆形遮罩（边缘 1px 抗锯齿近似）：四角透明，中间实心
        const cx = x - (SIZE - 1) / 2
        const cy = y - (SIZE - 1) / 2
        const d = Math.sqrt(cx * cx + cy * cy)
        const radius = SIZE / 2 - 0.5
        let a = 255
        if (d > radius) a = 0
        else if (d > radius - 1) a = Math.round(255 * (radius - d))
        raw[o++] = R
        raw[o++] = G
        raw[o++] = B
        raw[o++] = Math.max(0, Math.min(255, a))
      }
    }

    // --- 组装 PNG ---
    const CRC_TABLE = (() => {
      const t = new Int32Array(256)
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c
      }
      return t
    })()
    const crc32 = (buf) => {
      let c = 0xffffffff
      for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length, 0)
      const typeBuf = Buffer.from(type, 'ascii')
      const crcBuf = Buffer.alloc(4)
      crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
      return Buffer.concat([len, typeBuf, data, crcBuf])
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(SIZE, 0)
    ihdr.writeUInt32BE(SIZE, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA
    ihdr[10] = 0 // compression
    ihdr[11] = 0 // filter
    ihdr[12] = 0 // interlace

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0))
    ])

    const img = nativeImage.createFromBuffer(png)
    if (!img.isEmpty()) return img
    console.warn('[tray] 兜底图标生成后仍为空')
  } catch (e) {
    console.error('[tray] 兜底图标生成失败', e)
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
 * ## 关键坑 1：读的时候必须传与写的时候相同的 args（官方文档明确要求）
 *
 * Electron 文档 `app.getLoginItemSettings([options])`：
 *
 *   > options.args _Windows_ - The command-line arguments to compare against.
 *   >   Defaults to an empty array.
 *   > **If you provided `path` and `args` options to `app.setLoginItemSettings`,
 *   > then you need to pass the same arguments here for `openAtLogin` to be
 *   > set correctly.**
 *
 * 本项目写入时带了 `args: ['--start-minimized']`，而读取时若用默认
 *（空数组）就**匹配不上** → `openAtLogin` 恒为 false →
 * UI 永远显示「与系统实际状态不一致」，且反复开关都修不好。
 *
 * ## 关键坑 2：兜底匹配必须锁定「本进程自己的注册表项」
 *
 * 注册表项名是 `electron.app.<app.getName()>`：
 *   开发版   → electron.app.**Electron**      （exe = ...\electron.exe）
 *   安装版   → electron.app.**Aria Player**   （exe = ...\Aria Player.exe）
 *
 * 两者**是不同的项**。若兜底逻辑只按「exe 文件名」宽松匹配，
 * 开发版会误把安装版那条当成自己的 → 关了自启仍显示「已开启」。
 * 所以兜底必须用**完整 exe 路径**精确比较（开发版的 execPath 是
 * electron.exe 的全路径，与注册表项里的 path 完全一致）。
 *
 * ## 取值顺序
 *
 *   1. openAtLogin（带 args / 不带 args 都试）—— 打包版权威值
 *   2. launchItems 里 **exe 路径完全等于** 本进程 execPath 的启用项
 *   3. Windows 注册表直查本进程的项名 —— 最后兜底
 */
export function getAutoLaunchState() {
  const devMode = !app.isPackaged
  try {
    // ---- 1. openAtLogin（必须把 args 组合都试一遍）----
    for (const args of [[], ['--start-minimized']]) {
      try {
        const s = app.getLoginItemSettings({ args })
        if (s.openAtLogin) {
          if (process.env.NTR_DEBUG_AUTOLAUNCH) console.log(`[auto-launch:debug] 命中第1级 openAtLogin args=${JSON.stringify(args)}`)
          return { enabled: true, devMode }
        }
      } catch { /* 该组合不可用时继续 */ }
    }

    // ---- 2. launchItems：必须 exe 路径完全一致（不能用文件名宽松匹配）----
    const s = app.getLoginItemSettings()
    if (Array.isArray(s.launchItems)) {
      const exePath = app.getPath('exe').toLowerCase()
      const hit = s.launchItems.some((it) => {
        if (!it || it.enabled === false) return false
        return String(it.path || '').toLowerCase() === exePath
      })
      if (hit) {
        if (process.env.NTR_DEBUG_AUTOLAUNCH) {
          console.log(`[auto-launch:debug] 命中第2级 launchItems（exePath=${exePath}）`)
          console.log('[auto-launch:debug] launchItems=', JSON.stringify(s.launchItems))
        }
        return { enabled: true, devMode }
      }
    }

    // ---- 3. 注册表直查（只查本进程的项名）----
    if (process.platform === 'win32') {
      const reg = readAutoLaunchFromRegistry()
      if (process.env.NTR_DEBUG_AUTOLAUNCH) {
        console.log(`[auto-launch:debug] 第3级注册表直查 → ${reg === null ? 'null' : JSON.stringify(reg)}`)
      }
      if (reg != null) return { enabled: true, devMode }
    }

    return { enabled: false, devMode }
  } catch (e) {
    console.error('[auto-launch] 读取失败', e)
    return { enabled: false, devMode }
  }
}

/**
 * 直接从 Windows 注册表读自启项（Electron API 不可靠时的兜底）。
 *
 * ## 关键：项名必须与「写入时 Electron 用的项名」完全一致
 *
 * 写入时 Electron 用的项名是 `electron.app.<app.getName()>`。
 * 但 `app.getName()` 在开发模式（用 `electron .` 启动）下会取
 * package.json 的 **productName**（即 "Aria Player"），
 * 而不是 "Electron" —— 所以开发版与安装版**用的是同一个注册表项名**！
 *
 * 实测教训：本娘先前以为开发版项名是 `electron.app.Electron`，
 * 于是按 `app.getName()` 拼出的项名去查，结果在开发版下查到了
 * **安装版那条项**（因为两者同名），导致「明明关掉了自启却显示已开启」。
 *
 * ## 因此：兜底判据必须同时校验「路径指向本进程的可执行文件」
 *
 * 不能只看「项存在」，还要看项里的 exe 路径是不是当前进程的 execPath。
 * 否则开发版会误认安装版的自启项是自己的。
 *
 * @returns {string|null} 命令行字符串；未找到或不属于本进程时返回 null
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
    if (!m) return null
    const cmdline = m[1].trim()

    /**
     * 校验这条项是否指向**当前进程的可执行文件**。
     *
     * 为什么必须校验：开发版（`electron .`）与安装版可能共用同一个
     * 注册表项名（都取 productName），若不校验路径，开发版会把安装版的
     * 自启项当成自己的 → 关掉后仍显示「已开启」。
     *
     * 比较方式：把项里的可执行文件路径（去掉引号与参数）与
     * `process.execPath` 规范化后比较。开发版是 electron.exe 的绝对路径，
     * 安装版是 Aria Player.exe 的绝对路径，两者天然不同。
     */
    const exeInReg = cmdline.replace(/^"/, '').replace(/".*$/, '').trim().toLowerCase()
    const selfExe = process.execPath.toLowerCase()
    if (exeInReg !== selfExe) {
      if (process.env.NTR_DEBUG_AUTOLAUNCH) {
        console.log(`[auto-launch:debug] 注册表项存在但不属于本进程：`)
        console.log(`  项内 exe: ${exeInReg}`)
        console.log(`  本进程:   ${selfExe}`)
      }
      return null
    }
    return cmdline
  } catch {
    // reg query 在项不存在时以非 0 退出
    return null
  }
}

/** 本次启动是否由「开机自启 + 最小化」触发 */
export function isStartMinimized() {
  return process.argv.includes('--start-minimized')
}
