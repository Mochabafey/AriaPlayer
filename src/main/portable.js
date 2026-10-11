/**
 * 便携模式（Portable Mode）
 *
 * electron-builder 的 portable target 是一个自解压 NSIS 包装器：运行时把应用
 * 解包到 %TEMP%，再把真正的 exe 跑起来，同时注入三个环境变量（见
 * node_modules/app-builder-lib/templates/nsis/portable.nsi）：
 *
 *   PORTABLE_EXECUTABLE_DIR   包装器 exe 所在目录（**用户真正看到的位置**，如 U 盘根）
 *   PORTABLE_EXECUTABLE_FILE  包装器 exe 的完整路径
 *   PORTABLE_EXECUTABLE_APP_FILENAME  应用可执行文件名
 *
 * ## 为什么必须处理
 *
 * 不处理的话，所有数据都落在 `%APPDATA%\Aria Player`（app.getPath('userData')）：
 *   - 换台电脑插上 U 盘 = 曲库/歌单/设置全空，失去「便携」的意义
 *   - 会在别人机器上留垃圾（音频缓存上限 8GB）
 *   - 与已安装版**共用同一个 userData** → requestSingleInstanceLock 判重冲突，
 *     便携版启动会把安装版窗口唤到前台，自己静默退出
 *
 * ## 调用时机（很关键）
 *
 * `app.setPath('userData', ...)` 必须在 **app ready 之前**调用，且要在任何
 * 模块读取 `app.getPath('userData')` 之前。因此本模块在 main/index.js 顶部
 * 作为副作用导入（见该文件第一条 import），而不是在 whenReady 里调用。
 *
 * 注意 settings.js 的 DEFAULTS 里有 `app.getPath('music')`，它在模块求值时
 * 就会执行 —— 那个不是 userData，不受影响；但 downloadDir 的便携默认值需要
 * 在 settings 层单独处理（见 db/settings.js 的 portableDefaults）。
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/** 便携模式数据目录名（放在包装器 exe 同级） */
const DATA_DIR_NAME = 'AriaData'

/**
 * 是否运行在便携版下。
 *
 * 判据是 electron-builder 注入的 PORTABLE_EXECUTABLE_DIR —— 只有 portable
 * target 会设置它，安装版与开发模式都没有，因此不会误判。
 */
export function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR
}

/** 便携版包装器 exe 所在目录；非便携模式返回 null */
export function portableRoot() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  return dir ? path.resolve(dir) : null
}

/** 便携模式的数据目录（<exe 同级>/AriaData）；非便携模式返回 null */
export function portableDataDir() {
  const root = portableRoot()
  return root ? path.join(root, DATA_DIR_NAME) : null
}

/**
 * 尝试启用便携模式。必须在 app ready 前调用。
 *
 * @returns {{portable: boolean, dataDir: string|null, ok: boolean, error: string|null}}
 */
export function setupPortableMode() {
  if (!isPortable()) {
    return { portable: false, dataDir: null, ok: true, error: null }
  }

  const dataDir = portableDataDir()
  try {
    fs.mkdirSync(dataDir, { recursive: true })

    // 写权限自检：U 盘写保护 / 只读挂载 / 企业管控目录 都要在这里失败，
    // 而不是等到运行中 SQLite 打不开才报错。探测文件用完即删。
    const probe = path.join(dataDir, '.write-probe')
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)

    app.setPath('userData', dataDir)
    // sessionData 默认跟随 userData，但显式设置避免 Electron 版本差异
    app.setPath('sessionData', dataDir)
    return { portable: true, dataDir, ok: true, error: null }
  } catch (e) {
    // 便携目录不可写（只读介质等）→ 退回系统 userData，功能不受影响，
    // 只是数据不随身带。不弹窗打断启动，由设置页展示状态。
    console.error('[portable] 便携目录不可用，回退系统目录:', e.message)
    return { portable: true, dataDir, ok: false, error: e.message }
  }
}

/** 便携模式状态（供设置页 / 关于信息展示） */
export function portableStatus() {
  const portable = isPortable()
  const dataDir = portableDataDir()
  // 已启用 = userData 确实指向便携目录（排除回退的情况）
  const active = portable && app.getPath('userData') === dataDir
  return {
    portable,
    active,
    dataDir,
    exeDir: portableRoot(),
    userData: app.getPath('userData')
  }
}
