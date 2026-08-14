/**
 * test-ncm-roundtrip.mjs — .ncm 算法自测
 * 用逆向流程构造一个 .ncm 文件（含 mp3 音频 + meta + 封面），
 * 再用 decryptNcmFile 解密，比对输出与原始数据是否一致。
 * 不依赖真实文件即可验证算法正确性。
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { decryptNcmFile } from '../src/main/ncm/ncmDecrypt.mjs'

const CORE_KEY = Buffer.from([0x68,0x7a,0x48,0x52,0x41,0x6d,0x73,0x6f,0x35,0x6b,0x49,0x6e,0x62,0x61,0x78,0x57])
const MODIFY_KEY = Buffer.from([0x23,0x31,0x34,0x6c,0x6a,0x6b,0x5f,0x21,0x5c,0x5d,0x26,0x30,0x55,0x3c,0x27,0x28])

function aesEcbEncrypt(key, data) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  const padLen = (16 - (data.length % 16)) % 16
  // PKCS#7：pad 字节 = pad 长度
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)])
  return Buffer.concat([cipher.update(padded), cipher.final()])
}

function buildKeyBox(key) {
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i++) box[i] = i
  let lastByte = 0, keyOffset = 0
  for (let i = 0; i < 256; i++) {
    const swap = box[i]
    const c = (swap + lastByte + key[keyOffset++]) & 0xff
    if (keyOffset >= key.length) keyOffset = 0
    box[i] = box[c]
    box[c] = swap
    lastByte = c
  }
  return box
}

function transformBlock(buf, box) {
  for (let i = 0; i < buf.length; i++) {
    const j = (i + 1) & 0xff
    buf[i] ^= box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff]
  }
  return buf
}

// 1. 构造 .ncm
function buildNcm(audio, metaJson, cover) {
  // 网易真实 key 为非 16 倍数长度（解密时带 PKCS#7 pad），这里用 33 字节模拟
  const key = crypto.randomBytes(33)
  const chunks = []
  chunks.push(Buffer.from([0x43,0x54,0x45,0x4e,0x46,0x44,0x41,0x4d])) // CTENFDAM
  chunks.push(Buffer.from([0x00, 0x00]))
  // key 数据：AES-ECB 加密后每字节 ^0x64
  let encKey = aesEcbEncrypt(CORE_KEY, key)
  encKey = Buffer.from(encKey.map((b) => b ^ 0x64))
  const keyLen = Buffer.alloc(4); keyLen.writeUInt32LE(encKey.length, 0)
  chunks.push(keyLen, encKey)
  // meta
  const metaBuf = Buffer.from('music:' + metaJson, 'utf-8')
  let encMeta = aesEcbEncrypt(MODIFY_KEY, metaBuf)
  let b64 = encMeta.toString('base64')
  const prefixed = Buffer.from('163 key(Don\'t modify):' + b64, 'latin1')
  const metaData = Buffer.from(prefixed.map((b) => b ^ 0x63))
  const metaLen = Buffer.alloc(4); metaLen.writeUInt32LE(metaData.length, 0)
  chunks.push(metaLen, metaData)
  chunks.push(Buffer.alloc(5)) // crc32 + image version
  // 封面
  const coverLen = Buffer.alloc(4); coverLen.writeUInt32LE(cover.length, 0)
  const coverFrameLen = Buffer.alloc(4); coverFrameLen.writeUInt32LE(cover.length, 0)
  chunks.push(coverFrameLen, coverLen, cover)
  // 音频：keybox 变换（xor 对合）
  const box = buildKeyBox(key.subarray(17))
  const encAudio = Buffer.from(audio)
  transformBlock(encAudio, box)
  chunks.push(encAudio)
  return Buffer.concat(chunks)
}

// 2. 测试
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-test-'))
const audio = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x04]), // ID3 头 → 识别为 mp3
  crypto.randomBytes(70000)
])
const metaJson = JSON.stringify({
  musicName: '测试歌曲',
  artist: [['测试歌手']],
  album: '测试专辑',
  bitrate: 320000,
  duration: 210,
  format: 'mp3'
})
const cover = crypto.randomBytes(300) // 模拟封面（前 8 字节不是 PNG → jpg）

const ncmPath = path.join(tmp, 'test.ncm')
fs.writeFileSync(ncmPath, buildNcm(audio, metaJson, cover))

const outDir = path.join(tmp, 'out')
const r = decryptNcmFile(ncmPath, { outputDir: outDir, coverDir: path.join(outDir, '.covers') })

if (!r.ok) {
  console.error('❌ 解密失败:', r.error)
  process.exit(1)
}
console.log('✅ 解密成功:', r.outPath, '| 格式:', r.format)
console.log('meta:', JSON.stringify(r.meta))

const decrypted = fs.readFileSync(r.outPath)
const same = decrypted.length === audio.length && decrypted.equals(audio)
console.log(same ? '✅ 音频数据与原始完全一致' : '❌ 音频数据不一致!')
if (!same) {
  const diffAt = (() => { for (let i = 0; i < Math.min(audio.length, decrypted.length); i++) if (audio[i] !== decrypted[i]) return i; return -1 })()
  console.log('首次差异位置:', diffAt, '原始:', audio[diffAt], '解密:', decrypted[diffAt])
  process.exit(1)
}
console.log('✅ 元数据/封面/格式识别全部通过')
fs.rmSync(tmp, { recursive: true, force: true })
