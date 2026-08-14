/**
 * ncmDecrypt.mjs — .ncm 文件解密（纯 JS 实现，零原生依赖）
 *
 * 算法移植自 taurusxin/ncmdump（MIT License）：
 *   https://github.com/taurusxin/ncmdump
 *
 * .ncm 文件结构（字节序均为小端）：
 *   0x00 8B  魔数 "CTENFDAM"
 *   0x08 2B  跳过
 *   0x0A 4B  key 长度 n
 *   0x0E nB  key 数据（每字节 ^0x64 → AES-128-ECB 解密(coreKey) → 取 [17:] 构建 keybox）
 *   之后 4B  meta 长度 m（>0 时：m 字节数据，每字节 ^0x63 → 跳 22B → base64 → AES-128-ECB(modifyKey) → 跳 6B → JSON）
 *   之后 5B  跳过（crc32 + image version）
 *   之后 4B  coverFrameLen；4B coverLen；coverLen B 封面图；跳 (coverFrameLen-coverLen) B
 *   之后    音频数据（0x8000 分块，逐字节 xor keybox 变换）
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const CORE_KEY = Buffer.from([
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f,
  0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57
])
const MODIFY_KEY = Buffer.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21,
  0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28
])
const MAGIC = Buffer.from([0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d]) // "CTENFDAM"
const BLOCK = 0x8000

/** AES-128-ECB 解密，padding 逻辑与 C++ 一致（尾块按末字节剥除，pad>16 视为 0） */
function aesEcbDecrypt(key, data) {
  // C++ 只处理完整 16B 块，忽略尾部不足块
  const len = Math.floor(data.length / 16) * 16
  const truncated = data.subarray(0, len)
  if (truncated.length === 0) return Buffer.alloc(0)
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const out = Buffer.concat([decipher.update(truncated), decipher.final()])
  let pad = out[out.length - 1]
  if (pad > 16) pad = 0
  return out.subarray(0, out.length - pad)
}

/** 构建 256 字节 keybox（RC4 KSA 变体） */
function buildKeyBox(key) {
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i++) box[i] = i
  let lastByte = 0
  let keyOffset = 0
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

/** 音频块逐字节解密 */
function decryptBlock(buf, box) {
  for (let i = 0; i < buf.length; i++) {
    const j = (i + 1) & 0xff
    buf[i] ^= box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff]
  }
  return buf
}

/** 解析 meta JSON：artist 为 [[name]] 结构 */
function parseMeta(json) {
  try {
    const raw = JSON.parse(json)
    const artists = Array.isArray(raw.artist)
      ? raw.artist.map((a) => (Array.isArray(a) ? a[0] : null)).filter(Boolean).join('/')
      : ''
    return {
      title: raw.musicName || '',
      artist: artists || '',
      album: raw.album || '',
      bitrate: raw.bitrate || 0,
      duration: raw.duration || 0,
      format: raw.format || ''
    }
  } catch {
    return { title: '', artist: '', album: '', bitrate: 0, duration: 0, format: '' }
  }
}

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 120)
}

/**
 * 解密单个 .ncm 文件
 * @param {string} inputPath  .ncm 文件路径
 * @param {object} opts       { outputDir?, coverDir?, writeTags? }
 * @returns {{ok:boolean, outPath?:string, error?:string, meta?:object, coverPath?:string}}
 */
export function decryptNcmFile(inputPath, opts = {}) {
  const { outputDir = path.dirname(inputPath), coverDir = null } = opts
  try {
    const fd = fs.openSync(inputPath, 'r')
    try {
      const readBuf = (len, pos) => {
        const b = Buffer.alloc(len)
        const n = fs.readSync(fd, b, 0, len, pos)
        if (n < len) throw new Error('文件不完整')
        return b
      }
      // 魔数
      const magic = readBuf(8, 0)
      if (!magic.equals(MAGIC)) throw new Error('不是有效的 .ncm 文件')

      let pos = 10 // 8 魔数 + 2 跳过
      // key
      const keyLen = readBuf(4, pos).readUInt32LE(0)
      pos += 4
      if (keyLen <= 0) throw new Error('损坏的 .ncm 文件（key 长度异常）')
      const keyData = readBuf(keyLen, pos)
      pos += keyLen
      for (let i = 0; i < keyData.length; i++) keyData[i] ^= 0x64
      const mKeyData = aesEcbDecrypt(CORE_KEY, keyData)
      if (mKeyData.length <= 17) throw new Error('key 解密失败')
      const box = buildKeyBox(mKeyData.subarray(17))

      // meta
      const metaLen = readBuf(4, pos).readUInt32LE(0)
      pos += 4
      let meta = null
      if (metaLen > 0) {
        const metaData = readBuf(metaLen, pos)
        pos += metaLen
        for (let i = 0; i < metaData.length; i++) metaData[i] ^= 0x63
        try {
          const b64 = metaData.subarray(22).toString('latin1')
          const decoded = Buffer.from(b64, 'base64')
          const decrypted = aesEcbDecrypt(MODIFY_KEY, decoded)
          const json = decrypted.subarray(6).toString('utf-8')
          meta = parseMeta(json)
        } catch (e) {
          console.warn('[ncm] meta 解析失败:', e.message)
        }
      }

      // 跳过 crc32 + image version
      pos += 5
      // 封面
      const coverFrameLen = readBuf(4, pos).readUInt32LE(0)
      pos += 4
      const coverLen = readBuf(4, pos).readUInt32LE(0)
      pos += 4
      let coverPath = null
      let coverExt = '.jpg'
      if (coverLen > 0) {
        const cover = readBuf(coverLen, pos)
        pos += coverLen
        if (cover.length >= 8 && cover[0] === 0x89 && cover[1] === 0x50) coverExt = '.png'
        if (coverDir) {
          fs.mkdirSync(coverDir, { recursive: true })
          const base = sanitize(`${meta?.artist || '未知'} - ${meta?.title || path.basename(inputPath, '.ncm')}`)
          coverPath = path.join(coverDir, base + coverExt)
          fs.writeFileSync(coverPath, cover)
        }
      }
      if (coverFrameLen > coverLen) pos += coverFrameLen - coverLen

      // 音频流
      const audioFd = fs.openSync(inputPath, 'r')
      const baseName = sanitize(meta && (meta.artist || meta.title) ? `${meta.artist} - ${meta.title}` : path.basename(inputPath, '.ncm'))
      let outPath = null
      let format = ''
      const chunk = Buffer.alloc(BLOCK)
      let firstChunk = true
      try {
        let offset = pos
        for (;;) {
          const n = fs.readSync(audioFd, chunk, 0, BLOCK, offset)
          if (n <= 0) break
          offset += n
          const slice = chunk.subarray(0, n)
          decryptBlock(slice, box)
          if (firstChunk) {
            firstChunk = false
            // 首块判断格式：ID3 → mp3，否则 flac
            format = slice[0] === 0x49 && slice[1] === 0x44 && slice[2] === 0x33 ? 'mp3' : 'flac'
            fs.mkdirSync(outputDir, { recursive: true })
            outPath = path.join(outputDir, `${baseName}.${format}`)
          }
          fs.appendFileSync(outPath, slice)
        }
      } finally {
        fs.closeSync(audioFd)
      }

      if (!outPath) throw new Error('音频数据为空')
      return { ok: true, outPath, format, meta, coverPath }
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 递归收集目录下所有 .ncm 文件 */
export function collectNcmFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    try {
      if (ent.isDirectory()) collectNcmFiles(full, out)
      else if (ent.name.toLowerCase().endsWith('.ncm')) out.push(full)
    } catch { /* ignore */ }
  }
  return out
}

/** 写音频标签（mp3 用 node-id3；flac/m4a 用项目内纯 JS 标签实现，此处返回未写标记由调用方处理） */
export async function writeTags(filePath, meta, coverPath, format) {
  if (!meta) return { wroteTag: false }
  try {
    if (format === 'mp3') {
      const { default: NodeID3 } = await import('node-id3')
      const tags = { title: meta.title, artist: meta.artist, album: meta.album }
      if (coverPath && fs.existsSync(coverPath)) {
        const ext = path.extname(coverPath).toLowerCase()
        tags.image = { mime: ext === '.png' ? 'image/png' : 'image/jpeg', type: { id: 3, name: 'front cover' }, imageBuffer: fs.readFileSync(coverPath), description: '' }
      }
      NodeID3.write(tags, filePath)
      return { wroteTag: true }
    }
    if (format === 'flac' || format === 'm4a') {
      try {
        const mod = await import('../tags/writeTags.mjs')
        if (typeof mod.writeFileTags === 'function') {
          const ok = mod.writeFileTags(filePath, { title: meta.title, artist: meta.artist, album: meta.album })
          return { wroteTag: !!ok }
        }
      } catch { /* 标签模块不可用时跳过 */ }
      return { wroteTag: false, reason: 'flac 标签模块未实现' }
    }
  } catch (e) {
    return { wroteTag: false, error: e.message }
  }
  return { wroteTag: false }
}
