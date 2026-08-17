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
  const ps = `Remove-Item -LiteralPath '${p.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
}

if (fs.existsSync(path.join(dir, 'src', 'app.ts')) && !force) {
  console.log('[vendor-qqmusic] qqmusic/ 已存在且含 src/app.ts，跳过克隆（加 --force 强制重拉）')
  process.exit(0)
}

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
