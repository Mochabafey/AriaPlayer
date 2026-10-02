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

    const HDR = 'Referer: https://www.bilibili.com/\r\nOrigin: https://www.bilibili.com\r\n'
    const UA_ARG = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

    const args = ['-y', '-hide_banner']
    // 输入 1：视频流
    args.push('-user_agent', UA_ARG, '-headers', HDR, '-i', videoUrl)
    // 输入 2：音频流（有则加）
    if (audioUrl) {
      args.push('-user_agent', UA_ARG, '-headers', HDR, '-i', audioUrl)
      // -map 显式指定：0=视频流, 1=音频流。不指定时 ffmpeg 的自动选择在多流输入下不可靠
      args.push('-map', '0:v:0', '-map', '1:a:0')
    } else {
      args.push('-map', '0:v:0')
    }
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
