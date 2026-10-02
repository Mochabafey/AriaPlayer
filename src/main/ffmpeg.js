/**
 * ffmpeg.js — ffmpeg 封装（定位二进制、版本探测、转码）
 * 二进制由 scripts/fetch-ffmpeg.mjs 下载到 resources/ffmpeg/（不入 git，打包走 extraResources）
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

export function ffmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', exe)
  return path.join(app.getAppPath(), 'resources', 'ffmpeg', exe)
}

export function ffmpegAvailable() {
  try {
    return fs.existsSync(ffmpegPath())
  } catch {
    return false
  }
}

/** 获取 ffmpeg 版本第一行 */
export function ffmpegVersion() {
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath(), ['-version'])
      let out = ''
      p.stdout.on('data', (d) => (out += d.toString()))
      p.stderr.on('data', (d) => (out += d.toString()))
      p.on('error', () => resolve(null))
      p.on('close', () => resolve(out.split('\n')[0] || 'unknown'))
    } catch {
      resolve(null)
    }
  })
}

/**
 * 通用转码：ffmpeg -y -i input [extraArgs...] output
 * input 可为本地文件或 http(s) URL（自动带 UA/Referer）
 */
export function transcode(input, output, extraArgs = []) {
  return new Promise((resolve, reject) => {
    if (!ffmpegAvailable()) return reject(new Error('ffmpeg 未安装（运行 node scripts/fetch-ffmpeg.mjs）'))
    const args = ['-y']
    if (/^https?:\/\//.test(input)) {
      args.push(
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        '-headers',
        'Referer: https://music.163.com/\r\n'
      )
    } else if (input.startsWith('-')) {
      // 防御 flag 注入：本地路径以 - 开头会被 ffmpeg 当选项解析，加 ./ 前缀归一为路径
      input = `./${input}`
    }
    args.push('-i', input, ...extraArgs, output)
    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`ffmpeg exit ${code}: ${err.split('\n').slice(-2).join(' ')}`))
    })
  })
}

/** 任意音频 → wav（供播放回退） */
export async function transcodeToWav(input, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true })
  const out = path.join(outputDir, `transcode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  await transcode(input, out, ['-vn', '-acodec', 'pcm_s16le'])
  return out
}

/** 任意音频 → mp3（供下载后格式转换） */
export async function transcodeToMp3(input, outputDir, name) {
  fs.mkdirSync(outputDir, { recursive: true })
  const safe = String(name || 'audio').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
  const out = path.join(outputDir, `${safe}.mp3`)
  await transcode(input, out, ['-vn', '-codec:a', 'libmp3lame', '-q:a', '2'])
  return out
}

/** B 站 CDN 需要的防盗链头（视频/音频流共用） */
const BILI_HDR = 'Referer: https://www.bilibili.com/\r\nOrigin: https://www.bilibili.com\r\n'
const FFMPEG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 构造「双输入 + 流映射」的公共参数。
 * 合流全量与 HLS 实时两条路径共用，避免参数漂移。
 */
function dashInputArgs(videoUrl, audioUrl) {
  const args = []
  // 输入 1：视频流
  args.push('-user_agent', FFMPEG_UA, '-headers', BILI_HDR, '-i', videoUrl)
  if (audioUrl) {
    // 输入 2：音频流
    args.push('-user_agent', FFMPEG_UA, '-headers', BILI_HDR, '-i', audioUrl)
    // -map 显式指定：0=视频流, 1=音频流。
    // 不指定时 ffmpeg 的自动选择在多流输入下不可靠（可能只挑到一路）
    args.push('-map', '0:v:0', '-map', '1:a:0')
  } else {
    args.push('-map', '0:v:0')
  }
  return args
}

/**
 * B 站 DASH 流合流：音视频分离的两个远程流 → 单个 mp4。
 *
 * B 站高清（720P 以上）返回的是分离的 video/audio 流，<video> 标签无法直接播放，
 * 必须先用 ffmpeg 合流。
 *
 * 关键参数说明：
 *   -headers 里必须带 Referer/UA：B 站 CDN 校验防盗链，缺了直接 403
 *   -c copy  不重编码，只做容器封装（秒级完成，无损）
 *   +faststart 把 moov 移到文件头，边下边播/seek 才正常（否则要下完才能播）
 *   -shortest 以较短的流为准，避免音视频时长微差导致尾部黑屏
 *
 * 注意：本函数是**全量合流**（要等下完整个文件才能播，体验割裂）。
 * 追求秒开请用 mergeDashToHls()（边合边播）。
 *
 * @param {string} videoUrl 视频流地址
 * @param {string} audioUrl 音频流地址（可为空，此时只处理视频流）
 * @param {string} output   输出文件路径（.mp4）
 * @param {(p:{percent:number,time:string,speed:string})=>void} onProgress 进度回调
 */
export function mergeDashStreams(videoUrl, audioUrl, output, onProgress) {
  return new Promise((resolve, reject) => {
    if (!ffmpegAvailable()) {
      return reject(new Error('ffmpeg 未安装，无法合流 DASH 流（运行 node scripts/fetch-ffmpeg.mjs）'))
    }
    fs.mkdirSync(path.dirname(output), { recursive: true })

    const args = ['-y', '-hide_banner']
    args.push(...dashInputArgs(videoUrl, audioUrl))
    args.push(
      '-c', 'copy',       // 不重编码
      '-shortest',        // 以较短的流为准
      '-movflags', '+faststart', // moov 前置，支持边下边播
      // 显式指定容器：ffmpeg 靠扩展名推断格式，临时文件名若不以 .mp4 结尾
      // （如 xxx.mp4.part）会报 "Unable to choose an output format"
      '-f', 'mp4',
      '-progress', 'pipe:1',     // 进度输出到 stdout（结构化，便于解析）
      '-nostats',
      output
    )

    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    let errBuf = ''
    let outBuf = ''
    // -progress pipe:1 输出形如 out_time_ms=123456 / speed=2.5x / progress=continue
    p.stdout.on('data', (d) => {
      outBuf += d.toString()
      const lines = outBuf.split('\n')
      outBuf = lines.pop() || ''
      if (!onProgress) return
      const kv = {}
      for (const line of lines) {
        const i = line.indexOf('=')
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      if (kv.out_time_ms || kv.speed) {
        const us = Number(kv.out_time_ms || 0)
        onProgress({
          percent: -1, // 总时长未知（远程流），百分比由调用方按 duration 计算
          time: us > 0 ? fmtHms(us / 1e6) : '',
          speed: kv.speed || ''
        })
      }
    })
    p.stderr.on('data', (d) => {
      errBuf += d.toString()
      // 只保留尾部，避免长视频日志爆内存
      if (errBuf.length > 8192) errBuf = errBuf.slice(-4096)
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`ffmpeg 合流失败 exit ${code}: ${errBuf.split('\n').slice(-3).join(' ')}`))
    })
  })
}

/** 秒 → hh:mm:ss / mm:ss */
function fmtHms(sec) {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}

/**
 * B 站 DASH 流 → HLS 实时合流（边合边播，解决全量合流的「割裂感」）。
 *
 * ## 为什么需要它
 *
 * 全量合流（mergeDashStreams）要等整个视频下完才能播 —— 用户点播放后
 * 盯着「正在合并音视频流…」等几十秒甚至几分钟，体验割裂。
 *
 * ## 原理
 *
 * ffmpeg 把音视频合流后切成小分片（fMP4）+ 一个 m3u8 播放列表，
 * 边生成边写盘。渲染层用 hls.js 播放这个 m3u8，hls.js 会不断重读
 * 播放列表，发现新分片就加载 —— 于是「首片生成即可开播」，
 * 首帧延迟从「整片时长」降到「约 1 个分片（2 秒）」。
 *
 * ## 关键参数
 *
 *   -hls_time 2            每片 2 秒（越小首帧越快，但请求更频繁）
 *   -hls_list_size 0       播放列表保留全部分片（便于 seek 回看）
 *   -hls_segment_type fmp4 fMP4 分片（avc/hevc 都可直接封装，无需重编码）
 *   -hls_flags ...         见下方注释
 *   -c copy                不重编码（合流只是容器封装，几乎零 CPU）
 *
 * @param {string} videoUrl 视频流地址
 * @param {string} audioUrl 音频流地址
 * @param {string} outDir   输出目录（m3u8 与分片写在这里）
 * @param {object} opts
 *   - onStarted?: () => void        首次产出 m3u8（可播）时回调
 *   - onExit?: (code, err) => void  进程退出回调
 * @returns {{ proc: import('child_process').ChildProcess, playlist: string, stop: () => void }}
 */
export function mergeDashToHls(videoUrl, audioUrl, outDir, opts = {}) {
  if (!ffmpegAvailable()) {
    throw new Error('ffmpeg 未安装，无法合流 DASH 流（运行 node scripts/fetch-ffmpeg.mjs）')
  }
  fs.mkdirSync(outDir, { recursive: true })
  const playlist = path.join(outDir, 'index.m3u8')
  const segPattern = path.join(outDir, 'seg%05d.m4s')
  /**
   * init 段（fMP4 的初始化分片）用**相对名**，并配合 cwd=outDir。
   *
   * 坑：-hls_fmp4_init_filename 传相对名时，ffmpeg 按**进程当前工作目录**
   * 解析，而不是输出目录 —— 若 cwd 不是 outDir，init.mp4 会被写到别处，
   * m3u8 里却声明了 #EXT-X-MAP:URI="init.mp4"，hls.js 拿不到 init 段
   * → 无法初始化 SourceBuffer → 播放失败。
   *（实测：产出目录只有 index.m3u8 与 .m4s，没有 init.mp4）
   *
   * 不能改用绝对路径：ffmpeg 会把绝对路径原样写进 m3u8 的 URI
   *（#EXT-X-MAP:URI="C:\...\init.mp4"），hls.js 据此请求会失败。
   *
   * 正解：init 用相对名 + spawn 时 cwd 设为 outDir。
   */
  const initName = 'init.mp4'

  const args = ['-y', '-hide_banner', '-loglevel', 'warning']
  args.push(...dashInputArgs(videoUrl, audioUrl))
  args.push(
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', initName,
    '-hls_segment_filename', segPattern,
    /**
     * hls_flags 说明：
     *   independent_segments  每个分片可独立解码（seek 到任意分片都能播）
     *   omit_endlist          不写 #EXT-X-ENDLIST —— 关键！写了表示"流已结束"，
     *                         hls.js 会停止轮询播放列表，边合边播就断了
     *   temp_file             m3u8 先写临时文件再原子改名，避免 hls.js
     *                         读到写了一半的列表（解析失败）
     */
    '-hls_flags', 'independent_segments+omit_endlist+temp_file',
    playlist
  )

  // cwd=outDir：让 -hls_fmp4_init_filename 的相对名落在输出目录
  //（详见上方 initName 的注释）
  const proc = spawn(ffmpegPath(), args, { windowsHide: true, cwd: outDir })
  let errBuf = ''
  proc.stderr.on('data', (d) => {
    errBuf += d.toString()
    if (errBuf.length > 8192) errBuf = errBuf.slice(-4096)
  })

  // 轮询 m3u8 是否已产出且含至少一个分片 → 通知调用方可开播
  let started = false
  const watchTimer = setInterval(() => {
    if (started) return
    try {
      if (!fs.existsSync(playlist)) return
      const txt = fs.readFileSync(playlist, 'utf-8')
      // 有分片条目（非注释行）才认为可播
      if (/\.m4s\s*$/m.test(txt)) {
        started = true
        clearInterval(watchTimer)
        opts.onStarted?.()
      }
    } catch { /* 列表正在写入，下次再试 */ }
  }, 150)

  proc.on('error', (e) => {
    clearInterval(watchTimer)
    opts.onExit?.(-1, e.message)
  })
  proc.on('close', (code) => {
    clearInterval(watchTimer)
    const err = code === 0 ? '' : errBuf.split('\n').slice(-3).join(' ').trim()
    opts.onExit?.(code, err)
  })

  return {
    proc,
    playlist,
    outDir,
    /** 停止合流（切换画质/关闭播放器时调用） */
    stop: () => {
      clearInterval(watchTimer)
      try { proc.kill() } catch { /* ignore */ }
    }
  }
}
