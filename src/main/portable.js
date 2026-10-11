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
import os from 'os'
import path from 'path'

/** 便携模式数据目录名（放在包装器 exe 同级） */
const DATA_DIR_NAME = 'AriaData'

/**
 * 显式禁用便携模式（逃生舱）。
 *
 * 设为 1 时无论环境变量如何都不启用 —— 用于排障，或用户明确想把数据
 * 放回系统目录（例如 U 盘太慢、想用本机 SSD）。
 */
function isPortableDisabledByUser() {
  return process.env.NTR_DISABLE_PORTABLE === '1'
}

/**
 * 判断当前进程是否**真的**由 NSIS 便携包装器启动。
 *
 * ## 为什么不能只看 PORTABLE_EXECUTABLE_DIR
 *
 * 单看环境变量有个现实风险：**变量泄漏**。任何以本应用为子进程启动的
 * 父进程（脚本、启动器、IDE 任务）都可能把该变量传下来，此时：
 *   - 安装版会把 userData 重定向到某个无关目录 → 用户看到「数据全没了」
 *   - 开发版同样错乱，且 `AriaData` 会建在莫名其妙的路径下
 *
 * 用户明确要求「便携模式不要在常规运行模式下开启」，所以判定必须收紧。
 *
 * ## 真便携版的独特特征
 *
 * NSIS 包装器把自己解压到 `%TEMP%\<随机名>\`，再从那里启动应用
 *（见 app-builder-lib/templates/nsis/portable.nsi 的 `StrCpy $INSTDIR "$TEMP\..."`）。
 * 因此**真正由包装器启动时，process.execPath 必然位于系统临时目录内**。
 *
 * 对比三种运行方式：
 *
 *   便携版    execPath = %TEMP%\<随机>\Aria Player.exe   ← 在临时目录 ✅
 *   安装版    execPath = C:\Program Files\Aria Player\...  ← 不在 ❌
 *   开发版    execPath = node_modules\electron\dist\...    ← 不在 ❌
 *
 * 所以「在临时目录内」是区分「真便携」与「变量泄漏」的关键判据。
 *
 * 补充校验 PORTABLE_EXECUTABLE_APP_FILENAME 与当前 exe 名一致 ——
 * 这是包装器注入的、表明「我准备启动哪个 exe」的字段，多一道保险。
 *
 * @returns {{ok: boolean, reason: string}}
 */
function detectRealPortable() {
  if (!process.env.PORTABLE_EXECUTABLE_DIR) {
    return { ok: false, reason: 'no-env' }
  }
  if (isPortableDisabledByUser()) {
    return { ok: false, reason: 'disabled-by-user' }
  }

  // 包装器 exe 所在目录必须真实存在
  const root = path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
  if (!fs.existsSync(root)) {
    return { ok: false, reason: 'root-missing' }
  }

  // 关键判据：当前进程必须运行在临时解压目录里
  const execPath = process.execPath
  let tmpReal = ''
  try {
    // 两侧都取 realpath：Windows 上 %TEMP% 可能是 8.3 短名或含符号链接，
    // 直接字符串比较会漏判（例如 C:\Users\RUNNER~1\... vs C:\Users\runneradmin\...）
    tmpReal = fs.realpathSync(os.tmpdir())
  } catch {
    tmpReal = os.tmpdir()
  }
  let execReal = execPath
  try {
    execReal = fs.realpathSync(execPath)
  } catch { /* 保留原值 */ }

  const norm = (p) => p.toLowerCase().replace(/[\\/]+$/, '')
  const inTemp = norm(execReal).startsWith(norm(tmpReal) + path.sep.toLowerCase())

  if (!inTemp) {
    return { ok: false, reason: 'exec-not-in-temp' }
  }

  // 补充：包装器声明的 app 文件名应与当前 exe 一致
  const declared = process.env.PORTABLE_EXECUTABLE_APP_FILENAME
  if (declared && path.basename(execReal).toLowerCase() !== declared.toLowerCase()) {
    return { ok: false, reason: 'app-filename-mismatch' }
  }

  return { ok: true, reason: 'ok' }
}

/**
 * 是否运行在便携版下。
 *
 * 采用**严格判定**：必须同时满足「环境变量存在」与「进程运行在临时解压目录」，
 * 以免变量泄漏到安装版/开发版时误启便携模式（详见 detectRealPortable）。
 */
export function isPortable() {
  return detectRealPortable().ok
}

/** 便携判定的详细结果（供日志与设置页解释「为何未启用」） */
export function portableDetection() {
  return detectRealPortable()
}

/** 便携版包装器 exe 所在目录；非便携模式返回 null */
export function portableRoot() {
  if (!isPortable()) return null
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
 * @returns {{portable: boolean, dataDir: string|null, ok: boolean, error: string|null, reason: string}}
 */
export function setupPortableMode() {
  const det = detectRealPortable()
  if (!det.ok) {
    // 变量存在但判定不通过 → 记一行日志，便于排查「为什么没进便携模式」
    if (det.reason !== 'no-env') {
      console.log(
        '[portable] 检测到 PORTABLE_EXECUTABLE_DIR 但未启用便携模式（%s）',
        det.reason
      )
      console.log('[portable]   execPath =', process.execPath)
      console.log('[portable]   声明目录 =', process.env.PORTABLE_EXECUTABLE_DIR)
      console.log('[portable]   临时目录 =', os.tmpdir())
      console.log('[portable]   说明：仅当程序确实运行于临时解压目录（真便携版）才启用，')
      console.log('[portable]         以免环境变量泄漏到安装版/开发版时误重定向数据目录')
    }
    return { portable: false, dataDir: null, ok: true, error: null, reason: det.reason }
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
    return { portable: true, dataDir, ok: true, error: null, reason: 'ok' }
  } catch (e) {
    // 便携目录不可写（只读介质等）→ 退回系统 userData，功能不受影响，
    // 只是数据不随身带。不弹窗打断启动，由设置页展示状态。
    console.error('[portable] 便携目录不可用，回退系统目录:', e.message)
    return { portable: true, dataDir, ok: false, error: e.message, reason: 'dir-unwritable' }
  }
}

/** 便携模式状态（供设置页 / 关于信息展示） */
export function portableStatus() {
  const det = detectRealPortable()
  const portable = det.ok
  const dataDir = portableDataDir()
  // 已启用 = userData 确实指向便携目录（排除回退的情况）
  const active = portable && app.getPath('userData') === dataDir
  return {
    portable,
    active,
    dataDir,
    exeDir: portableRoot(),
    userData: app.getPath('userData'),
    /**
     * 未启用时的原因，供设置页解释：
     *   no-env              没这个环境变量（正常安装版/开发版）
     *   exec-not-in-temp    变量在但进程不在临时目录 → 变量泄漏，已拒绝
     *   root-missing        声明的目录不存在
     *   app-filename-mismatch  声明的 exe 名与当前不符
     *   disabled-by-user    用户显式用 NTR_DISABLE_PORTABLE=1 关掉
     */
    reason: det.reason
  }
}
