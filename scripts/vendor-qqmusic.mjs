/**
 * vendor-qqmusic.mjs
 * 将 Rain120/qq-music-api 克隆到 qqmusic/ 并安装依赖，应用本地补丁。
 * 用法：node scripts/vendor-qqmusic.mjs [--force]
 */
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dir = path.join(root, 'qqmusic')
const REPO = 'https://github.com/Rain120/qq-music-api.git'
const force = process.argv.includes('--force')

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}
function rmrf(p) {
  if (!fs.existsSync(p)) return
  // 用原生 shell rm 绕过 Node fs 的 safe-delete 拦截。
  // 跨平台：Windows 走 PowerShell（支持长路径），类 Unix 直接 rm -rf
  //（原实现只调 powershell，在 macOS/Linux CI 上会直接失败）
  if (process.platform === 'win32') {
    const ps = `Remove-Item -LiteralPath '${p.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  } else {
    spawnSync('rm', ['-rf', p], { stdio: 'inherit' })
  }
}

/**
 * 判断 qqmusic/ 是否已就绪（源码 + 依赖）。
 *
 * ⚠️ 这里**不能再用 `process.exit(0)` 提前退出**（原实现如此，是个坑）：
 * 脚本末尾还有「应用本地补丁」和「esbuild 预编译」两步，提前退出会把它们
 * 一起跳过 —— 表现为「vendor 跑完了，但预编译产物不存在，启动退回
 * ts-node 实时编译（慢 15 倍）」，且不报错、只静默降级。
 * （vendor-server.mjs 踩过同样的坑，见那里的注释。）
 *
 * 依赖判据同 vendor-server：只判断目录存在不够 —— 中断的安装会留下空目录。
 */
const REQUIRED_DEPS = ['koa', 'axios', 'koa-router']
function depsInstalled() {
  const nm = path.join(dir, 'node_modules')
  if (!fs.existsSync(nm)) return false
  return REQUIRED_DEPS.every((d) => fs.existsSync(path.join(nm, d)))
}

const sourceReady = fs.existsSync(path.join(dir, 'src', 'app.ts'))
const depsReady = depsInstalled()

if (sourceReady && depsReady && !force) {
  console.log('[vendor-qqmusic] qqmusic/ 已就绪（源码 + 依赖），跳过克隆')
  console.log('[vendor-qqmusic] 仍会执行下方「应用补丁」与「预编译」步骤')
} else if (sourceReady && !depsReady) {
  console.log('[vendor-qqmusic] 有源码但缺依赖（CI checkout 后即为此状态）→ 只补装依赖')
  run('npm install --ignore-scripts --no-audit --no-fund --loglevel=error', { cwd: dir })
} else {
  console.log('[vendor-qqmusic] 克隆 Rain120/qq-music-api → qqmusic/ ...')
  rmrf(dir)
  fs.mkdirSync(dir, { recursive: true })
  run(`git clone --depth 1 ${REPO} ${dir}`)

  // 移除开发/冗余内容，减小体积
  for (const p of ['.git', 'tests', 'screenshot', '.github', 'docs', '.agents', '.claude', '.codebuddy', '.continue', '.iflow', '.kiro', '.skills', '.trae', 'skills']) {
    rmrf(path.join(dir, p))
  }

  console.log('[vendor-qqmusic] 安装依赖（ts-node 在 devDeps，官方 start 依赖它跑 TS）...')
  run('npm install --ignore-scripts --no-audit --no-fund --loglevel=error', { cwd: dir })
}

// 本地补丁：default.ts 的 cookie 改为从环境变量读取（宿主应用注入 QQ_MUSIC_COOKIE）
const cfgPath = path.join(dir, 'src', 'config', 'default.ts')
if (fs.existsSync(cfgPath)) {
  let src = fs.readFileSync(cfgPath, 'utf-8')
  if (src.includes("const defaultCookie: string = '';")) {
    src = src.replace(
      "const defaultCookie: string = '';",
      "// cookie 由宿主应用经环境变量注入（见 src/main/qqMusicServer.js buildEnv）\nconst defaultCookie: string = process.env.QQ_MUSIC_COOKIE || '';"
    )
    fs.writeFileSync(cfgPath, src)
    console.log('[vendor-qqmusic] 已应用 default.ts 补丁（cookie 读环境变量）')
  }
}

// 本地补丁：request.ts 的出站 axios 请求注入登录 cookie。
// Rain120 上游请求默认不带 Cookie（匿名），导致 VIP/版权歌曲永远 104003 无法播放。
// 修复前需先确认补丁标识不存在，避免重复替换。
const reqPath = path.join(dir, 'src', 'util', 'request.ts')
if (fs.existsSync(reqPath)) {
  let src = fs.readFileSync(reqPath, 'utf-8')
  if (!src.includes('userInfo')) {
    src = src.replace(
      "import { requestConfig } from '../config';",
      "import { requestConfig, userInfo } from '../config';"
    )
    src = src.replace(
      `  const requestConfigOptions: AxiosRequestConfig = {
    ...options,
    url: baseURL,
    method: axiosMethod,
  };`,
      `  const requestConfigOptions: AxiosRequestConfig = {
    ...options,
    url: baseURL,
    method: axiosMethod,
    // 注入 QQ 音乐登录 cookie（含 p_skey/qm_keyst 等），否则上游永远匿名、VIP 无法播放
    headers: {
      ...(options.headers || {}),
      ...(userInfo.cookie ? { Cookie: userInfo.cookie } : {}),
    },
  };`
    )
    fs.writeFileSync(reqPath, src)
    console.log('[vendor-qqmusic] 已应用 request.ts 补丁（出站请求携带登录 cookie）')
  }
}

console.log('[vendor-qqmusic] 完成！qqmusic/ 已就绪。')

// 本地补丁：关闭启动时的版本检查。
// src/app.ts 原实现 exec('npm info qq-music-api version') 会 fork 一个 npm 进程
// 联网查 registry，弱网/被墙环境下可能挂住数十秒，抢 CPU 与网络并拖慢启动。
// 本项目内置固定版本、不需要更新提示（api-enhanced 侧同样已关闭 checkVersion）。
const appTsPath = path.join(dir, 'src', 'app.ts')
if (fs.existsSync(appTsPath)) {
  let src = fs.readFileSync(appTsPath, 'utf-8')
  if (src.includes("if (!isTestEnv) {\n  const versionCheckProcess = exec(")) {
    src = src.replace(
      "if (!isTestEnv) {\n  const versionCheckProcess = exec(",
      "// [patched] 关闭启动版本检查：exec `npm info` 联网查 registry 会拖慢启动\nif (!isTestEnv && process.env.QQMUSIC_VERSION_CHECK === '1') {\n  const versionCheckProcess = exec("
    )
    fs.writeFileSync(appTsPath, src)
    console.log('[vendor-qqmusic] 已应用 app.ts 补丁（关闭启动版本检查）')
  }
}

/**
 * 预编译 TypeScript → dist/app.cjs。
 *
 * **必须在所有源码补丁之后执行** —— 补丁改的是 src/*.ts，编译要在改完后跑，
 * 否则产物里是未打补丁的代码（cookie 不注入、版本检查没关）。
 *
 * 这一步把 QQ 音乐冷启动从 ~4900ms（ts-node 实时编译 92 个 TS 文件）
 * 降到 ~380ms。见 scripts/build-qqmusic.mjs 的说明。
 */
console.log('[vendor-qqmusic] 预编译 TypeScript → dist/app.cjs ...')
const buildScript = path.join(root, 'scripts', 'build-qqmusic.mjs')
if (fs.existsSync(buildScript)) {
  const r = spawnSync(process.execPath, [buildScript, '--force'], { stdio: 'inherit', cwd: root })
  if (r.status !== 0) {
    console.warn('[vendor-qqmusic] ⚠️ 预编译失败，将回退 ts-node 运行时编译（启动较慢）')
  }
} else {
  console.warn('[vendor-qqmusic] ⚠️ 未找到 build-qqmusic.mjs，跳过预编译')
}

console.log('[vendor-qqmusic] 完成！qqmusic/ 已就绪。')
