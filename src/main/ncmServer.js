import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { settingsRepo } from './db/settings.js'
import { QUALITY_MAP } from './constants.js'

const START_TIMEOUT = 60000
const RESTART_MAX = 3
const RESTART_DELAY = 5000

/**
 * 子进程「已就绪」的信号标记（由 ncm/bridge.cjs 在 listen 回调里打印）。
 *
 * 为什么用 stdout 标记而非 process.send：
 *   spawn 的 stdio 不含 'ipc'（保持 ['ignore','pipe','pipe']），此时
 *   `process.send` 是 undefined（已实测）。走 stdout 无需改 spawn 配置，
 *   且现有代码本就转发子进程 stdout 到主进程日志，复用它改动面最小。
 */
const READY_MARKER = '###NTR_READY###'

/**
 * api-enhanced 子进程生命周期管理。
 * 以 Electron 自身可执行文件 + ELECTRON_RUN_AS_NODE=1 模式 spawn 为 Node 子进程，
 * 入口是 ncm/bridge.cjs：vendored 服务不监听 TCP 端口，而是挂在
 * Named Pipe / Unix Domain Socket 私有通道上（见 bridge.cjs）。
 * 主进程所有请求走 http.request({ socketPath })，零 TCP 端口占用。
 */
export class NcmServer {
  constructor() {
    this.child = null
    this.socketPath = null
    this.status = 'down' // down | starting | ready | missing
    this.restarts = 0
    this.stopping = false
    this.onStatusChange = null
    this.fileWatcher = null
    this.watchedMtimes = null
    /** 就绪信号回调（waitReady 注册，收到子进程标记时触发） */
    this._readySignalHandler = null
  }

  serverDir() {
    // electron-vite dev 模式下 app.isPackaged 可能错误返回 true，
    // 故以路径存在性为准：开发路径优先，打包路径兜底
    const devPath = path.join(app.getAppPath(), 'server', 'app.js')
    if (fs.existsSync(devPath)) {
      return path.join(app.getAppPath(), 'server')
    }
    const pkgPath = path.join(process.resourcesPath, 'ncm-server', 'app.js')
    if (fs.existsSync(pkgPath)) {
      return path.join(process.resourcesPath, 'ncm-server')
    }
    // 兜底：按 isPackaged 的原始逻辑
    return app.isPackaged
      ? path.join(process.resourcesPath, 'ncm-server')
      : path.join(app.getAppPath(), 'server')
  }

  /** 私有通道入口：开发期在源码目录，打包后随 extraResources 复制到 resources 根 */
  bridgePath() {
    const devBridge = path.join(app.getAppPath(), 'src', 'main', 'ncm', 'bridge.cjs')
    if (fs.existsSync(devBridge)) return devBridge
    const pkgBridge = path.join(process.resourcesPath, 'bridge.cjs')
    if (fs.existsSync(pkgBridge)) return pkgBridge
    return app.isPackaged
      ? path.join(process.resourcesPath, 'bridge.cjs')
      : path.join(app.getAppPath(), 'src', 'main', 'ncm', 'bridge.cjs')
  }

  /** 每次启动生成新的通道名：Windows 命名管道 / Unix socket 文件，天然无端口冲突 */
  newSocketPath() {
    const uniq = `${process.pid}-${Date.now().toString(36)}`
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\ntr-api-${uniq}`
    }
    return path.join(os.tmpdir(), `ntr-api-${uniq}.sock`)
  }

  setStatus(s) {
    this.status = s
    this.onStatusChange?.(s)
  }

  buildEnv() {
    const settings = settingsRepo.getAll()
    const quality = QUALITY_MAP[settings.quality] || QUALITY_MAP['320000']
    // 剥离系统代理变量：api-enhanced 启动时（注册匿名 token 后）有对外请求，
    // 若继承 HTTP(S)_PROXY 会被本机代理（如 127.0.0.1:10808）卡住，导致 listen 永远执行不到
    // （实测复现：带代理变量时服务注册成功后挂起，waitReady 超时 failed to start）
    const env = { ...process.env }
    delete env.HTTP_PROXY
    delete env.HTTPS_PROXY
    delete env.http_proxy
    delete env.https_proxy
    delete env.ALL_PROXY
    delete env.all_proxy
    return {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      NTR_SOCKET: this.socketPath,
      NTR_APP_ENTRY: path.join(this.serverDir(), 'app.js'),
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
    const bridge = this.bridgePath()
    if (!fs.existsSync(bridge)) {
      this.setStatus('missing')
      console.error('[ncm-server] bridge not found at', bridge)
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

    // 写入父进程 stdout/stderr 用 safeWrite：EPIPE 在 vite 子进程管道断开时不可避免，
    // 静默忽略避免触发"JavaScript error in the main process"弹窗
    const safeWrite = (stream, s) => {
      try { stream.write(s) } catch (e) { /* pipe closed */ }
    }
    this.child.stdout.on('data', (d) => {
      // 就绪信号：bridge 在 listen 回调里打的固定标记（见 ncm/bridge.cjs）。
      // 事件驱动取代原先的 300ms 轮询探测 —— 收到即可立即置 ready，
      // 省掉平均 150ms / 最坏 300ms 的等待，也少一次白建的 socket 连接。
      const s = d.toString()
      if (s.includes(READY_MARKER)) this.markReadyBySignal()
      safeWrite(process.stdout, `[ncm-server] ${d}`)
    })
    this.child.stderr.on('data', (d) => safeWrite(process.stderr, `[ncm-server] ${d}`))

    this.child.on('error', (err) => {
      console.error('[ncm-server] spawn error', err)
      this.setStatus('down')
    })

    this.child.on('exit', (code) => {
      console.log('[ncm-server] exited with code', code)
      this.child = null
      this.cleanupSocket()
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

  cleanupSocket() {
    if (this.socketPath && this.socketPath.includes('/') && this.socketPath.endsWith('.sock')) {
      try { fs.rmSync(this.socketPath, { force: true }) } catch { /* ignore */ }
    }
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
      try { this.fileWatcher.close() } catch { /* ignore */ }
      this.fileWatcher = null
    }
  }

  /**
   * 等待服务就绪。
   *
   * ## 事件驱动 + 轮询兜底（原实现纯轮询）
   *
   * 原实现每 300ms 连一次 socket，连上即就绪 —— 平均多等 150ms、最坏 300ms，
   * 且每次探测都白建一个连接。
   *
   * 现在子进程在 listen 回调里打 `###NTR_READY###` 标记（见 ncm/bridge.cjs），
   * 主进程收到即立即 resolve，**零额外等待**。
   *
   * 保留轮询的原因：信号可能丢失/延迟（如 stdout 背压、桥接层异常），
   * 纯靠事件会让启动卡死。轮询间隔放宽到 500ms（信号正常情况下根本不会用到），
   * 只在信号没来时兜底。
   */
  waitReady() {
    return new Promise((resolve) => {
      const deadline = Date.now() + START_TIMEOUT

      /** 信号通道：bridge 打标记时调用 */
      const onSignal = () => {
        cleanup()
        resolve(true)
      }
      this._readySignalHandler = onSignal

      const cleanup = () => {
        if (this._readySignalHandler === onSignal) this._readySignalHandler = null
        clearTimeout(pollTimer)
      }

      // 兜底轮询（信号丢失时仍能起来）
      const tryOnce = () => new Promise((res) => {
        const s = net.connect({ path: this.socketPath }, () => {
          s.destroy()
          res(true)
        })
        s.on('error', () => res(false))
        s.setTimeout(800, () => {
          s.destroy()
          res(false)
        })
      })

      let pollTimer = null
      const poll = async () => {
        if (this.stopping || !this.child || this.child.exitCode !== null) {
          cleanup()
          return resolve(false)
        }
        if (Date.now() > deadline) {
          cleanup()
          return resolve(false)
        }
        if (await tryOnce()) {
          cleanup()
          return resolve(true)
        }
        pollTimer = setTimeout(poll, 500)
      }
      pollTimer = setTimeout(poll, 500)
    })
  }

  /** 收到子进程就绪信号时调用（由 stdout 监听触发） */
  markReadyBySignal() {
    if (this._readySignalHandler) {
      const h = this._readySignalHandler
      this._readySignalHandler = null
      h()
    }
  }

  /**
   * 等待服务就绪（供 IPC 在「启动窗口期」兜底）。
   *
   * 窗口 ready-to-show 不等服务就绪就显示出来，用户可能立刻点播放——
   * 此时 IPC 直接抛 NCM_SERVER_NOT_READY 会被当成「这首歌放不了」弹给用户。
   * 本方法让调用方在 status 仍为 starting 时短暂等待，而不是立刻失败。
   *
   * 与 waitReady() 的区别：只轮询 status 字段，不新建 socket 连接
   * （避免每次请求都开销一次连接探测）；maxMs 远小于启动超时。
   */
  async waitUntilReady(maxMs = 12000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      if (this.status === 'ready') return true
      // missing 是永久态（服务文件不存在），等下去没有意义
      if (this.status === 'missing') return false
      await new Promise((r) => setTimeout(r, 150))
    }
    return this.status === 'ready'
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
    this.cleanupSocket()
  }
}
