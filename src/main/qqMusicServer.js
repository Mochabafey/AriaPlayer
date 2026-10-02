import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { settingsRepo } from './db/settings.js'

const START_TIMEOUT = 35000
const RESTART_MAX = 3
const RESTART_DELAY = 5000

/**
 * qq-music-api 子进程生命周期管理。
 * 以 Electron 自身可执行文件 + ELECTRON_RUN_AS_NODE=1 模式 spawn 为 Node 子进程，
 * 入口是 src/main/qqmusic/bridge.cjs：拦截 listen → 命名管道，零 TCP 端口占用。
 * 主进程所有请求走 http.request({ socketPath })，零端口冲突。
 */
export class QqMusicServer {
  constructor() {
    this.child = null
    this.socketPath = null
    this.status = 'down' // down | starting | ready | missing
    this.restarts = 0
    this.stopping = false
    this.onStatusChange = null
  }

  qqmusicDir() {
    const devPath = path.join(app.getAppPath(), 'qqmusic', 'src', 'app.ts')
    if (fs.existsSync(devPath)) {
      return path.join(app.getAppPath(), 'qqmusic')
    }
    const pkgPath = path.join(process.resourcesPath, 'qqmusic', 'src', 'app.ts')
    if (fs.existsSync(pkgPath)) {
      return path.join(process.resourcesPath, 'qqmusic')
    }
    return app.isPackaged
      ? path.join(process.resourcesPath, 'qqmusic')
      : path.join(app.getAppPath(), 'qqmusic')
  }

  bridgePath() {
    const devBridge = path.join(app.getAppPath(), 'src', 'main', 'qqmusic', 'bridge.cjs')
    if (fs.existsSync(devBridge)) return devBridge
    return app.isPackaged
      ? path.join(process.resourcesPath, 'bridge-qqmusic.cjs')
      : path.join(app.getAppPath(), 'src', 'main', 'qqmusic', 'bridge.cjs')
  }

  newSocketPath() {
    const uniq = `${process.pid}-${Date.now().toString(36)}`
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\ntr-qqmusic-${uniq}`
    }
    return path.join(os.tmpdir(), `ntr-qqmusic-${uniq}.sock`)
  }

  setStatus(s) {
    this.status = s
    this.onStatusChange?.(s)
  }

  buildEnv() {
    const env = { ...process.env }
    // 剥离代理变量：qqmusic 启动时有对外请求（注册/版本检查），
    // 若继承 HTTP_PROXY 会被本机代理卡住
    delete env.HTTP_PROXY
    delete env.HTTPS_PROXY
    delete env.http_proxy
    delete env.https_proxy
    delete env.ALL_PROXY
    delete env.all_proxy
    // 注入 QQ 音乐 Cookie（设置页配置，用于解锁 VIP/版权歌曲播放）
    const qqCookie = settingsRepo.get('qqCookie')
    return {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      NTR_QQMUSIC_SOCKET: this.socketPath,
      NTR_QQMUSIC_ENTRY: path.join(this.qqmusicDir(), 'src', 'app.ts'),
      PORT: '3200', // qqmusic 默认端口，实际被 bridge 重定向到管道
      QQ_MUSIC_COOKIE: typeof qqCookie === 'string' ? qqCookie : '',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    }
  }

  async start() {
    const dir = this.qqmusicDir()
    const entry = path.join(dir, 'src', 'app.ts')
    if (!fs.existsSync(entry)) {
      this.setStatus('missing')
      console.error('[qqmusic-server] src/app.ts not found at', entry)
      return false
    }
    const bridge = this.bridgePath()
    if (!fs.existsSync(bridge)) {
      this.setStatus('missing')
      console.error('[qqmusic-server] bridge not found at', bridge)
      return false
    }

    this.socketPath = this.newSocketPath()
    this.setStatus('starting')
    this.stopping = false
    this.restarts = 0

    this.child = spawn(process.execPath, [bridge], {
      cwd: dir,
      env: this.buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const safeWrite = (stream, s) => {
      try { stream.write(s) } catch (e) { /* pipe closed */ }
    }
    this.child.stdout.on('data', (d) => safeWrite(process.stdout, `[qqmusic] ${d}`))
    this.child.stderr.on('data', (d) => safeWrite(process.stderr, `[qqmusic] ${d}`))

    this.child.on('error', (err) => {
      console.error('[qqmusic-server] spawn error', err)
      this.setStatus('down')
    })

    this.child.on('exit', (code) => {
      console.log('[qqmusic-server] exited with code', code)
      this.child = null
      this.cleanupSocket()
      if (this.stopping) {
        this.setStatus('down')
        return
      }
      this.setStatus('down')
      if (this.restarts < RESTART_MAX) {
        this.restarts++
        console.log(`[qqmusic-server] restarting in ${RESTART_DELAY}ms (${this.restarts}/${RESTART_MAX})`)
        setTimeout(() => {
          if (!this.stopping) this.start()
        }, RESTART_DELAY)
      }
    })

    const ok = await this.waitReady()
    if (ok) this.setStatus('ready')
    else this.setStatus('down')
    return ok
  }

  cleanupSocket() {
    if (this.socketPath && this.socketPath.includes('/') && this.socketPath.endsWith('.sock')) {
      try { fs.rmSync(this.socketPath, { force: true }) } catch { /* ignore */ }
    }
  }

  waitReady() {
    const tryOnce = () => new Promise((resolve) => {
      const s = net.connect({ path: this.socketPath }, () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => resolve(false))
      s.setTimeout(800, () => {
        s.destroy()
        resolve(false)
      })
    })
    return new Promise(async (resolve) => {
      const deadline = Date.now() + START_TIMEOUT
      while (Date.now() < deadline) {
        if (this.stopping || !this.child || this.child.exitCode !== null) return resolve(false)
        if (await tryOnce()) return resolve(true)
        await new Promise((r) => setTimeout(r, 300))
      }
      resolve(false)
    })
  }

  /**
   * 等待服务就绪（供 IPC 在「启动窗口期」兜底）。
   * 窗口 ready-to-show 不等服务就绪就显示，用户立刻点 QQ 音乐的歌会撞上
   * QQMUSIC_SERVER_NOT_READY，被前端当成「这首歌放不了」弹给用户。
   * 这里让调用方在 starting 时短暂等待；missing 是永久态，不空等。
   */
  async waitUntilReady(maxMs = 12000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      if (this.status === 'ready') return true
      if (this.status === 'missing') return false
      await new Promise((r) => setTimeout(r, 150))
    }
    return this.status === 'ready'
  }

  async restart() {
    this.stopping = true
    if (this.child) {
      await new Promise((resolve) => {
        const c = this.child
        this.child = null
        c.once('exit', resolve)
        c.kill()
        setTimeout(resolve, 2000)
      })
    }
    this.stopping = false
    this.restarts = 0
    return this.start()
  }

  async stop() {
    this.stopping = true
    if (this.child) {
      await new Promise((resolve) => {
        const c = this.child
        this.child = null
        c.once('exit', resolve)
        c.kill()
        setTimeout(resolve, 2000)
      })
    }
    this.cleanupSocket()
  }
}