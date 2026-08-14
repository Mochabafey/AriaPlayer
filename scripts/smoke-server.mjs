/**
 * smoke-server.mjs
 * 端到端烟测入口：确保 server/ 已 vendor → 构建三进程 → 以 NCM_SMOKE=1 启动 electron，期望输出 SMOKE_OK。
 *
 * 相比 package.json 里的 shell 链（cross-env-shell NCM_SMOKE=1 electron . --disable-gpu）：
 *  - 强制清除 ELECTRON_RUN_AS_NODE（本机/沙箱残留会让 electron 以纯 Node 模式启动 → 直接挂）
 *  - 沙箱环境默认带 --no-sandbox（WorkBuddy 下无沙箱权限必挂）
 */
import { spawnSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// 关键：Electron 主进程绝不能继承 ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_RUN_AS_NODE

if (!fs.existsSync(path.join(root, 'server', 'app.js'))) {
  console.log('[smoke] 未找到 server/，先执行 vendor...')
  spawnSync('node', ['scripts/vendor-server.mjs'], { stdio: 'inherit', cwd: root })
}

console.log('[smoke] 构建三进程...')
// 走 API 层 wrapper（Git Bash 下直接调 electron-vite CLI 会静默失败）
spawnSync('node', ['scripts/build-app.mjs'], { stdio: 'inherit', cwd: root })

console.log('[smoke] 启动 NCM_SMOKE=1 electron（期望 SMOKE_OK status=ready）...')
process.env.NCM_SMOKE = '1'
// Windows GUI 程序 stdout 在部分终端/管道下不可见，用 --enable-logging 让输出走 stderr
spawn('node_modules/electron/dist/electron.exe', ['.', '--disable-gpu', '--no-sandbox', '--enable-logging'], {
  stdio: 'inherit',
  cwd: root
})
