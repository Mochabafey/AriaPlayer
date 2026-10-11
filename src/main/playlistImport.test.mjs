/**
 * 歌单文件解析的单元测试（测真实实现）。
 *
 * 跑法：node src/main/playlistImport.test.mjs
 *
 * playlistImport.js 零依赖（只 import node:path），普通 Node 可直接跑。
 */
import assert from 'assert'
import path from 'path'
import {
  parseM3U,
  parseJSONPlaylist,
  parsePlaylistFile,
  isAudioFile,
  AUDIO_EXTS
} from './playlistImport.js'

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

const BASE = path.resolve('D:/music')
const j = (...p) => path.join(BASE, ...p)

/* ---------- M3U ---------- */
test('m3u: 跳过 # 开头的指令行', () => {
  const raw = ['#EXTM3U', '#EXTINF:8,周杰伦 - 晴天', 'D:/music/晴天.mp3'].join('\n')
  const out = parseM3U(raw, BASE)
  assert.deepStrictEqual(out, [j('晴天.mp3')])
})

test('m3u: 多首保持顺序', () => {
  const raw = ['#EXTM3U', '#EXTINF:1,a', 'D:/music/a.mp3', '#EXTINF:2,b', 'D:/music/b.mp3'].join('\n')
  assert.deepStrictEqual(parseM3U(raw, BASE), [j('a.mp3'), j('b.mp3')])
})

test('m3u: 忽略空行与纯空白行', () => {
  const raw = '#EXTM3U\n\n   \nD:/music/a.mp3\n\n'
  assert.deepStrictEqual(parseM3U(raw, BASE), [j('a.mp3')])
})

test('m3u: 相对路径相对歌单文件目录解析', () => {
  const raw = 'sub/song.mp3'
  assert.deepStrictEqual(parseM3U(raw, BASE), [j('sub', 'song.mp3')])
})

test('m3u: 绝对路径原样保留', () => {
  const abs = path.resolve('D:/other/x.mp3')
  assert.deepStrictEqual(parseM3U(abs, BASE), [abs])
})

test('m3u: CRLF 换行兼容', () => {
  const raw = '#EXTM3U\r\nD:/music/a.mp3\r\nD:/music/b.mp3\r\n'
  assert.strictEqual(parseM3U(raw, BASE).length, 2)
})

test('m3u: 行首尾空白被裁掉', () => {
  const raw = '  D:/music/a.mp3  '
  assert.deepStrictEqual(parseM3U(raw, BASE), [j('a.mp3')])
})

/**
 * 回归测试：正斜杠路径必须被规范化。
 *
 * 这是拆模块时发现的**真实缺陷** —— M3U 是跨平台格式，foobar2000/Winamp/
 * MusicBee 导出的 Windows 播放列表普遍用正斜杠 `D:/Music/a.mp3`，
 * 而曲库存的是 `path.join` 的反斜杠形式。查库是精确字符串匹配，
 * 两者不等 → 明明文件在曲库里，导入却全部报 missing。
 *
 * 注意 path.isAbsolute('D:/x') 为 true，所以只判 isAbsolute 发现不了。
 */
test('m3u: 正斜杠路径被规范化为本机分隔符（回归）', () => {
  const out = parseM3U('D:/music/a.mp3', BASE)
  assert.deepStrictEqual(out, [j('a.mp3')])
  assert.strictEqual(out[0], path.normalize('D:/music/a.mp3'))
})

test('m3u: 混合分隔符也能规范化', () => {
  const out = parseM3U('D:/music\\sub/a.mp3', BASE)
  assert.strictEqual(out[0], path.normalize('D:/music/sub/a.mp3'))
})

test('m3u: .. 段被折叠', () => {
  const out = parseM3U('D:/music/sub/../a.mp3', BASE)
  assert.deepStrictEqual(out, [j('a.mp3')])
})

test('m3u: 相对路径里的正斜杠同样被规范化', () => {
  const out = parseM3U('sub/dir/a.mp3', BASE)
  assert.deepStrictEqual(out, [j('sub', 'dir', 'a.mp3')])
})

test('json: 正斜杠路径被规范化（回归）', () => {
  const raw = JSON.stringify({ songs: [{ filePath: 'D:/music/a.mp3' }] })
  assert.deepStrictEqual(parseJSONPlaylist(raw, BASE).paths, [j('a.mp3')])
})

test('json: .. 段被折叠', () => {
  const raw = JSON.stringify([{ filePath: 'D:/music/x/../a.mp3' }])
  assert.deepStrictEqual(parseJSONPlaylist(raw, BASE).paths, [j('a.mp3')])
})

test('m3u: 空内容返回空数组', () => {
  assert.deepStrictEqual(parseM3U('', BASE), [])
  assert.deepStrictEqual(parseM3U(null, BASE), [])
})

/* ---------- JSON ---------- */
test('json: 兼容导出的歌单快照 {songs:[...]}', () => {
  const raw = JSON.stringify({ name: 'p', songs: [{ filePath: 'D:/music/a.mp3' }] })
  const r = parseJSONPlaylist(raw, BASE)
  assert.strictEqual(r.error, null)
  assert.deepStrictEqual(r.paths, [j('a.mp3')])
})

test('json: 兼容曲库清单（裸数组）', () => {
  const raw = JSON.stringify([{ filePath: 'D:/music/a.mp3' }, { filePath: 'D:/music/b.mp3' }])
  const r = parseJSONPlaylist(raw, BASE)
  assert.strictEqual(r.paths.length, 2)
})

test('json: 相对路径被解析（此前缺失的处理）', () => {
  const raw = JSON.stringify({ songs: [{ filePath: 'rel/x.mp3' }] })
  const r = parseJSONPlaylist(raw, BASE)
  assert.deepStrictEqual(r.paths, [j('rel', 'x.mp3')])
})

test('json: 无 filePath 的条目被跳过（在线曲目）', () => {
  const raw = JSON.stringify({ songs: [{ title: 'online', filePath: null }, { filePath: 'D:/music/a.mp3' }] })
  const r = parseJSONPlaylist(raw, BASE)
  assert.deepStrictEqual(r.paths, [j('a.mp3')])
})

test('json: 非法 JSON 返回错误而非抛异常', () => {
  const r = parseJSONPlaylist('{oops', BASE)
  assert.ok(r.error, '应返回 error')
  assert.deepStrictEqual(r.paths, [])
})

test('json: 结构无法识别时返回错误', () => {
  const r = parseJSONPlaylist(JSON.stringify({ foo: 1 }), BASE)
  assert.ok(r.error, '应返回 error')
})

test('json: 数组里的非对象元素被跳过', () => {
  const raw = JSON.stringify([null, 'str', 42, { filePath: 'D:/music/a.mp3' }])
  assert.deepStrictEqual(parseJSONPlaylist(raw, BASE).paths, [j('a.mp3')])
})

test('json: filePath 非字符串被跳过', () => {
  const raw = JSON.stringify([{ filePath: 123 }, { filePath: 'D:/music/a.mp3' }])
  assert.deepStrictEqual(parseJSONPlaylist(raw, BASE).paths, [j('a.mp3')])
})

/* ---------- 统一入口 ---------- */
test('parsePlaylistFile: .m3u 走 m3u 分支', () => {
  const r = parsePlaylistFile('#EXTM3U\nD:/music/a.mp3', 'D:/music/p.m3u')
  assert.strictEqual(r.kind, 'm3u')
  assert.strictEqual(r.error, null)
  assert.deepStrictEqual(r.paths, [j('a.mp3')])
})

test('parsePlaylistFile: .m3u8 同样走 m3u 分支', () => {
  const r = parsePlaylistFile('D:/music/a.mp3', 'D:/music/p.m3u8')
  assert.strictEqual(r.kind, 'm3u')
})

test('parsePlaylistFile: .json 走 json 分支', () => {
  const r = parsePlaylistFile(JSON.stringify([{ filePath: 'D:/music/a.mp3' }]), 'D:/music/p.json')
  assert.strictEqual(r.kind, 'json')
  assert.deepStrictEqual(r.paths, [j('a.mp3')])
})

test('parsePlaylistFile: 大小写扩展名都能识别', () => {
  assert.strictEqual(parsePlaylistFile('x', 'D:/music/P.M3U').kind, 'm3u')
  assert.strictEqual(parsePlaylistFile('[]', 'D:/music/P.JSON').kind, 'json')
})

test('parsePlaylistFile: 不支持的扩展名返回错误', () => {
  const r = parsePlaylistFile('x', 'D:/music/p.txt')
  assert.ok(r.error, '应返回 error')
  assert.strictEqual(r.kind, null)
})

test('parsePlaylistFile: 无扩展名返回错误', () => {
  assert.ok(parsePlaylistFile('x', 'D:/music/noext').error)
})

test('parsePlaylistFile: json 解析失败时错误被透传', () => {
  const r = parsePlaylistFile('{bad', 'D:/music/p.json')
  assert.ok(r.error)
  assert.strictEqual(r.kind, 'json')
})

/* ---------- 音频扩展名判定 ---------- */
test('isAudioFile: 识别常见格式', () => {
  for (const e of ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.opus']) {
    assert.ok(isAudioFile('x' + e), e)
  }
})

test('isAudioFile: 大小写不敏感', () => {
  assert.ok(isAudioFile('X.MP3'))
  assert.ok(isAudioFile('X.Flac'))
})

test('isAudioFile: 非音频被拒', () => {
  for (const f of ['x.txt', 'x.jpg', 'x', '', null, 'x.mp4']) {
    assert.ok(!isAudioFile(f), String(f))
  }
})

test('AUDIO_EXTS 与 isAudioFile 一致', () => {
  for (const e of AUDIO_EXTS) assert.ok(isAudioFile('f' + e))
})

/* ---------- 汇总 ---------- */
console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) {
  console.log(`${fail} 项失败`)
  process.exit(1)
}
console.log('IMPORT_TEST_OK')
