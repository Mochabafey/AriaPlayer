/**
 * fetch-ffmpeg.mjs — 下载最新版 ffmpeg 静态构建到 resources/ffmpeg/
 *
 * 源：BtbN/FFmpeg-Builds（滚动发布，latest 即最新 master 构建）
 *   https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest
 * 产物：resources/ffmpeg/ffmpeg[.exe] + version.txt
 *
 * 用法：node scripts/fetch-ffmpeg.mjs
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import https from 'https'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const targetDir = path.join(root, 'resources', 'ffmpeg')

const ASSETS = {
  win32: 'ffmpeg-master-latest-win64-gpl.zip',
  darwin: 'ffmpeg-master-latest-macos64-gpl.zip',
  linux: 'ffmpeg-master-latest-linux64-gpl.zip'
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'User-Agent': 'ntr-fetch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        fs.unlinkSync(dest)
        console.log('  → 跟随跳转', res.headers.location)
        download(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
    })
    req.on('error', (e) => {
      file.close()
      fs.unlinkSync(dest, () => {})
      reject(e)
    })
  })
}

async function main() {
  const asset = ASSETS[process.platform]
  if (!asset) {
    console.error(`不支持平台: ${process.platform}`)
    process.exit(1)
  }
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`
  console.log(`下载最新版 ffmpeg (${process.platform})…`)
  console.log(`  ${url}`)

  const tmpZip = path.join(os.tmpdir(), `ffmpeg-${Date.now()}.zip`)
  try {
    await download(url, tmpZip)
    const size = fs.statSync(tmpZip).size / 1024 / 1024
    console.log(`  下载完成（${size.toFixed(1)} MB），解压中…`)

    const tmpDir = path.join(os.tmpdir(), `ffmpeg-x-${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    // Windows 用 PowerShell Expand-Archive，其他平台用 unzip/tar
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' })
    } else {
      execSync(`unzip -q -o '${tmpZip}' -d '${tmpDir}'`)
    }

    // 定位 bin/ffmpeg
    const binDir = path.join(tmpDir, asset.replace('.zip', ''), 'bin')
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const ffmpegBin = path.join(binDir, exeName)
    if (!fs.existsSync(ffmpegBin)) throw new Error(`未找到 ${ffmpegBin}`)

    fs.mkdirSync(targetDir, { recursive: true })
    fs.copyFileSync(ffmpegBin, path.join(targetDir, exeName))
    fs.writeFileSync(path.join(targetDir, 'version.txt'), `master-latest (${new Date().toISOString()})`)

    // 清理
    fs.unlinkSync(tmpZip)
    fs.rmSync(tmpDir, { recursive: true, force: true })

    // 验证
    const ver = execSync(`"${path.join(targetDir, exeName)}" -version`).toString().split('\n')[0]
    console.log(`✅ ffmpeg 就绪: ${ver}`)
    console.log(`   位置: ${path.join(targetDir, exeName)}`)
  } catch (e) {
    console.error('❌ 下载失败:', e.message)
    process.exit(1)
  }
}

main()
