/**
 * dev-server.mjs
 * 开发模式入口：确保 server/ 已 vendor，然后启动 electron-vite dev。
 *
 * 注意：某些环境（如 WorkBuddy 会话）会在全局环境里设置 ELECTRON_RUN_AS_NODE=1，
 * 这会让 Electron 以纯 Node 模式运行、require('electron') 返回路径字符串，
 * 应用完全无法启动。此处强制清除该变量。
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// 关键：Electron 主进程绝不能继承 ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_RUN_AS_NODE

if (!fs.existsSync(path.join(root, 'server', 'app.js'))) {
  console.log('[dev] 未找到 server/，先执行 vendor...')
  execSync('node scripts/vendor-server.mjs', { stdio: 'inherit', cwd: root })
}

console.log('[dev] 启动 electron-vite dev（api-enhanced 由主进程自动拉起）...')
execSync('npx electron-vite dev', { stdio: 'inherit', cwd: root })
