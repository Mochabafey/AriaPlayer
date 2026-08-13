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

    this.child.stdout.on('data', (d) => process.stdout.write(`[ncm-server] ${d}`))
    this.child.stderr.on('data', (d) => process.stderr.write(`[ncm-server] ${d}`))

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
    return ok
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
    this.stopping = false
    if (this.child) {
      await new Promise((resolve) => {
        const c = this.child
        this.child = null
        c.once('exit', resolve)
        c.kill()
        setTimeout(resolve, 2000)
      })
    }
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
  }
}
