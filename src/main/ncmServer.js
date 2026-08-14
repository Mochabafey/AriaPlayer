import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { stores, QUALITY_MAP } from './store/db.js'

const START_TIMEOUT = 20000
const RESTART_MAX = 3
const RESTART_DELAY = 5000

/**
 * api-enhanced 子进程生命周期管理。
 * 以 Electron 自身可执行文件 + ELECTRON_RUN_AS_NODE=1 模式 spawn 成 Node 子进程，
 * 运行 vendored 的 api-enhanced（app.js），监听随机空闲端口。
 */
export class NcmServer {
  constructor() {
    this.child = null
    this.port = null
    this.status = 'down' // down | starting | ready | missing
    this.restarts = 0
    this.stopping = false
    this.onStatusChange = null
    this.fileWatcher = null
    this.watchedMtimes = null
  }

  serverDir() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'ncm-server')
    }
    return path.join(app.getAppPath(), 'server')
  }

  findFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.unref()
      srv.on('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port
        srv.close(() => resolve(p))
      })
    })
  }

  setStatus(s) {
    this.status = s
    this.onStatusChange?.(s)
  }

  buildEnv() {
    const settings = stores.settings.get()
    const quality = QUALITY_MAP[settings.quality] || QUALITY_MAP['320000']
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(this.port),
      HOST: '127.0.0.1',
      ENABLE_GENERAL_UNBLOCK: settings.enableUnblock ? 'true' : 'false',
      ENABLE_FLAC: settings.enableFlac ? 'true' : 'false',
      SELECT_MAX_BR: String(quality.br),
      NO_PROXY: 'localhost,127.0.0.1,::1'
    }
  }

  async start() {
    const dir = this.serverDir()
    const entry = path.join(dir, 'app.js')
    if (!fs.existsSync(entry)) {
      this.setStatus('missing')
      console.error('[ncm-server] app.js not found at', entry)
      return false
    }
    this.port = await this.findFreePort()
    this.setStatus('starting')
    this.stopping = false
    this.restarts = 0

    this.child = spawn(process.execPath, ['app.js'], {
      cwd: dir,
      env: this.buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    // 写入父进程 stdout/stderr 用 safeWrite：EPIPE 在 vite 子进程管道断开时不可避免，
    // 静默忽略避免触发"JavaScript error in the main process"弹窗
    const safeWrite = (stream, s) => {
      try { stream.write(s) } catch (e) { /* pipe closed */ }
    }
    this.child.stdout.on('data', (d) => safeWrite(process.stdout, `[ncm-server] ${d}`))
    this.child.stderr.on('data', (d) => safeWrite(process.stderr, `[ncm-server] ${d}`))

    this.child.on('error', (err) => {
      console.error('[ncm-server] spawn error', err)
      this.setStatus('down')
    })

    this.child.on('exit', (code) => {
      console.log('[ncm-server] exited with code', code)
      this.child = null
      if (this.stopping) {
        this.setStatus('down')
        return
      }
      this.setStatus('down')
      // 自动重启（最多 RESTART_MAX 次）
      if (this.restarts < RESTART_MAX) {
        this.restarts++
        console.log(`[ncm-server] restarting in ${RESTART_DELAY}ms (${this.restarts}/${RESTART_MAX})`)
        setTimeout(() => {
          if (!this.stopping) this.start()
        }, RESTART_DELAY)
      }
    })

    const ok = await this.waitReady()
    if (ok) this.setStatus('ready')
    else this.setStatus('down')
    this.startWatchServer()
    return ok
  }

  /**
   * 监控 server.js / app.js 变更并自动重启子进程：
   * electron-vite dev 不会自动通知 api-enhanced 子进程重读 server.js，
   * 之前需手动重启 dev 才能让 server.js 修复生效；现在改为文件变更自动 restart。
   */
  startWatchServer() {
    this.stopWatchServer()
    const dir = this.serverDir()
    if (!fs.existsSync(dir)) return
    const targets = ['server.js', 'app.js'].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p))
    if (!targets.length) return
    this.watchedMtimes = new Map(targets.map((p) => [p, fs.statSync(p).mtimeMs]))
    const check = () => {
      if (this.stopping) return
      for (const [p, mt] of this.watchedMtimes) {
        try {
          const cur = fs.statSync(p).mtimeMs
          if (cur !== mt) {
            this.watchedMtimes.set(p, cur)
            console.log('[ncm-server] 检测到', path.basename(p), '变更，自动重启子进程')
            this.restart().catch((e) => console.error('[ncm-server] auto restart error', e))
            return
          }
        } catch { /* ignore */ }
      }
      setTimeout(check, 1500)
    }
    setTimeout(check, 1500)
  }

  stopWatchServer() {
    if (this.fileWatcher) {
      try { this.fileWatcher.close() } catch {}
      this.fileWatcher = null
    }
  }

  waitReady() {
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = async () => {
        if (!this.child || this.child.exitCode !== null) return resolve(false)
        try {
          // 任意 HTTP 响应（含 404）都证明 Express 已就绪
          const res = await fetch(`http://127.0.0.1:${this.port}/`, {
            signal: AbortSignal.timeout(2000)
          })
          if (res.status < 500) return resolve(true)
        } catch {
          /* not ready yet */
        }
        if (Date.now() - started > START_TIMEOUT) return resolve(false)
        setTimeout(tick, 300)
      }
      tick()
    })
  }

  async restart() {
    this.stopping = true // 标记主动重启，避免 child exit 同时触发自动重启导致双 start
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
    this.stopWatchServer()
    if (this.child) {
      await new Promise((resolve) => {
        const c = this.child
        this.child = null
        c.once('exit', resolve)
        c.kill()
        setTimeout(resolve, 2000)
      })
    }
  }
}
