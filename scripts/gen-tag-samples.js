// 生成最小合法 FLAC/M4A 样本文件（无 ffmpeg 依赖，纯字节构造），用于标签写回回归测试。
// 样本只保证容器结构合法（能被 music-metadata 解析 + 写入后仍能解析），不含真实可解码音频。
const fs = require('fs')
const path = require('path')

function u32be(v) {
  return Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
}
function be24(v) {
  return Buffer.from([(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
}
function be16(v) {
  return Buffer.from([(v >>> 8) & 0xff, v & 0xff])
}
function box(type, payload) {
  return Buffer.concat([u32be(8 + payload.length), Buffer.from(type, 'latin1'), payload])
}
function fullBox(type, payload) {
  return box(type, Buffer.concat([Buffer.from([0, 0, 0, 0]), payload]))
}
// fullBox 变体：version=0, flags 全零

// ---------- FLAC ----------
// fLaC + STREAMINFO(最后块, 34字节) + 1 个静音 FRAME
function makeFlac() {
  const streamInfo = Buffer.alloc(34)
  // bytes[0..2]: sampleRate(20bit) | channels-1(3bit) | bits-1(5bit)
  const v = (16000 << 12) | ((1 - 1) << 9) | ((16 - 1) << 4)
  streamInfo[0] = (v >>> 16) & 0xff
  streamInfo[1] = (v >>> 8) & 0xff
  streamInfo[2] = v & 0xff
  // min/max blocksize 4096
  streamInfo[3] = 0
  streamInfo[4] = (4096 >> 8) & 0xff
  streamInfo[5] = 4096 & 0xff
  streamInfo[6] = 0
  streamInfo[7] = (4096 >> 8) & 0xff
  streamInfo[8] = 4096 & 0xff
  // total samples 4096 (36bit)
  const total = 4096
  streamInfo[9] = 0
  streamInfo[10] = 0
  streamInfo[11] = 0
  streamInfo[12] = 0
  streamInfo[13] = (total >>> 24) & 0xff
  streamInfo[14] = (total >>> 16) & 0xff
  streamInfo[15] = (total >>> 8) & 0xff
  streamInfo[16] = total & 0xff
  // bytes[17..33]: md5 全零
  const header = Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x80 | 0x00]), // isLast=1, type=0 STREAMINFO
    be24(34),
    streamInfo
  ])
  // 帧：合法 frame header(6B) + subframe 头(1B) + 1 sample 常数(2B) + crc8
  const frameHeader = Buffer.from([0xff, 0xf8, 0x00, 0x00, 0x00, 0x00])
  const subframe = Buffer.concat([Buffer.from([0x00]), be16(0)])
  const frameBody = Buffer.concat([frameHeader, subframe])
  let crc8 = 0
  for (const b of frameBody) {
    crc8 ^= b
    for (let i = 0; i < 8; i++) crc8 = (crc8 & 0x80) ? ((crc8 << 1) ^ 0x07) & 0xff : (crc8 << 1) & 0xff
  }
  return Buffer.concat([header, frameBody, Buffer.from([crc8])])
}

// ---------- M4A ----------
// 标准最小结构：ftyp + moov(trak>mdia>minf>stbl: stsd/stts/stsc/stsz/stco) + mdat(原始 PCM 静音)
// 各 atom 用规范长度：tkhd v0=84, mdhd v0=24, hdlr=32, smhd=16, stsd 内 mp4a entry=28
function makeM4a() {
  const sampleCount = 100
  const sampleSize = 2
  const mdatData = Buffer.alloc(sampleCount * sampleSize)

  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32be(0), Buffer.from('isom', 'latin1')]))

  // mp4a sample entry：28 字节 = size(4)+type(4)+version(2)+revision(2)+vendor(4)+
  //   channelCount(2)+sampleSize(2)+compressorId(2)+packetSize(2)+sampleRate(4, 16.16 定点)
  const mp4a = Buffer.concat([
    u32be(28),
    Buffer.from('mp4a', 'latin1'),
    be16(0), be16(0), u32be(0),
    be16(2), be16(16), be16(0), be16(0),
    u32be(16000 << 16)
  ])
  const stsd = fullBox('stsd', Buffer.concat([u32be(1), mp4a]))
  const stts = fullBox('stts', Buffer.concat([u32be(1), u32be(0), u32be(sampleCount)]))
  const stsc = fullBox('stsc', Buffer.concat([u32be(1), u32be(1), u32be(1), u32be(1)]))
  const stsz = fullBox('stsz', Buffer.concat([u32be(sampleSize), u32be(1), u32be(sampleCount)]))
  const stbl = box('stbl', Buffer.concat([stsd, stts, stsc, stsz]))

  const smhd = fullBox('smhd', Buffer.alloc(8))
  const dref = fullBox('dref', Buffer.concat([u32be(1), fullBox('url ', Buffer.alloc(4))]))
  const dinf = box('dinf', dref)
  const minf = box('minf', Buffer.concat([smhd, dinf, stbl]))

  // mdhd v0：24 字节内容 = version/flags(4) + creation(4) + modification(4) + timescale(4) + duration(4) + lang(2) + quality(2)
  const mdhd = fullBox('mdhd', Buffer.concat([u32be(0), u32be(0), u32be(16000), u32be(sampleCount * 1000), be16(0x55c4), be16(0)]))
  // hdlr：32 字节 = version/flags(4) + pre_defined(4) + handler_type(4) + reserved(12) + name(0)
  const hdlr = fullBox('hdlr', Buffer.concat([u32be(0), Buffer.from('soun', 'latin1'), Buffer.alloc(12)]))
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]))

  // tkhd v0：84 字节 = version/flags(4)+creation(4)+modification(4)+trackId(4)+reserved(4)+duration(4)+
  //   reserved(8)+layer(2)+altGroup(2)+volume(2)+reserved(2)+matrix(36)+width(4)+height(4)
  const tkhd = fullBox('tkhd', Buffer.concat([
    u32be(0), u32be(0), u32be(1), u32be(0),
    u32be(sampleCount * 1000),
    Buffer.alloc(8),
    be16(0), be16(0), be16(0x0100), be16(0),
    Buffer.alloc(36), // matrix
    u32be(0), u32be(0) // width/height
  ]))
  const trak = box('trak', Buffer.concat([tkhd, mdia]))
  const moov = box('moov', trak)
  const mdatDataStart = ftyp.length + moov.length + 8
  const stco = fullBox('stco', Buffer.concat([u32be(1), u32be(mdatDataStart)]))

  // 用正确 stco 重建整棵 moov
  const stbl2 = box('stbl', Buffer.concat([stsd, stts, stsc, stsz, stco]))
  const minf2 = box('minf', Buffer.concat([smhd, dinf, stbl2]))
  const mdia2 = box('mdia', Buffer.concat([mdhd, hdlr, minf2]))
  const trak2 = box('trak', Buffer.concat([tkhd, mdia2]))
  const moov2 = box('moov', trak2)

  return Buffer.concat([ftyp, moov2, box('mdat', mdatData)])
}

const outDir = path.join(__dirname, 'samples')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'sample.flac'), makeFlac())
fs.writeFileSync(path.join(outDir, 'sample.m4a'), makeM4a())
console.log('samples written to', outDir)
