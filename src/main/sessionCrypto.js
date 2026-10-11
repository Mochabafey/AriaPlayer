/**
 * 登录态（cookie jar）的加密封装与解封 —— 纯函数模块。
 *
 * 从 ipc/api.js 里拆出来，原因和 playlistExport/playlistImport 一样：
 * 混在 IPC 注册闭包里时无法单测，而「换机后登录态还在不在」是**便携版的
 * 核心承诺**，必须有真实测试兜住（复刻算法来"验证"等于没验证）。
 *
 * ## 三种封装格式（靠 4 字节 magic 区分）
 *
 *   SS01  Electron safeStorage（Windows DPAPI / macOS Keychain）
 *         密文**绑定加密它的那台机器 + 系统账户**，最安全。
 *   AG01  AES-256-GCM，密钥 = scrypt(hostname|username|uid)
 *         safeStorage 不可用时的兜底，同样**换机即废**。
 *   PG01  AES-256-GCM，密钥来自数据目录内的 `.session-key` 文件
 *         **便携模式专用**：密钥随数据目录（U 盘）一起走，换机仍可解密。
 *
 * ## 为什么便携模式必须用 PG01
 *
 * 便携版的整个卖点是「插上就用」。若用 SS01，把 ntr.db 拷到新机器后
 * `safeStorage.decryptString` 会抛异常 → 下面的 catch 静默丢弃会话 →
 * 每次换机都要重新扫码登录，卖点直接失效。
 *
 * ## 安全权衡（如实说明）
 *
 * PG01 的密钥与密文同在 U 盘上，能读到 db 的人也能读到 key ——
 * 强度约等于「明文存储但需要两步」。这是「数据随身带」的固有取舍，
 * 且**不降低非便携模式的安全性**（那边仍优先走 safeStorage）。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/** 便携模式密钥文件名（与 ntr.db 同目录，随数据目录迁移） */
export const SESSION_KEY_FILE = '.session-key'

/** magic 常量 */
export const MAGIC = {
  SAFE_STORAGE: 'SS01',
  MACHINE_KEY: 'AG01',
  PORTABLE_KEY: 'PG01'
}

/** 非便携兜底密钥：由机器信息派生（换机即废，仅作 safeStorage 不可用时的降级） */
export function machineKey(hostname, username, uid = '') {
  return crypto.scryptSync(`${hostname}|${username}|${uid}`, 'ntr-session-v1', 32)
}

/**
 * 便携模式密钥：读数据目录内的 keyfile，缺失则生成 32 字节随机密钥。
 *
 * 生成用 `wx` 标志（文件已存在则失败）—— 避免两个实例同时首启时互相覆盖
 * 密钥，导致先启动的那个会话作废。并发失败时回读对方写的那份。
 *
 * @param {string} dataDir 数据目录（= app.getPath('userData')）
 */
export function portableKey(dataDir) {
  const f = path.join(dataDir, 'ncm-store', SESSION_KEY_FILE)
  try {
    const buf = fs.readFileSync(f)
    if (buf.length === 32) return buf
  } catch { /* 不存在或读失败 → 走生成 */ }
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const key = crypto.randomBytes(32)
    fs.writeFileSync(f, key, { flag: 'wx', mode: 0o600 })
    return key
  } catch {
    // 并发首启：另一个实例刚写完 → 读它写的那个
    try {
      const buf = fs.readFileSync(f)
      if (buf.length === 32) return buf
    } catch { /* ignore */ }
    throw new Error('portable session key unavailable')
  }
}

/** AES-256-GCM 加密：输出 iv(12) || ciphertext || tag(16) */
export function aesEncrypt(buf, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()])
}

/** AES-256-GCM 解密：篡改会因认证失败抛错 */
export function aesDecrypt(buf, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(buf.length - 16))
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()])
}

/**
 * 封装 cookie 列表。
 *
 * @param {Array<[string,string]>} entries cookie 键值对
 * @param {object} opts
 *   - portable     是否便携模式（决定用 PG01 还是 SS01/AG01）
 *   - dataDir      便携模式的数据目录
 *   - safeStorage  Electron safeStorage（可为 null，表示不可用）
 *   - hostname/username/uid  非便携兜底的机器信息
 * @returns {{blob: Buffer, format: string}}
 */
export function sealSession(entries, opts = {}) {
  const payload = Buffer.from(JSON.stringify(entries), 'utf-8')

  if (opts.portable) {
    const key = portableKey(opts.dataDir)
    return {
      blob: Buffer.concat([Buffer.from(MAGIC.PORTABLE_KEY), aesEncrypt(payload, key)]),
      format: MAGIC.PORTABLE_KEY
    }
  }

  if (opts.safeStorage?.isEncryptionAvailable?.()) {
    return {
      blob: Buffer.concat([
        Buffer.from(MAGIC.SAFE_STORAGE),
        opts.safeStorage.encryptString(payload.toString('utf-8'))
      ]),
      format: MAGIC.SAFE_STORAGE
    }
  }

  const key = machineKey(opts.hostname ?? '', opts.username ?? '', opts.uid ?? '')
  return {
    blob: Buffer.concat([Buffer.from(MAGIC.MACHINE_KEY), aesEncrypt(payload, key)]),
    format: MAGIC.MACHINE_KEY
  }
}

/**
 * 解封 cookie 列表。
 *
 * @returns {{ok: boolean, entries: Array|null, format: string|null, reason: string|null}}
 *   解密失败（换机器 / 系统凭据变更 / 数据损坏）返回 ok:false，
 *   调用方据此**静默退回未登录**（不弹错，这是预期内的降级）。
 */
export function openSession(blob, opts = {}) {
  if (!blob || blob.length < 5) return { ok: false, entries: null, format: null, reason: 'empty' }

  const magic = blob.subarray(0, 4).toString('latin1')
  const body = blob.subarray(4)

  try {
    let json
    if (magic === MAGIC.PORTABLE_KEY) {
      json = aesDecrypt(body, portableKey(opts.dataDir)).toString('utf-8')
    } else if (magic === MAGIC.SAFE_STORAGE) {
      if (!opts.safeStorage?.isEncryptionAvailable?.()) {
        return { ok: false, entries: null, format: magic, reason: 'safeStorage-unavailable' }
      }
      json = opts.safeStorage.decryptString(body)
    } else if (magic === MAGIC.MACHINE_KEY) {
      const key = machineKey(opts.hostname ?? '', opts.username ?? '', opts.uid ?? '')
      json = aesDecrypt(body, key).toString('utf-8')
    } else {
      return { ok: false, entries: null, format: null, reason: 'unknown-magic' }
    }
    const entries = JSON.parse(json)
    if (!Array.isArray(entries)) {
      return { ok: false, entries: null, format: magic, reason: 'bad-payload' }
    }
    return { ok: true, entries, format: magic, reason: null }
  } catch (e) {
    // 换机器 / 凭据变更 / 篡改 → 预期内的失败，静默退回未登录
    return { ok: false, entries: null, format: magic, reason: e.message }
  }
}
