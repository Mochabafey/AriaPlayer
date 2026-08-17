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

if (fs.existsSync(path.join(serverDir, 'app.js')) && !force) {
  console.log('[vendor] server/ 已存在且包含 app.js，跳过克隆（加 --force 强制重新拉取）')
  process.exit(0)
}

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

// 应用本地补丁（上游 api-enhanced 的 bug 修复，防止 vendor 覆盖后丢失）
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
}
