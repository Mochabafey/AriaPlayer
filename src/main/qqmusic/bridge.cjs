#!/usr/bin/env node
/**
 * qq-music-api 私有通道入口（子进程侧）。
 *
 * 拦截 net.Server.prototype.listen，把 qqmusic 的 Koa 服务整体重定向到
 * Named Pipe（Windows）/ Unix Domain Socket（macOS/Linux）：
 *   - 零 TCP 端口占用，不存在端口冲突/被抢导致瘫痪的问题
 *   - 系统级私有通道：本机其他进程无法访问
 *   - qqmusic 源码零改动，升级 vendor 不受影响
 */
const fs = require('fs')
const net = require('net')
const path = require('path')

const SOCKET_PATH = process.env.NTR_QQMUSIC_SOCKET
const APP_ENTRY = process.env.NTR_QQMUSIC_ENTRY
if (!SOCKET_PATH || !APP_ENTRY) {
  console.error('[qqmusic-bridge] missing NTR_QQMUSIC_SOCKET / NTR_QQMUSIC_ENTRY')
  process.exit(1)
}

const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  this.on('connection', (socket) => {
    try {
      Object.defineProperty(socket, 'remoteAddress', {
        get: () => '127.0.0.1',
        configurable: true
      })
    } catch { /* ignore */ }
  })
  let cb = null
  for (const a of args) if (typeof a === 'function') cb = a
  if (SOCKET_PATH.includes('/')) {
    try { fs.rmSync(SOCKET_PATH, { force: true }) } catch { /* ignore */ }
  }
  return origListen.call(this, SOCKET_PATH, () => {
    console.log('[qqmusic-bridge] private socket ready:', SOCKET_PATH)
    cb && cb()
  })
}

// 入口选择：优先用 esbuild 预编译产物，缺失时回退 ts-node 实时编译。
//
// 为什么优先预编译：ts-node 要实时编译 92 个 TS 文件，实测冷启动
// ~4900ms（首次）/ ~1100ms（二次）；预编译产物只要 ~380ms。
// 产物由 scripts/build-qqmusic.mjs 生成（vendor 流程里会自动跑）。
//
// 回退 ts-node 是为了「产物缺失时仍能用」—— 例如开发者手动改了源码
// 还没重新构建，或 vendor 流程被中断。宁可慢一点也不要起不来。
const qqmusicRoot = process.cwd()
// ts-node 在 qqmusic/node_modules/ 下，bridge 自身在 src/main/qqmusic/，
// require 从 bridge 所在目录开始解析，找不到 cwd 里的 node_modules，
// 需要手动把 qqmusic/node_modules 加入搜索路径
module.paths.unshift(path.join(qqmusicRoot, 'node_modules'))

const prebuilt = path.join(qqmusicRoot, 'dist', 'app.cjs')
if (fs.existsSync(prebuilt)) {
  console.log('[qqmusic-bridge] 使用预编译产物 dist/app.cjs')
  require(prebuilt)
} else {
  console.log('[qqmusic-bridge] 未找到预编译产物，回退 ts-node 实时编译（较慢）')
  console.log('[qqmusic-bridge]   提示：运行 node scripts/build-qqmusic.mjs 可预编译')
  require('ts-node').register({
    transpileOnly: true,
    project: path.join(qqmusicRoot, 'tsconfig.json')
  })
  require(APP_ENTRY)
}