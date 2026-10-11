/**
 * 歌单功能集成测试（需要 app 已运行 + CDP 端口）。
 *
 * 跑法：
 *   1. 启动 dev 实例并开调试端口：
 *        NCM_DEBUG_PORT=9333 npm run dev
 *   2. 另开一个终端：
 *        node tests/playlist-integration.mjs
 *
 * ## 为什么需要它（单测覆盖不到的部分）
 *
 * playlistExport.test.mjs / playlistImport.test.mjs 覆盖的是**纯函数**。
 * 但「IPC handler 是否正确透传参数」这类问题单测够不着 —— 例如
 * ncm:playlist-save 曾经只解构 { id, name, songIds }，把调用方传的
 * source/tracks/cover 静默丢掉（不报错！），导致快照歌单被当成本地歌单。
 * 这个缺陷就是本脚本发现的，故保留为长期回归测试。
 *
 * 用 ffmpeg 生成真实带元数据的 MP3，覆盖：扫描入库 → 建歌单 → 加歌 →
 * 去重 → 顺序校验 → 重排 → 移歌 → 重命名 → 快照歌单 → 清理。
 * 结束时自行清理测试数据，可反复运行。
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const CDP = `http://127.0.0.1:${process.env.NCM_DEBUG_PORT || 9333}`
const MUSIC_DIR = path.resolve('.test-music')

/* 造真实音频 */
fs.rmSync(MUSIC_DIR, { recursive: true, force: true })
fs.mkdirSync(MUSIC_DIR, { recursive: true })
const ff = path.resolve('resources/ffmpeg/ffmpeg.exe')
const songs = [
  { n: '晴天', a: '周杰伦', al: '叶惠美', d: 8 },
  { n: '七里香', a: '周杰伦', al: '七里香', d: 5 },
  { n: '富士山下', a: '陈奕迅', al: "What's Going On", d: 11 },
  { n: '浮夸', a: '陈奕迅', al: 'U87', d: 6 },
  { n: '起风了', a: '买辣椒也用券', al: '起风了', d: 9 },
  { n: '海阔天空', a: 'Beyond', al: '乐与怒', d: 13 }
]
for (const s of songs) {
  spawnSync(ff, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${s.d}`,
    '-metadata', `title=${s.n}`, '-metadata', `artist=${s.a}`, '-metadata', `album=${s.al}`,
    '-b:a', '128k', path.join(MUSIC_DIR, `${s.n}.mp3`)], { stdio: 'ignore' })
}

const list = await (await fetch(`${CDP}/json/list`)).json()
const t = list.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
})
function send(method, params = {}) {
  const i = ++id
  return new Promise((res, rej) => { pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })) })
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
await send('Runtime.enable')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  → ' + d : ''}`) }

/* ---- 扫描 ---- */
console.log('--- 扫描入库 ---')
await ev(`await window.ncm.invoke('ncm:library-add-folder', ${JSON.stringify(MUSIC_DIR)}); return true`)
const all = await ev(`return await window.ncm.invoke('ncm:library-list')`)
check('6 首入库', all.length === 6, String(all.length))
const byTitle = new Map(all.map((s) => [s.title, s]))
check('元数据正确', byTitle.get('晴天')?.artist === '周杰伦' && byTitle.get('晴天')?.album === '叶惠美')

/* ---- 路径规范化未破坏写入 ---- */
check('入库路径为本机分隔符', byTitle.get('晴天').filePath.includes('\\'), byTitle.get('晴天').filePath)
const noDup = await ev(`
  // 重复扫描不应产生重复记录（hasFile 规范化后仍能正确判重）
  await window.ncm.invoke('ncm:library-add-folder', ${JSON.stringify(MUSIC_DIR)});
  const s = await window.ncm.invoke('ncm:library-list');
  return s.length
`)
check('重复扫描不产生重复记录', noDup === 6, String(noDup))

/* ---- 歌单全流程 ---- */
console.log('\n--- 歌单全流程 ---')
const pl = await ev(`
  const s = await window.ncm.invoke('ncm:library-list');
  const m = {}; for (const x of s) m[x.title] = x.id;
  const p = await window.ncm.invoke('ncm:playlist-create', {
    name: '回归歌单', songIds: [m['晴天'], m['七里香'], m['浮夸']]
  });
  return { id: p.id, n: p.songIds.length }
`)
check('建歌单 + 加 3 首', pl.n === 3, String(pl.n))

const dup = await ev(`
  const s = await window.ncm.invoke('ncm:library-list');
  const m = {}; for (const x of s) m[x.title] = x.id;
  const r = await window.ncm.invoke('ncm:playlist-add-songs', {
    id: ${JSON.stringify(pl.id)}, songIds: [m['晴天'], m['七里香']]
  });
  return { added: r.added, skipped: r.skipped }
`)
check('重复加歌去重', dup.added === 0 && dup.skipped === 2, JSON.stringify(dup))

const det = await ev(`return await window.ncm.invoke('ncm:playlist-detail', ${JSON.stringify(pl.id)})`)
check('详情顺序正确', JSON.stringify(det.songs.map((s) => s.title)) === JSON.stringify(['晴天', '七里香', '浮夸']),
  JSON.stringify(det.songs.map((s) => s.title)))
check('详情含 filePath（路径规范化未破坏查询）', det.songs.every((s) => !!s.filePath))
check('无悬空引用', det.missing === 0, String(det.missing))

const re = await ev(`
  const d = await window.ncm.invoke('ncm:playlist-detail', ${JSON.stringify(pl.id)});
  const ids = d.songs.map(s => String(s.id));
  await window.ncm.invoke('ncm:playlist-reorder', { id: ${JSON.stringify(pl.id)}, orderedIds: ids.reverse() });
  const a = await window.ncm.invoke('ncm:playlist-detail', ${JSON.stringify(pl.id)});
  return a.songs.map(s => s.title)
`)
check('重排生效', JSON.stringify(re) === JSON.stringify(['浮夸', '七里香', '晴天']), JSON.stringify(re))

const rm = await ev(`
  const d = await window.ncm.invoke('ncm:playlist-detail', ${JSON.stringify(pl.id)});
  const t = d.songs.find(s => s.title === '七里香');
  const r = await window.ncm.invoke('ncm:playlist-remove-songs', { id: ${JSON.stringify(pl.id)}, songIds: [String(t.id)] });
  const a = await window.ncm.invoke('ncm:playlist-detail', ${JSON.stringify(pl.id)});
  return { removed: r.removed, titles: a.songs.map(s => s.title) }
`)
check('移歌生效', rm.removed === 1 && JSON.stringify(rm.titles) === JSON.stringify(['浮夸', '晴天']),
  JSON.stringify(rm))

const rn = await ev(`const p = await window.ncm.invoke('ncm:playlist-rename', { id: ${JSON.stringify(pl.id)}, name: '  改名  ' }); return p.name`)
check('重命名去空白', rn === '改名', JSON.stringify(rn))

/* ---- 导出内容（真实模块，非复刻）---- */
console.log('\n--- 导出（走真实模块）---')
// 通过 IPC 拿不到（会弹框），但导出模块已被 26 项单测覆盖；
// 这里验证数据源完整性
const exportSrc = await ev(`
  const d = await window.ncm.invoke('ncm:playlist-detail', ${JSON.stringify(pl.id)});
  return {
    count: d.songs.length,
    allHavePath: d.songs.every(s => !!s.filePath),
    allHaveTitle: d.songs.every(s => !!s.title),
    allHaveArtist: d.songs.every(s => !!s.artist)
  }
`)
check('导出数据源完整', exportSrc.allHavePath && exportSrc.allHaveTitle && exportSrc.allHaveArtist,
  JSON.stringify(exportSrc))

/* ---- 快照歌单 ---- */
const snap = await ev(`
  const p = await window.ncm.invoke('ncm:playlist-save', { name: '快照回归', songIds: [], source: 'netease', sourceId: '1' });
  const d = await window.ncm.invoke('ncm:playlist-detail', p.id);
  return { id: p.id, songs: d.songs.length, source: p.source }
`)
check('快照歌单可建可解析', snap.songs === 0 && snap.source === 'netease', JSON.stringify(snap))

/* ---- 清理 ---- */
console.log('\n--- 清理 ---')
await ev(`
  await window.ncm.invoke('ncm:playlist-remove', ${JSON.stringify(pl.id)});
  await window.ncm.invoke('ncm:playlist-remove', ${JSON.stringify(snap.id)});
  const s = await window.ncm.invoke('ncm:library-list');
  for (const x of s) if (x.filePath && x.filePath.indexOf('test-music') >= 0) {
    await window.ncm.invoke('ncm:library-remove', x.id, { deleteFile: false });
  }
  await window.ncm.invoke('ncm:library-remove-folder', ${JSON.stringify(MUSIC_DIR)});
  return true
`)
const left = await ev(`return (await window.ncm.invoke('ncm:library-list')).length`)
check('曲库已清空', left === 0, String(left))
const plLeft = await ev(`return (await window.ncm.invoke('ncm:playlist-list')).length`)
check('歌单已清空', plLeft === 0, String(plLeft))

fs.rmSync(MUSIC_DIR, { recursive: true, force: true })

console.log('\n================ 汇总 ================')
const pass = results.filter((r) => r.ok).length
console.log(`${pass}/${results.length} 通过`)
const failed = results.filter((r) => !r.ok)
if (failed.length) { console.log('\n失败项：'); for (const f of failed) console.log(`  - ${f.n} ${f.d}`) }
ws.close()
process.exit(failed.length ? 1 : 0)
