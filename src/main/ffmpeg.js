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
