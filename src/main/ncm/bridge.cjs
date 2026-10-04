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
    /**
     * 就绪信号（事件驱动，取代主进程的 300ms 轮询探测）。
     *
     * 主进程原先靠「每 300ms 连一次 socket，连上即就绪」判断 ——
     * 平均多等 150ms、最坏 300ms，且每次都白建一次连接。
     * 这里在 listen 回调里主动发信号，主进程收到即可立即置 ready。
     *
     * 双通道发送（哪个能用用哪个）：
     *   process.send  —— 需要 spawn 时 stdio 含 'ipc'；消息通道干净，
     *                    不会被日志文本干扰（首选）
     *   stdout 标记   —— 兜底：ipc 不可用时（如某些 Electron 版本）
     *                    打一行固定前缀，主进程从日志流里识别
     */
    try {
      if (typeof process.send === 'function') process.send({ type: 'ready' })
    } catch { /* ipc 不可用，走 stdout 兜底 */ }
    console.log('###NTR_READY###')
    cb && cb()
  })
}

require(APP_ENTRY)
