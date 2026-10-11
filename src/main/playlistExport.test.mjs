/**
 * 歌单导出内容生成的单元测试（测**真实实现**，不是复刻算法）。
 *
 * 跑法：node src/main/playlistExport.test.mjs
 *
 * 之所以能直接单测：playlistExport.js 是零依赖纯函数模块
 *（不 import electron / fs），所以普通 Node 就能跑。
 */
import assert from 'assert'
import {
  buildPlaylistExport,
  normalizeFormat,
  safeFileName,
  FORMAT_LABELS
} from './playlistExport.js'

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

/* ---------- 测试数据 ---------- */
const songs = [
  { _pid: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 8, filePath: 'D:\\m\\晴天.mp3' },
  { _pid: '2', title: '富士山下', artist: '陈奕迅', album: "What's Going On", duration: 11, filePath: 'D:\\m\\富士山下.mp3' },
  { _pid: '3', title: '在线歌曲', artist: '某人', album: '某专辑', duration: 200, filePath: null }
]
const playlist = { name: '我的歌单', description: '描述', source: 'local' }

/* ---------- m3u ---------- */
test('m3u: 以 #EXTM3U 开头', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'm3u')
  assert.ok(content.startsWith('#EXTM3U'), '缺少头部')
})

test('m3u: 跳过无本地文件的曲目并计数', () => {
  const r = buildPlaylistExport(playlist, songs, 'm3u')
  assert.strictEqual(r.skipped, 1, `skipped=${r.skipped}`)
  assert.strictEqual(r.count, 2, `count=${r.count}`)
})

test('m3u: 行数 = 1 头 + 2×(EXTINF+路径)', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'm3u')
  assert.strictEqual(content.split('\n').length, 5, content)
})

test('m3u: EXTINF 含时长与「歌手 - 标题」', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'm3u')
  assert.ok(content.includes('#EXTINF:8,周杰伦 - 晴天'), content)
  assert.ok(content.includes('#EXTINF:11,陈奕迅 - 富士山下'), content)
})

test('m3u: 路径原样写入（不转义）', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'm3u')
  assert.ok(content.includes('D:\\m\\晴天.mp3'), content)
})

test('m3u: 标题里的逗号被替换（否则破坏 EXTINF 格式）', () => {
  const tricky = [{ _pid: '9', title: 'Hello, World', artist: 'A, B', duration: 5, filePath: 'D:\\x.mp3' }]
  const { content } = buildPlaylistExport(playlist, tricky, 'm3u')
  const extinf = content.split('\n').find((l) => l.startsWith('#EXTINF'))
  // 格式必须是 #EXTINF:<数字>,<标签>，标签里不能再有逗号
  assert.ok(/^#EXTINF:\d+,[^,]*$/.test(extinf), `格式被破坏: ${extinf}`)
  assert.ok(extinf.includes('，'), '逗号未被替换为全角')
})

test('m3u: 时长为空时按 0 处理', () => {
  const noDur = [{ _pid: '1', title: 'T', artist: 'A', duration: undefined, filePath: 'D:\\a.mp3' }]
  const { content } = buildPlaylistExport(playlist, noDur, 'm3u')
  assert.ok(content.includes('#EXTINF:0,A - T'), content)
})

test('m3u: 全部为在线曲目时只剩头部', () => {
  const online = songs.filter((s) => !s.filePath)
  const r = buildPlaylistExport(playlist, online, 'm3u')
  assert.strictEqual(r.content, '#EXTM3U')
  assert.strictEqual(r.count, 0)
  assert.strictEqual(r.skipped, 1)
})

/* ---------- json ---------- */
test('json: 可解析且含元信息', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'json')
  const o = JSON.parse(content)
  assert.strictEqual(o.name, '我的歌单')
  assert.strictEqual(o.description, '描述')
  assert.strictEqual(o.source, 'local')
  assert.strictEqual(o.count, 3, 'count 应为全部曲目（含在线）')
  assert.ok(o.exportedAt, '缺 exportedAt')
})

test('json: 在线曲目的 filePath 为 null 但保留其它字段', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'json')
  const o = JSON.parse(content)
  const online = o.songs.find((s) => s.id === '3')
  assert.ok(online, '在线曲目丢失')
  assert.strictEqual(online.filePath, null)
  assert.strictEqual(online.title, '在线歌曲')
})

test('json: 不跳过任何曲目', () => {
  const r = buildPlaylistExport(playlist, songs, 'json')
  assert.strictEqual(r.skipped, 0)
  assert.strictEqual(r.count, 3)
})

/* ---------- txt ---------- */
test('txt: 带右对齐序号', () => {
  const { content } = buildPlaylistExport(playlist, songs, 'txt')
  const lines = content.split('\n')
  assert.strictEqual(lines.length, 3)
  assert.ok(/^\s*1\. 周杰伦 - 晴天$/.test(lines[0]), lines[0])
  assert.ok(/^\s*3\. 某人 - 在线歌曲$/.test(lines[2]), lines[2])
})

test('txt: 缺字段时用占位符', () => {
  const bare = [{ _pid: '1', title: '', artist: '', duration: 0, filePath: null }]
  const { content } = buildPlaylistExport(playlist, bare, 'txt')
  assert.ok(content.includes('未知歌手 - 未知歌曲'), content)
})

/* ---------- 边界 ---------- */
test('空歌单：m3u 只有头部', () => {
  assert.strictEqual(buildPlaylistExport(playlist, [], 'm3u').content, '#EXTM3U')
})
test('空歌单：txt 为空串', () => {
  assert.strictEqual(buildPlaylistExport(playlist, [], 'txt').content, '')
})
test('空歌单：json count=0', () => {
  assert.strictEqual(JSON.parse(buildPlaylistExport(playlist, [], 'json').content).count, 0)
})
test('songs 传 null 不崩溃', () => {
  assert.strictEqual(buildPlaylistExport(playlist, null, 'm3u').content, '#EXTM3U')
})
test('playlist 为 null 不崩溃', () => {
  const o = JSON.parse(buildPlaylistExport(null, songs, 'json').content)
  assert.strictEqual(o.name, '')
  assert.strictEqual(o.source, 'local')
})

/* ---------- 格式归一化 ---------- */
test('非法格式回落到 m3u', () => {
  assert.strictEqual(normalizeFormat('exe'), 'm3u')
  assert.strictEqual(normalizeFormat(undefined), 'm3u')
  assert.strictEqual(normalizeFormat(null), 'm3u')
  assert.strictEqual(buildPlaylistExport(playlist, songs, 'weird').ext, 'm3u')
})
test('合法格式被保留', () => {
  assert.strictEqual(normalizeFormat('json'), 'json')
  assert.strictEqual(normalizeFormat('txt'), 'txt')
})
test('FORMAT_LABELS 覆盖三种格式', () => {
  assert.ok(FORMAT_LABELS.m3u && FORMAT_LABELS.json && FORMAT_LABELS.txt)
})

/* ---------- 文件名安全化 ---------- */
test('safeFileName: 去掉 Windows 非法字符', () => {
  const out = safeFileName('a<b>c:d"e/f\\g|h?i*j')
  assert.ok(!/[<>:"/\\|?*]/.test(out), out)
  assert.strictEqual(out, 'a_b_c_d_e_f_g_h_i_j')
})
test('safeFileName: 去尾部点与空白', () => {
  assert.strictEqual(safeFileName('名字...  '), '名字')
})
test('safeFileName: 空名用兜底', () => {
  assert.strictEqual(safeFileName(''), 'playlist')
  assert.strictEqual(safeFileName('   '), 'playlist')
  assert.strictEqual(safeFileName(null, 'fb'), 'fb')
})
test('safeFileName: 超长截断', () => {
  assert.ok(safeFileName('あ'.repeat(200)).length <= 80)
})
test('safeFileName: 保留中文', () => {
  assert.strictEqual(safeFileName('我喜欢的音乐'), '我喜欢的音乐')
})

/* ---------- 汇总 ---------- */
console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) {
  console.log(`${fail} 项失败`)
  process.exit(1)
}
console.log('EXPORT_TEST_OK')
