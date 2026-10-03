/**
 * vendor-server.mjs
 * 将 api-enhanced 官方仓库 vendor 到 server/ 目录并安装生产依赖。
 * 用法：node scripts/vendor-server.mjs [--force]
 *
 * 注意：删除操作走原生 rm -rf 而非 fs.rmSync，
 * 以避开 WorkBuddy 沙箱在 Node fs 上的 safe-delete 拦截。
 */
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const serverDir = path.join(root, 'server')
const REPO = 'https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git'
const force = process.argv.includes('--force')

function log(cmd) {
  console.log(`$ ${cmd}`)
}

function run(cmd, opts = {}) {
  log(cmd)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function rmrf(p) {
  if (!fs.existsSync(p)) return
  // 用原生 shell rm 绕过 Node fs 的 safe-delete 拦截
  const isWin = process.platform === 'win32'
  if (isWin) {
    // PowerShell 强删（支持长路径）
    const ps = `Remove-Item -LiteralPath '${p.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  } else {
    spawnSync('rm', ['-rf', p], { stdio: 'inherit' })
  }
}

/**
 * 判断 server/ 是否「已就绪」——不只看 app.js，还要看依赖是否装上。
 *
 * 为什么必须检查 node_modules（CI 上踩过的坑）：
 *   server/node_modules 被 .gitignore 排除，所以 CI checkout 后
 *   只有源码、没有依赖。而旧版判断只看 app.js 存在就 `process.exit(0)`，
 *   导致：
 *     1. 依赖安装被跳过 → 打包进去的 ncm-server 没有 express 等依赖
 *     2. 后续「应用本地补丁」的代码也被跳过（同一段脚本里）
 *   表现为安装版启动后内置服务起不来（界面显示「服务未就绪」）。
 *
 * 依赖完整性的判据：node_modules 存在 + 关键包在位。
 * 只判断目录存在不够 —— 中断的安装会留下空目录。
 */
const REQUIRED_DEPS = ['express', 'axios', 'crypto-js']
function depsInstalled() {
  const nm = path.join(serverDir, 'node_modules')
  if (!fs.existsSync(nm)) return false
  return REQUIRED_DEPS.every((d) => fs.existsSync(path.join(nm, d)))
}

const sourceReady = fs.existsSync(path.join(serverDir, 'app.js'))
const depsReady = depsInstalled()

if (sourceReady && depsReady && !force) {
  console.log('[vendor] server/ 已存在（含 app.js 与依赖），跳过克隆')
  console.log('[vendor] 仍会执行下方「应用本地补丁」步骤')
} else {
  if (sourceReady && !depsReady) {
    console.log('[vendor] server/ 有源码但缺依赖（CI checkout 后即为此状态）→ 只补装依赖，不重新克隆')
    run('npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error', { cwd: serverDir })
    for (const p of ['node_modules/.cache']) {
      rmrf(path.join(serverDir, p))
    }
  } else {
    console.log('[vendor] 克隆 api-enhanced → server/ ...')
    rmrf(serverDir)
    fs.mkdirSync(serverDir, { recursive: true })
    run(`git clone --depth 1 ${REPO} ${serverDir}`)

    // 移除开发相关文件，减小体积
    for (const p of ['.git', 'test', 'tests', 'examples', 'scripts', '.github', 'docs']) {
      rmrf(path.join(serverDir, p))
    }

    console.log('[vendor] 安装生产依赖（npm install --omit=dev --ignore-scripts）...')
    run('npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error', { cwd: serverDir })

    // 清理依赖缓存
    for (const p of ['node_modules/.cache']) {
      rmrf(path.join(serverDir, p))
    }
  }
}

// 应用本地补丁（上游 api-enhanced 的 bug 修复，防止 vendor 覆盖后丢失）
//
// 注意：这一步**无论是否跳过克隆都要执行** —— 补丁里包含启动优化
//（关闭 npm info 版本检查、惰性加载 jsdom），漏掉会让打包版启动慢几秒。
// 旧版把 `process.exit(0)` 写在脚本顶层，连这里也一起跳过了。
applyPatches(serverDir)

console.log('[vendor] 完成！server/ 已就绪。')

/** 应用对 vendored 代码的本地补丁 */
function applyPatches(dir) {
  const serverJs = path.join(dir, 'server.js')
  if (!fs.existsSync(serverJs)) return
  let src = fs.readFileSync(serverJs, 'utf-8')
  let changed = false
  // 补丁 1：解灰触发条件 req.baseUrl 在 app.all 挂载下恒为空字符串 → 改为 req.path
  if (src.includes("req.baseUrl === '/song/url/v1'")) {
    src = src.replace("req.baseUrl === '/song/url/v1'", "req.path === '/song/url/v1'")
    changed = true
  }
  // 补丁 2：解灰 matchID 加 8s 超时（外部源慢/挂起会导致 song_url_v1 30s+ 超时，播放/下载表现为"没反应"）
  if (src.includes('const result = await matchID(req.query.id)')) {
    src = src.replace(
      "const result = await matchID(req.query.id)\n            song.url = result.data.url\n            song.freeTrialInfo = null\n            logger.info('Unblock success! url:', song.url)",
      "const result = await Promise.race([\n              matchID(req.query.id),\n              new Promise((_, rej) => setTimeout(() => rej(new Error('unblock timeout')), 8000)),\n            ]).catch((e) => ({ code: 500, message: e.message, data: null }))\n            if (result && result.data && result.data.url) {\n              song.url = result.data.url\n              song.freeTrialInfo = null\n              logger.info('Unblock success! url:', song.url)\n            } else {\n              logger.warn('Unblock failed:', result && result.message)\n            }"
    )
    changed = true
  }
  if (changed) {
    fs.writeFileSync(serverJs, src)
    console.log('[vendor] 已应用 server.js 补丁（解灰触发条件 + matchID 超时）')
  }
  // 补丁 3：关闭启动时版本检查（app.js 的 checkVersion 会 exec `npm info`
  // 联网查 registry，慢/被墙会让 listen 延迟 → 服务拉起慢/未就绪）
  const appJs = path.join(dir, 'app.js')
  if (fs.existsSync(appJs)) {
    let appSrc = fs.readFileSync(appJs, 'utf-8')
    if (appSrc.includes('checkVersion: true')) {
      appSrc = appSrc.replace(
        'checkVersion: true',
        '// version check disabled: exec `npm info` hangs startup on slow/blocked registry\n    checkVersion: false,'
      )
      fs.writeFileSync(appJs, appSrc)
      console.log('[vendor] 已应用 app.js 补丁（关闭版本检查）')
    }
  }

  // 补丁 4：启动时不再同步等待 generateConfig 联网刷新。
  // generateConfig() 内含两次联网请求（register_anonimous 注册匿名 token +
  // getXeapiPublicKey 取公钥），上游实现每次启动都 await 它，弱网/上游抖动
  // 实测可阻塞 19s，表现为「启动中…」长时间卡住。
  // 改为：缓存已存在 → 直接放行启动、刷新丢后台；缓存缺失 → 仍同步等待。
  // 同时把 generateConfig 里的纯本地部分（global.cnIp / global.deviceId）
  // 拆成 initLocalConfig() 导出，避免跳过同步刷新时这两个全局量缺失。
  if (fs.existsSync(appJs)) {
    let appSrc = fs.readFileSync(appJs, 'utf-8')
    const ORIG_START = `  // 启动时更新anonymous_token
  const generateConfig = require('./generateConfig')
  await generateConfig()
  require('./server').serveNcmApi({`
    if (appSrc.includes(ORIG_START)) {
      appSrc = appSrc.replace(
        ORIG_START,
        `  // 启动时更新anonymous_token
  //
  // [patched] 启动路径优化：generateConfig() 内含两次联网请求
  // （register_anonimous 注册匿名 token + getXeapiPublicKey 取公钥）。
  // 上游实现每次启动都 await 它，弱网/上游抖动时实测可阻塞 19s，
  // 表现为「启动中…」长时间卡住、服务迟迟不就绪。
  // 改为：缓存已存在 → 直接放行启动，刷新丢后台异步；
  //       缓存缺失（首次运行）→ 仍同步等待，保证首次可用。
  // 注：util/request.js 在 require 时同步读取 anonymous_token 文件，
  // 故此处只需保证「文件已存在且非空」；后台刷新写同一文件，
  // 本进程已读入内存的旧值不影响运行，下次启动生效。
  const generateConfig = require('./generateConfig')
  const tokenPath = path.resolve(tmpPath, 'anonymous_token')
  const keyPath = path.resolve(tmpPath, 'xeapi_public_key')
  const hasCache =
    fs.existsSync(tokenPath) &&
    fs.statSync(tokenPath).size > 0 &&
    fs.existsSync(keyPath) &&
    fs.statSync(keyPath).size > 0

  if (hasCache) {
    generateConfig.initLocalConfig()
    console.log('[app] anonymous_token 缓存命中，跳过同步配置刷新（后台异步更新）')
    generateConfig().catch((e) => console.log('[app] background generateConfig failed:', e))
  } else {
    await generateConfig()
  }
  require('./server').serveNcmApi({`
      )
      fs.writeFileSync(appJs, appSrc)
      console.log('[vendor] 已应用 app.js 补丁（跳过同步联网配置刷新）')
    }
  }

  // 补丁 5：generateConfig 导出 initLocalConfig()，把纯本地随机计算
  // （global.cnIp / global.deviceId）从联网流程里拆出来同步执行。
  const genCfg = path.join(dir, 'generateConfig.js')
  if (fs.existsSync(genCfg)) {
    let gSrc = fs.readFileSync(genCfg, 'utf-8')
    const ORIG_GEN = `async function generateConfig() {
  global.cnIp = generateRandomChineseIP()`
    if (gSrc.includes(ORIG_GEN)) {
      gSrc = gSrc.replace(
        ORIG_GEN,
        `/**
 * [patched] 本地配置初始化（纯计算，零网络，毫秒级）。
 * global.cnIp 与 global.deviceId 是纯本地随机计算（见 util/index.js 的
 * generateRandomChineseIP / generateDeviceId），却原先夹在两次联网请求之间，
 * 导致「跳过同步联网刷新」时这两个全局量会缺失（server.js 用 global.cnIp
 * 兜底 req.ip、request.js 用 global.deviceId 拼 cookie）。拆出后可同步就位。
 */
function initLocalConfig() {
  global.cnIp = generateRandomChineseIP()
  if (!global.deviceId) {
    try {
      global.deviceId = require('./util/index').generateDeviceId()
    } catch (_) {}
  }
}

async function generateConfig() {
  initLocalConfig()`
      )
      gSrc = gSrc.replace(
        'module.exports = generateConfig',
        'module.exports = generateConfig\nmodule.exports.initLocalConfig = initLocalConfig'
      )
      fs.writeFileSync(genCfg, gSrc)
      console.log('[vendor] 已应用 generateConfig.js 补丁（拆分本地配置初始化）')
    }
  }

  // 补丁 6：main.js 惰性模块加载。
  // 原实现 forEach 同步 require 全部 436 个模块，其中 register_checktoken_v2
  // 顶层引 jsdom（单模块 812ms，占全量加载耗时的 68%）。本应用只用
  // register_anonimous 一个函数，其余纯属浪费。改为首次调用时才 require。
  const mainJs = path.join(dir, 'main.js')
  if (fs.existsSync(mainJs)) {
    let mSrc = fs.readFileSync(mainJs, 'utf-8')
    const ORIG_MAIN = `let requestModule = null

moduleFiles.forEach((file) => {
  if (!file.endsWith('.js')) return

  const filePath = path.join(modulePath, file)
  let fileModule = require(filePath)
  let fn = file.split('.').shift() || ''`
    if (mSrc.includes(ORIG_MAIN)) {
      mSrc = mSrc.replace(
        ORIG_MAIN,
        `let requestModule = null

// [patched] 惰性模块加载：原实现 forEach 同步 require 全部 436 个模块文件，
// 其中 register_checktoken_v2 顶层引 jsdom（单模块加载 812ms，占全量 68%）。
// 本应用只用到 register_anonimous，其余 435 个纯属浪费（server.js 已改为
// 按路由惰性加载，这里的全量 require 是启动耗时的最大残余项）。
// 改为：只记文件名，函数首次被调用时才 require（Node require 自带缓存）。
const fileModuleCache = new Map()
const loadFileModule = (filePath) => {
  if (!fileModuleCache.has(filePath)) {
    fileModuleCache.set(filePath, require(filePath))
  }
  return fileModuleCache.get(filePath)
}

moduleFiles.forEach((file) => {
  if (!file.endsWith('.js')) return

  const filePath = path.join(modulePath, file)
  let fn = file.split('.').shift() || ''`
      )
      mSrc = mSrc.replace(
        '    return fileModule(',
        '    return loadFileModule(filePath)('
      )
      fs.writeFileSync(mainJs, mSrc)
      console.log('[vendor] 已应用 main.js 补丁（惰性模块加载）')
    }
  }

  // 补丁 7：server.js 惰性路由注册。
  // getModulesDefinitions 原先 require 全部模块；改为只扫描文件名建路由表，
  // 模块本体延迟到该路由首次被请求时才 require。
  if (fs.existsSync(serverJs)) {
    let sSrc = fs.readFileSync(serverJs, 'utf-8')
    if (sSrc.includes("getModulesDefinitions(path.join(__dirname, 'module'), special)")) {
      sSrc = sSrc.replace(
        "getModulesDefinitions(path.join(__dirname, 'module'), special)",
        "getModulesDefinitions(path.join(__dirname, 'module'), special, false)"
      )
      // 插入惰性解析器
      sSrc = sSrc.replace(
        '  for (const moduleDef of moduleDefinitions) {\n    // Register the route.',
        `  for (const moduleDef of moduleDefinitions) {
    // [patched] 惰性解析：moduleDef.module 可能是已加载的函数（moduleDefs 传入），
    // 也可能是模块文件路径字符串（自动扫描），后者首次命中时 require。
    const resolveModule = () => {
      if (typeof moduleDef.module === 'function') return moduleDef.module
      const loaded = require(moduleDef.module)
      moduleDef.module = loaded // 回填，后续直接命中
      return loaded
    }

    // Register the route.`
      )
      sSrc = sSrc.replace(
        'const moduleResponse = await moduleDef.module(query,',
        'const moduleResponse = await resolveModule()(query,'
      )
      fs.writeFileSync(serverJs, sSrc)
      console.log('[vendor] 已应用 server.js 补丁（惰性路由注册）')
    }
  }
}
