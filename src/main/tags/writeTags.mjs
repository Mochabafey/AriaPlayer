// 纯 JS 文件标签写入：FLAC(Vorbis Comment) 与 M4A(MP4 ilst)。
// 零原生依赖：node-id3 只支持 MP3，此处补齐 .flac/.m4a 的 title/artist/album 写回。
// 字节级操作，仅在标签块已存在或可按容器结构安全插入时才落盘，否则返回 false 保持原文件不变。

import fs from 'fs'
import path from 'path'
import NodeID3 from 'node-id3'

// ---------- 通用小工具 ----------

function u32be(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
}

function i32be(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff
  buf[off + 1] = (v >>> 16) & 0xff
  buf[off + 2] = (v >>> 8) & 0xff
  buf[off + 3] = v & 0xff
}

// Vorbis Comment 的长度字段一律小端
function i32le(buf, off, v) {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
  buf[off + 2] = (v >>> 16) & 0xff
  buf[off + 3] = (v >>> 24) & 0xff
}

function u32le(buf, off) {
  return ((buf[off + 3] << 24) | (buf[off + 2] << 16) | (buf[off + 1] << 8) | buf[off]) >>> 0
}

function isBoxType(s) {
  return /^[A-Za-z0-9]{4}$/.test(s)
}

// ---------- FLAC ----------

const FLAC_MARKER = Buffer.from('fLaC')

// FLAC metadata block：4 字节头（isLast << 7 | type 7bit, 长度 24bit）+ 数据
function flacMetaHeader(isLast, type, len) {
  const h = Buffer.alloc(4)
  h[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f)
  h[1] = (len >>> 16) & 0xff
  h[2] = (len >>> 8) & 0xff
  h[3] = len & 0xff
  return h
}

// Vorbis Comment：vendor(length u32 + bytes) + 评论数(u32) + 每条(length u32 + "KEY=value")
function buildVorbisComment(fields, vendor) {
  const comments = []
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue
    comments.push(Buffer.from(`${k}=${v}`, 'utf-8'))
  }
  const vendorBuf = Buffer.from(vendor || '', 'utf-8')
  let len = 4 + vendorBuf.length + 4 + 4
  for (const c of comments) len += 4 + c.length
  const b = Buffer.alloc(len)
  let off = 0
  i32le(b, off, vendorBuf.length); off += 4
  vendorBuf.copy(b, off); off += vendorBuf.length
  i32le(b, off, comments.length); off += 4
  for (const c of comments) {
    i32le(b, off, c.length); off += 4
    c.copy(b, off); off += c.length
  }
  return b
}

function writeFlacTags(buf, tags) {
  if (buf.length < 4 || !buf.slice(0, 4).equals(FLAC_MARKER)) return null
  let off = 4
  const blocks = []
  let isLast = false
  while (!isLast && off + 4 <= buf.length) {
    const h = buf[off]
    isLast = (h & 0x80) !== 0
    const type = h & 0x7f
    const len = ((buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
    if (off + 4 + len > buf.length) return null
    blocks.push({ type, data: buf.subarray(off + 4, off + 4 + len) })
    off += 4 + len
  }

  const streamInfo = blocks.find((b) => b.type === 0)
  if (!streamInfo) return null

  const hasExisting = blocks.some((b) => b.type === 4)
  const commentData = buildVorbisComment(tags, hasExisting ? readVorbisVendor(blocks.find((b) => b.type === 4)) : '')

  const outBlocks = []
  if (hasExisting) {
    // 原位替换 VORBIS_COMMENT，长度可能变化 → 后续 block 相对偏移会变，但 STREAMINFO 与音频帧位置不受影响
    for (const b of blocks) {
      if (b.type === 4) continue
      outBlocks.push(b)
    }
    // 若原 VORBIS_COMMENT 后面跟 PADDING(1)，保留 PADDING 占位可避免音频帧偏移变化
    const idx = blocks.findIndex((b) => b.type === 4)
    const after = blocks.slice(idx + 1)
    outBlocks.push({ type: 4, data: commentData })
    for (const b of after) outBlocks.push(b)
  } else {
    // 无 VORBIS_COMMENT：插入到 STREAMINFO 之后。PADDING 紧跟 STREAMINFO 则复用其空间，否则插在两者之间。
    const padIdx = blocks.findIndex((b, i) => i > 0 && b.type === 1)
    if (padIdx > 0) {
      // 把 PADDING 替换为 VORBIS_COMMENT + 剩余 PADDING
      const padData = blocks[padIdx].data
      const remain = Buffer.alloc(Math.max(0, padData.length - commentData.length))
      for (const [i, b] of blocks.entries()) {
        if (i === 0) outBlocks.push(b)
        else if (i === padIdx) {
          if (remain.length) outBlocks.push({ type: 1, data: remain })
          outBlocks.push({ type: 4, data: commentData })
        } else if (i === 1 && padIdx === 2 && b.type === 1) {
          // 忽略（重复 pad 保护）
        } else outBlocks.push(b)
      }
    } else {
      outBlocks.push(blocks[0])
      outBlocks.push({ type: 4, data: commentData })
      for (let i = 1; i < blocks.length; i++) outBlocks.push(blocks[i])
    }
  }

  const header = Buffer.alloc(4)
  FLAC_MARKER.copy(header)
  const body = Buffer.concat(outBlocks.map((b, i) => Buffer.concat([flacMetaHeader(i === outBlocks.length - 1, b.type, b.data.length), b.data])))
  return Buffer.concat([header, body])
}

function readVorbisVendor(b) {
  if (!b || b.data.length < 4) return ''
  const n = u32le(b.data, 0)
  if (n > b.data.length - 4) return ''
  return b.data.toString('utf-8', 4, 4 + n)
}

// ---------- M4A (MP4) ----------

const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta'])

// 解析盒树。data 字段指向原 Buffer 的 subarray（不拷贝）。
function parseMp4(buf, start, end, depth = 0) {
  const boxes = []
  let p = start
  while (p + 8 <= end) {
    const size0 = u32be(buf, p)
    const type = buf.toString('latin1', p + 4, p + 8)
    if (!isBoxType(type)) break
    let size = size0
    let headerSize = 8
    let hdr64 = 0n
    if (size0 === 1) {
      hdr64 = buf.readBigUInt64BE(p + 8)
      size = Number(hdr64)
      headerSize = 16
    } else if (size0 === 0) {
      size = end - p
    }
    if (size < headerSize || p + size > end) break
    const dataStart = p + headerSize
    const dataEnd = p + size
    let children = null
    if (CONTAINER_TYPES.has(type)) {
      // meta 是 full box：跳过 version/flags 4 字节后再解析子盒
      const innerStart = type === 'meta' ? dataStart + 4 : dataStart
      const inner = parseMp4(buf, innerStart, type === 'meta' ? dataEnd : dataEnd, depth + 1)
      children = inner.boxes
      boxes.push({ type, size, start: p, dataStart, dataEnd, children })
    } else {
      boxes.push({ type, size, start: p, dataStart, dataEnd, children: null, raw: buf.subarray(p, dataEnd) })
    }
    p = dataEnd
  }
  return { boxes, end: p }
}

// 找 stco：返回 { fileOff, dataStart, count, entryOffBase }。stco 是 full box（4 字节 version/flags）。
function findStco(buf, tree) {
  const walk = (boxes) => {
    for (const b of boxes) {
      if (b.type === 'stco') {
        const { dataStart } = b
        const count = u32be(buf, dataStart + 4) // 跳过 version/flags
        return { dataStart, count, entryOffBase: dataStart + 8 }
      }
      if (b.children) {
        const r = walk(b.children)
        if (r) return r
      }
    }
    return null
  }
  return walk(tree.boxes)
}

function makeBox(type, data) {
  const b = Buffer.alloc(8 + data.length)
  i32be(b, 0, 8 + data.length)
  b.write(type, 4, 'latin1')
  data.copy(b, 8)
  return b
}

// ilst：每个 item 一个盒子（©nam/©ART/©alb），内含 data 盒子。
// data box 规范：size(4)+'data'(4)+set(U8)+type(U24)+locale(U24)+pad(1)+value。
// type=1 表示 UTF-8 文本。布局须与 music-metadata 的 DataAtom 一致。
function buildIlst(items) {
  const parts = []
  for (const [atom, val] of items) {
    const valBuf = Buffer.from(val, 'utf-8')
    const data = Buffer.alloc(16 + valBuf.length)
    i32be(data, 0, 16 + valBuf.length) // box size
    data.write('data', 4, 'latin1')
    data[8] = 0 // set
    data[9] = 0 // type (UINT24) = 1 → UTF-8
    data[10] = 0
    data[11] = 1
    data[12] = 0 // locale (UINT24) = 0
    data[13] = 0
    data[14] = 0
    data[15] = 0 // pad
    valBuf.copy(data, 16)
    parts.push(makeBox(atom, data))
  }
  return makeBox('ilst', Buffer.concat(parts))
}

function buildMetaIlst(ilst) {
  // meta box: size + 'meta' + version/flags(4) + 内容
  return makeBox('meta', Buffer.concat([Buffer.from([0, 0, 0, 0]), ilst]))
}

function buildUdtaWithMetaIlst(metaIlst) {
  return makeBox('udta', metaIlst)
}

function writeMp4Tags(buf, tags) {
  const tree = parseMp4(buf, 0, buf.length)
  if (!tree.boxes.length) return null
  const items = []
  if (tags.title != null) items.push(['\xa9nam', tags.title])
  if (tags.artist != null) items.push(['\xa9ART', tags.artist])
  if (tags.album != null) items.push(['\xa9alb', tags.album])
  if (!items.length) return null

  // 统一策略：重建整个 moov。替换原有 udta 或新建 udta>meta>ilst，并修正 stco 偏移。
  const moov = tree.boxes.find((b) => b.type === 'moov')
  if (!moov) return null
  const stco = findStco(buf, tree)
  const origMdatStart = scanMdat(buf)

  const newUdta = buildUdtaWithMetaIlst(buildMetaIlst(buildIlst(items)))
  const oldUdta = moov.children.find((b) => b.type === 'udta')

  // 拼接：moov 数据区 = [原子盒(去掉旧 udta), 新 udta]，header 重写
  const children = moov.children.filter((b) => b !== oldUdta)
  const childParts = children.map((c) => buf.subarray(c.start, c.dataEnd))
  const newData = Buffer.concat([...childParts, newUdta])

  // 重建 moov（size 修正）+ 整个文件
  const newMoov = makeBox('moov', newData)
  const rebuild = Buffer.concat([
    buf.subarray(0, moov.start),
    newMoov,
    buf.subarray(moov.dataEnd)
  ])
  const delta = newMoov.length - moov.size

  // 修正 stco：指向 mdat（>= 原始 mdat dataStart）的偏移整体后移 delta
  if (stco && origMdatStart != null) {
    const stcoInRebuild = findStco(rebuild, parseMp4(rebuild, 0, rebuild.length))
    for (let i = 0; i < stco.count; i++) {
      const entryOff = stcoInRebuild.entryOffBase + i * 4
      const off = u32be(rebuild, entryOff)
      if (off >= origMdatStart) {
        i32be(rebuild, entryOff, off + delta)
      }
    }
  }
  return rebuild
}

function scanMdat(buf) {
  for (let p = 0; p + 8 <= buf.length; p++) {
    if (buf.toString('latin1', p + 4, p + 8) === 'mdat') return p + 8
  }
  return null
}

// ---------- 入口 ----------

function writeFileTags(filePath, tags) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp3') {
    // MP3：复用 node-id3 写 ID3v2
    try {
      const t = {}
      if (tags.title != null) t.title = tags.title
      if (tags.artist != null) t.artist = tags.artist
      if (tags.album != null) t.album = tags.album
      NodeID3.write(t, filePath)
      return true
    } catch (e) {
      return false
    }
  }
  let buf
  try {
    buf = fs.readFileSync(filePath)
  } catch (e) {
    return false
  }
  const isFlac = ext === '.flac'
  const isM4a = ext === '.m4a'
  let out = null
  if (isFlac) {
    out = writeFlacTags(buf, tags)
  } else if (isM4a) {
    out = writeMp4Tags(buf, tags)
  }
  if (!out) return false
  try {
    fs.writeFileSync(filePath, out)
    return true
  } catch (e) {
    return false
  }
}

export { writeFileTags, writeFlacTags, writeMp4Tags, buildIlst, buildMetaIlst, buildUdtaWithMetaIlst, parseMp4, scanMdat }
