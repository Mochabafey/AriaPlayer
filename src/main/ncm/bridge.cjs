#!/usr/bin/env node
/**
 * api-enhanced 私有通道入口（子进程侧）。
 *
 * 拦截 net.Server.prototype.listen，把 vendored 服务的 TCP 监听整体重定向到
 * Named Pipe（Windows）/ Unix Domain Socket（macOS/Linux）：
 *   - 零 TCP 端口占用，不存在端口冲突/被抢导致整个程序瘫痪的问题
 *   - 系统级私有通道：本机其他进程无法像访问 127.0.0.1:port 那样直接访问服务
 *   - vendored 代码（server/app.js）零改动，升级 vendor 不受影响
 */
const fs = require('fs')
const net = require('net')

const SOCKET_PATH = process.env.NTR_SOCKET
const APP_ENTRY = process.env.NTR_APP_ENTRY
if (!SOCKET_PATH || !APP_ENTRY) {
  console.error('[bridge] missing NTR_SOCKET / NTR_APP_ENTRY')
  process.exit(1)
}

const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  // Named pipe / Unix socket 下 socket.remoteAddress 是 undefined，
  // 而 vendored server.js 用 req.ip（源自 remoteAddress）给网易云接口传 realIP，
  // undefined.substring 会直接抛 TypeError → 所有路由 500。伪装成回环地址。
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
  // Unix socket 是文件，listen 前清掉残留（named pipe 无此问题）
  if (SOCKET_PATH.includes('/')) {
    try { fs.rmSync(SOCKET_PATH, { force: true }) } catch { /* ignore */ }
  }
  return origListen.call(this, SOCKET_PATH, () => {
    console.log('[bridge] private socket ready:', SOCKET_PATH)
    cb && cb()
  })
}

require(APP_ENTRY)
