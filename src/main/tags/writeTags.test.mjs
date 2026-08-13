// FLAC/M4A 标签写回回归测试。
// 用法：node scripts/gen-tag-samples.js（先生成样本）→ node src/main/tags/writeTags.test.mjs
// 对样本写入 title/artist/album，再用 music-metadata 读回验证；并验证写后文件仍可解析。
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeFileTags } from './writeTags.mjs'
import * as mm from 'music-metadata'

async function readTags(filePath) {
  const m = await mm.parseFile(filePath)
  return m.common
}

async function run() {
  const samplesDir = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'scripts', 'samples')
  let pass = 0
  let fail = 0

  for (const name of ['sample.flac', 'sample.m4a']) {
    const src = path.join(samplesDir, name)
    const work = path.join(samplesDir, `_test_${name}`)
    fs.copyFileSync(src, work)

    // 1) 写入标签
    const wrote = writeFileTags(work, { title: '测试标题', artist: '测试歌手', album: '测试专辑' })
    assert.strictEqual(wrote, true, `${name}: writeFileTags 应返回 true`)
    console.log(`[PASS] ${name} writeFileTags=true`)

    // 2) 读回验证
    const t = await readTags(work)
    assert.strictEqual(t.title, '测试标题', `${name}: title`)
    assert.strictEqual(t.artist, '测试歌手', `${name}: artist`)
    assert.strictEqual(t.album, '测试专辑', `${name}: album`)
    console.log(`[PASS] ${name} tags read back OK`)

    // 3) 二次写入（标签已存在时更新）
    const wrote2 = writeFileTags(work, { title: '标题二', artist: '歌手二', album: '专辑二' })
    assert.strictEqual(wrote2, true, `${name}: 二次写入应成功`)
    const t2 = await readTags(work)
    assert.strictEqual(t2.title, '标题二', `${name}: 二次写入 title`)
    assert.strictEqual(t2.artist, '歌手二', `${name}: 二次写入 artist`)
    assert.strictEqual(t2.album, '专辑二', `${name}: 二次写入 album`)
    console.log(`[PASS] ${name} second write OK`)

    // 4) 文件仍可解析（容器结构未损坏）
    const m = await mm.parseFile(work)
    assert.ok(m.format.container, `${name}: 写后仍可解析容器`)
    console.log(`[PASS] ${name} file still parseable (${m.format.container})`)

    fs.unlinkSync(work)
    pass += 4
  }

  // 5) 未知扩展名 / 不存在的文件应返回 false 且不改文件
  const src = path.join(samplesDir, 'sample.flac')
  const before = fs.readFileSync(src)
  const res = writeFileTags(path.join(samplesDir, 'nonexistent.flac'), { title: 'x' })
  assert.strictEqual(res, false, '不存在的文件应返回 false')
  assert.ok(before.equals(fs.readFileSync(src)), '原文件不应被改动')
  console.log('[PASS] invalid file returns false')
  pass++

  // 6) MP3 路径（node-id3 写 ID3v2）
  fs.mkdirSync(samplesDir, { recursive: true })
  const mp3 = path.join(samplesDir, '_test_mp3.mp3')
  // 带合法 ID3v2 头的极简 mp3
  fs.writeFileSync(mp3, Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // 10 字节 ID3v2.3 头
    Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  ]))
  const NodeID3 = (await import('node-id3')).default
  NodeID3.write({ title: '旧', artist: '旧', album: '旧' }, mp3)
  const wroteMp3 = writeFileTags(mp3, { title: '新标题', artist: '新歌手', album: '新专辑' })
  assert.strictEqual(wroteMp3, true, 'mp3 写入应成功')
  const t3 = NodeID3.read(mp3)
  assert.strictEqual(t3.title, '新标题', 'mp3 title')
  assert.strictEqual(t3.artist, '新歌手', 'mp3 artist')
  assert.strictEqual(t3.album, '新专辑', 'mp3 album')
  console.log('[PASS] mp3 tag write via writeFileTags')
  fs.unlinkSync(mp3)
  pass++

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

run().catch((e) => {
  console.error('TEST FAIL:', e.message)
  process.exit(1)
})
