/**
 * dev-server.mjs
 * 开发模式入口：确保 server/ 已 vendor，然后用 electron-vite 的 createServer API 启动 dev。
 *
 * 为什么不用 `npx electron-vite dev`：
 *  - 本机（Git Bash / WorkBuddy 沙箱）下 electron-vite 的 CLI 层（bin/electron-vite.js）
 *    会静默失败——build/dev 都不产出，但 API 层（import('electron-vite')）完全正常。
 *  - 故 dev / build / smoke / pack 统一走 API 层 wrapper，见 scripts/build-app.mjs。
 *
 * 环境坑：某些环境（如 WorkBuddy 会话）会设 ELECTRON_RUN_AS_NODE=1，
 * 让 Electron 以纯 Node 模式运行、require('electron') 返回路径字符串 → 应用无法启动。此处强制清除。
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// 关键：Electron 主进程绝不能继承 ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_RUN_AS_NODE

if (!fs.existsSync(path.join(root, 'server', 'app.js'))) {
  console.log('[dev] 未找到 server/，先执行 vendor...')
  spawnSync('node', ['scripts/vendor-server.mjs'], { stdio: 'inherit', cwd: root })
}

console.log('[dev] 启动 electron-vite dev（createServer API，绕开 CLI 静默失败）...')
// 支持透传 electron 启动参数：NCM_ELECTRON_ARGS="-- --disable-gpu --no-sandbox"
// （electron-vite 通过 ELECTRON_CLI_ARGS JSON 数组读取）
const electronArgs = (process.env.NCM_ELECTRON_ARGS || '').trim()
if (electronArgs) {
  process.env.ELECTRON_CLI_ARGS = JSON.stringify(electronArgs.split(/\s+/).filter(Boolean))
}
const { createServer } = await import('electron-vite')
await createServer({}, { rendererOnly: false })
