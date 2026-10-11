/**
 * 登录态加密封装的单元测试（测**真实实现**）。
 *
 * 跑法：node src/main/sessionCrypto.test.mjs
 *
 * 核心问题：便携版把数据放在 U 盘上，插到**另一台电脑**能否保持登录？
 * 这是便携版的关键承诺，必须有测试兜住。
 */
import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  sealSession,
  openSession,
  portableKey,
  machineKey,
  aesEncrypt,
  aesDecrypt,
  MAGIC,
  SESSION_KEY_FILE
} from './sessionCrypto.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}

const TMP = path.join(process.cwd(), '.test-session')
fs.rmSync(TMP, { recursive: true, force: true })
const dataDir = path.join(TMP, 'AriaData')

const COOKIES = [
  ['MUSIC_U', 'token_abcdef123456'],
  ['__csrf', 'csrf_value'],
  ['NMTID', 'nmtid_value']
]

/* ============ 便携模式：跨机保留（核心承诺）============ */
console.log('--- 便携模式：跨机保留 ---')

test('PG01：便携模式封装产出 PG01 格式', () => {
  const { blob, format } = sealSession(COOKIES, { portable: true, dataDir })
  assert.strictEqual(format, MAGIC.PORTABLE_KEY)
  assert.strictEqual(blob.subarray(0, 4).toString('latin1'), 'PG01')
})

test('PG01：同一数据目录可解封', () => {
  const { blob } = sealSession(COOKIES, { portable: true, dataDir })
  const r = openSession(blob, { portable: true, dataDir })
  assert.ok(r.ok, `解封失败: ${r.reason}`)
  assert.strictEqual(r.entries.length, 3)
})

test('PG01：cookie 值完整还原', () => {
  const { blob } = sealSession(COOKIES, { portable: true, dataDir })
  const r = openSession(blob, { portable: true, dataDir })
  const m = new Map(r.entries)
  assert.strictEqual(m.get('MUSIC_U'), 'token_abcdef123456')
  assert.strictEqual(m.get('__csrf'), 'csrf_value')
})

test('PG01：换机器仍能解封（密钥随数据目录走）', () => {
  // 在「机器 A」加密
  const { blob } = sealSession(COOKIES, { portable: true, dataDir })
  // 把整个数据目录复制成「机器 B」（模拟插 U 盘）
  const dataDirB = path.join(TMP, 'AriaData-B')
  fs.rmSync(dataDirB, { recursive: true, force: true })
  fs.cpSync(dataDir, dataDirB, { recursive: true })
  // 机器 B 的 hostname/username 完全不同 —— 对 PG01 无影响
  const r = openSession(blob, {
    portable: true,
    dataDir: dataDirB,
    hostname: 'TOTALLY-DIFFERENT-PC',
    username: 'another-user'
  })
  assert.ok(r.ok, `换机解封失败: ${r.reason}`)
  assert.strictEqual(new Map(r.entries).get('MUSIC_U'), 'token_abcdef123456')
})

test('PG01：.session-key 随数据目录一起被复制', () => {
  sealSession(COOKIES, { portable: true, dataDir })
  const kf = path.join(dataDir, 'ncm-store', SESSION_KEY_FILE)
  assert.ok(fs.existsSync(kf), 'keyfile 未生成')
  const dataDirC = path.join(TMP, 'AriaData-C')
  fs.rmSync(dataDirC, { recursive: true, force: true })
  fs.cpSync(dataDir, dataDirC, { recursive: true })
  assert.ok(fs.existsSync(path.join(dataDirC, 'ncm-store', SESSION_KEY_FILE)),
    'keyfile 未被一起复制（便携会失效）')
})

/* ============ 对照：机器派生密钥跨机必失败 ============ */
console.log('\n--- 对照：AG01 机器派生密钥 ---')

test('AG01：safeStorage 不可用时回落到 AG01', () => {
  const { blob, format } = sealSession(COOKIES, {
    portable: false,
    safeStorage: null,
    hostname: 'PC-A',
    username: 'alice'
  })
  assert.strictEqual(format, MAGIC.MACHINE_KEY)
  assert.strictEqual(blob.subarray(0, 4).toString('latin1'), 'AG01')
})

test('AG01：同机可解封（证明实现正确）', () => {
  const opts = { portable: false, safeStorage: null, hostname: 'PC-A', username: 'alice' }
  const { blob } = sealSession(COOKIES, opts)
  const r = openSession(blob, opts)
  assert.ok(r.ok, `同机解封失败: ${r.reason}`)
})

test('AG01：换机器解封失败（证明便携为何不能用它）', () => {
  const { blob } = sealSession(COOKIES, {
    portable: false, safeStorage: null, hostname: 'PC-A', username: 'alice'
  })
  const r = openSession(blob, {
    portable: false, safeStorage: null, hostname: 'PC-B', username: 'bob'
  })
  assert.strictEqual(r.ok, false, '换机竟然解开了？机器派生密钥不该跨机可用')
})

test('AG01：换用户名也解不开', () => {
  const { blob } = sealSession(COOKIES, {
    portable: false, safeStorage: null, hostname: 'PC-A', username: 'alice'
  })
  const r = openSession(blob, {
    portable: false, safeStorage: null, hostname: 'PC-A', username: 'bob'
  })
  assert.strictEqual(r.ok, false)
})

/* ============ SS01（用桩模拟，无法真跑 DPAPI）============ */
console.log('\n--- SS01 safeStorage 分支 ---')

test('SS01：safeStorage 可用时优先用它', () => {
  const stub = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('STUB:' + s, 'utf-8'),
    decryptString: (b) => b.toString('utf-8').replace(/^STUB:/, '')
  }
  const { blob, format } = sealSession(COOKIES, { portable: false, safeStorage: stub })
  assert.strictEqual(format, MAGIC.SAFE_STORAGE)
})

test('SS01：同桩可解封', () => {
  const stub = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('STUB:' + s, 'utf-8'),
    decryptString: (b) => b.toString('utf-8').replace(/^STUB:/, '')
  }
  const { blob } = sealSession(COOKIES, { portable: false, safeStorage: stub })
  const r = openSession(blob, { portable: false, safeStorage: stub })
  assert.ok(r.ok)
  assert.strictEqual(new Map(r.entries).get('MUSIC_U'), 'token_abcdef123456')
})

test('SS01：密文换机（safeStorage 不可用）时优雅失败', () => {
  const stub = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('STUB:' + s, 'utf-8'),
    decryptString: (b) => b.toString('utf-8').replace(/^STUB:/, '')
  }
  const { blob } = sealSession(COOKIES, { portable: false, safeStorage: stub })
  const r = openSession(blob, {
    portable: false,
    safeStorage: { isEncryptionAvailable: () => false, decryptString: () => { throw new Error('DPAPI fail') } }
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'safeStorage-unavailable')
})

test('便携模式优先于 safeStorage（即使可用也走 PG01）', () => {
  const stub = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('STUB:' + s, 'utf-8'),
    decryptString: (b) => b.toString('utf-8')
  }
  const { format } = sealSession(COOKIES, { portable: true, dataDir, safeStorage: stub })
  assert.strictEqual(format, MAGIC.PORTABLE_KEY, '便携模式必须用 PG01，否则换机丢登录')
})

/* ============ keyfile 行为 ============ */
console.log('\n--- keyfile 行为 ---')

test('keyfile：重复读取返回同一密钥', () => {
  const k1 = portableKey(dataDir)
  const k2 = portableKey(dataDir)
  assert.ok(k1.equals(k2))
})

test('keyfile：长度 32 字节', () => {
  assert.strictEqual(portableKey(dataDir).length, 32)
})

test('keyfile：被替换后解不开（证明真依赖它）', () => {
  const { blob } = sealSession(COOKIES, { portable: true, dataDir })
  const kf = path.join(dataDir, 'ncm-store', SESSION_KEY_FILE)
  const orig = fs.readFileSync(kf)
  fs.writeFileSync(kf, crypto.randomBytes(32))
  const r = openSession(blob, { portable: true, dataDir })
  fs.writeFileSync(kf, orig)
  assert.strictEqual(r.ok, false, '换了密钥竟然还能解开？')
})

test('keyfile：不同数据目录得到不同密钥', () => {
  const d1 = path.join(TMP, 'k1')
  const d2 = path.join(TMP, 'k2')
  assert.ok(!portableKey(d1).equals(portableKey(d2)))
})

/* ============ 完整性 / 边界 ============ */
console.log('\n--- 完整性与边界 ---')

test('篡改密文 → GCM 认证失败（不会静默返回脏数据）', () => {
  const { blob } = sealSession(COOKIES, { portable: true, dataDir })
  const bad = Buffer.from(blob)
  bad[bad.length - 20] ^= 0xff
  const r = openSession(bad, { portable: true, dataDir })
  assert.strictEqual(r.ok, false)
})

test('空输入 → ok:false 且 reason=empty', () => {
  assert.strictEqual(openSession(null, {}).reason, 'empty')
  assert.strictEqual(openSession(Buffer.alloc(0), {}).reason, 'empty')
  assert.strictEqual(openSession(Buffer.from('ab'), {}).reason, 'empty')
})

test('未知 magic → ok:false', () => {
  const r = openSession(Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(32)]), {})
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'unknown-magic')
})

test('空 cookie 列表可正常往返', () => {
  const { blob } = sealSession([], { portable: true, dataDir })
  const r = openSession(blob, { portable: true, dataDir })
  assert.ok(r.ok)
  assert.deepStrictEqual(r.entries, [])
})

test('含特殊字符的 cookie 值可往返', () => {
  const weird = [['k', '中文/emoji🎵/quotes"\'\\/newline\n']]
  const { blob } = sealSession(weird, { portable: true, dataDir })
  const r = openSession(blob, { portable: true, dataDir })
  assert.strictEqual(r.entries[0][1], '中文/emoji🎵/quotes"\'\\/newline\n')
})

test('aesEncrypt/aesDecrypt 往返一致', () => {
  const key = crypto.randomBytes(32)
  const data = Buffer.from('hello 世界', 'utf-8')
  assert.ok(aesDecrypt(aesEncrypt(data, key), key).equals(data))
})

test('machineKey 确定性（同输入同输出）', () => {
  assert.ok(machineKey('h', 'u', '1').equals(machineKey('h', 'u', '1')))
  assert.ok(!machineKey('h', 'u', '1').equals(machineKey('h', 'u', '2')))
})

/* ============ 清理 ============ */
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) {
  console.log(`${fail} 项失败`)
  process.exit(1)
}
console.log('SESSION_CRYPTO_TEST_OK')
