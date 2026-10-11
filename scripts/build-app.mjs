// 可靠构建入口：走 electron-vite API 层，绕开 CLI 在部分 shell（Git Bash）下静默失败的问题。
delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.NODE_OPTIONS

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outRoot = path.resolve(__dirname, '..', 'dist', 'out')

/**
 * 构建前清空 dist/out —— **不是洁癖，是必须**。
 *
 * ## 为什么必须清
 *
 * Vite 每次产出**带内容 hash 的新文件名**，但 electron.vite.config.mjs 里
 * 三个进程都设了 `emptyOutDir: false`（避免互相清掉对方的产物），
 * 于是旧文件会一直累积。
 *
 * 累积到一定程度后，**打包版会加载到旧的入口 bundle**：
 *   - 症状：侧栏点击无反应、location.hash 变了但视图不切换（停在首页）
 *   - 实测：累积 16 个 index-*.js（assets 共 292 个文件）时必现
 *   - 迷惑点：**开发模式完全正常**（走 vite dev server，不读这些产物），
 *     所以只在打包版暴露，极易误判成「打包配置有问题」
 *
 * 清理后 assets 从 292 个文件降到 35 个，index-*.js 从 16 个降到 1 个。
 *
 * ## 为什么清整个 out 而不是只清 renderer
 *
 * 三个进程各写自己的子目录（out/main、out/preload、out/renderer），
 * 清空整个 out 目录不会互相干扰，且能顺带清掉改过入口名后的孤儿产物。
 * 清空是安全的：所有内容都由本次构建重新生成。
 */
function cleanOut() {
  if (!fs.existsSync(outRoot)) return
  const before = fs.readdirSync(outRoot, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).length
  fs.rmSync(outRoot, { recursive: true, force: true })
  console.log(`[build] 已清空 dist/out（移除 ${before} 个旧产物文件）`)
}

cleanOut()

const { build } = await import('electron-vite')
await build()
console.log('BUILD_OK')
