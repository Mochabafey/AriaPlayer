/**
 * 歌单文件的解析（纯函数，不依赖 electron）。
 *
 * 支持 M3U / M3U8 / JSON 三种，输出统一的「候选文件路径」列表。
 *
 * 为什么单独拆出来：
 *   解析逻辑原先内联在两个 IPC handler 里，各自弹一个 dialog.showOpenDialog
 *   才走得到 —— 无人值守环境下无法执行，等于没有测试覆盖。拆开后可直接单测。
 *
 * 拆的过程中还发现一处真实缺陷：JSON 分支只取 `s.filePath` 原样使用，
 * **没有解析相对路径**（m3u 分支有做）。导出的 JSON 里 filePath 通常是绝对
 * 路径所以没暴露，但手工写的 json 用相对路径就会全部匹配失败。此处统一处理。
 */
import path from 'path'

/** 可导入的音频扩展名（小写，含点） */
export const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.opus'])

/** 按扩展名判断是否音频文件 */
export function isAudioFile(p) {
  return AUDIO_EXTS.has(path.extname(String(p || '')).toLowerCase())
}

/**
 * 把歌单里的路径规范化为**本机形式**。
 *
 * ## 为什么必须做（真实缺陷）
 *
 * M3U 是跨平台的文本格式，**正斜杠是事实标准**：foobar2000、Winamp、
 * MusicBee 导出的 Windows 播放列表通常写成 `D:/Music/a.mp3`。
 * 而曲库（songs.filePath）里存的是 `path.join` 的产物，即 `D:\Music\a.mp3`。
 *
 * 查库用的是 `SELECT ... WHERE filePath = ?`（精确字符串匹配），
 * 于是 `D:/Music/a.mp3` 与 `D:\Music\a.mp3` **不相等** → 明明文件就在曲库里，
 * 却全部匹配失败、被算成 missing。用户看到「导入 0 首，跳过 50 首」。
 *
 * 注意 `path.isAbsolute('D:/x') === true`，所以光判 isAbsolute 并不能发现
 * 这个问题 —— 必须显式 normalize。
 *
 * 顺带处理 `..`、重复分隔符、以及 `.` 段。
 */
function normalizeEntryPath(p, baseDir) {
  const raw = String(p || '').trim()
  if (!raw) return ''
  const abs = path.isAbsolute(raw) ? raw : path.join(baseDir || '.', raw)
  // normalize 同时统一分隔符为平台风格，并折叠 .. / . / 重复分隔符
  return path.normalize(abs)
}

/**
 * 从 M3U 文本里抽出条目路径。
 *
 * M3U 的约定：`#` 开头是注释/指令（#EXTM3U、#EXTINF 等），其余非空行是路径。
 * 路径可能是相对当前歌单文件的（相对路径相对**歌单文件所在目录**解析）。
 *
 * @param {string} raw     文件内容
 * @param {string} baseDir 歌单文件所在目录（用于解析相对路径）
 * @returns {string[]} 绝对路径列表（保持文件内顺序，不去重 —— 调用方决定）
 */
export function parseM3U(raw, baseDir) {
  const out = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    out.push(normalizeEntryPath(t, baseDir))
  }
  return out
}

/**
 * 从 JSON 里抽出条目路径。
 *
 * 兼容两种形态：
 *   1. 本项目导出的歌单快照：`{ name, songs: [{ filePath }] }`
 *   2. 曲库清单：`[{ filePath }]`（ipc/library.js 的 library-export 产物）
 *
 * @returns {{paths: string[], error: string|null}}
 */
export function parseJSONPlaylist(raw, baseDir) {
  let data
  try {
    data = JSON.parse(String(raw || ''))
  } catch (e) {
    return { paths: [], error: 'JSON 解析失败：' + e.message }
  }
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.songs) ? data.songs : null)
  if (!arr) return { paths: [], error: 'JSON 结构无法识别（应为数组或含 songs 数组的对象）' }

  const out = []
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue
    const fp = s.filePath
    if (!fp || typeof fp !== 'string') continue
    out.push(normalizeEntryPath(fp, baseDir))
  }
  return { paths: out, error: null }
}

/**
 * 统一入口：按扩展名解析歌单文件内容。
 *
 * @param {string} raw  文件内容
 * @param {string} file 文件绝对路径（用于取扩展名与相对路径基准）
 * @returns {{paths: string[], error: string|null, kind: 'm3u'|'json'|null}}
 */
export function parsePlaylistFile(raw, file) {
  const ext = path.extname(String(file || '')).toLowerCase()
  const baseDir = path.dirname(String(file || '.'))
  if (ext === '.json') {
    const r = parseJSONPlaylist(raw, baseDir)
    return { paths: r.paths, error: r.error, kind: 'json' }
  }
  if (ext === '.m3u' || ext === '.m3u8') {
    return { paths: parseM3U(raw, baseDir), error: null, kind: 'm3u' }
  }
  return { paths: [], error: `不支持的文件类型：${ext || '(无扩展名)'}`, kind: null }
}
