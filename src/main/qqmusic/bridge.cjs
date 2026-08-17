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

// 注册 ts-node 以加载 TypeScript 源码
// ts-node 在 qqmusic/node_modules/ 下，bridge 自身在 src/main/qqmusic/，
// require 从 bridge 所在目录开始解析，找不到 cwd 里的 node_modules，
// 需要手动把 qqmusic/node_modules 加入搜索路径
const qqmusicRoot = process.cwd()
module.paths.unshift(require('path').join(qqmusicRoot, 'node_modules'))
require('ts-node').register({ transpileOnly: true, project: require('path').join(qqmusicRoot, 'tsconfig.json') })
require(APP_ENTRY)