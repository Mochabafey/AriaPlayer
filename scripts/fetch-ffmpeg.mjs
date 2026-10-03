/**
 * fetch-ffmpeg.mjs — 下载 ffmpeg 静态构建到 resources/ffmpeg/
 *
 * ## 为什么分两个源
 *
 * BtbN/FFmpeg-Builds 是社区最常用的滚动构建源，但**只发布 Windows 与 Linux**，
 * 没有 macOS（实测 `ffmpeg-master-latest-macos64-gpl.zip` 返回 404）。
 * 因此 macOS 走 eugeneware/ffmpeg-static —— 它提供全平台单文件二进制。
 *
 *   Windows / Linux → BtbN（zip / tar.xz 压缩包，需解压）
 *   macOS           → eugeneware（裸可执行文件，无需解压）
 *
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

/** BtbN 的压缩包名（按平台/架构） */
function btbNAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : '64'
  const osName = process.platform === 'win32' ? 'win' : 'linux'
  const ext = process.platform === 'win32' ? 'zip' : 'tar.xz'
  return `ffmpeg-master-latest-${osName}${arch}-gpl.${ext}`
}

/** eugeneware 的裸二进制名（macOS 用） */
function eugenewareAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `ffmpeg-darwin-${arch}`
}

/**
 * 数据源定义。
 *   kind: 'archive' 压缩包（需解压后找 bin/ffmpeg）
 *         'binary'  裸可执行文件（下载即可用）
 */
function pickSource() {
  if (process.platform === 'darwin') {
    return {
      name: 'eugeneware/ffmpeg-static',
      kind: 'binary',
      asset: eugenewareAsset(),
      base: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
    }
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    return {
      name: 'BtbN/FFmpeg-Builds',
      kind: 'archive',
      asset: btbNAsset(),
      base: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
    }
  }
  return null
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'User-Agent': 'aria-fetch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        console.log('  → 跟随跳转', res.headers.location.slice(0, 90))
        download(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        file.close()
        try { fs.unlinkSync(dest) } catch { /* ignore */ }
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
    })
    req.on('error', (e) => {
      file.close()
      try { fs.unlinkSync(dest) } catch { /* ignore */ }
      reject(e)
    })
  })
}

async function main() {
  const src = pickSource()
  if (!src) {
    console.error(`不支持平台: ${process.platform}/${process.arch}`)
    process.exit(1)
  }
  const url = `${src.base}/${src.asset}`
  console.log(`下载 ffmpeg（${process.platform}/${process.arch}，源: ${src.name}）…`)
  console.log(`  ${url}`)

  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dest = path.join(targetDir, exeName)

  // 临时文件：压缩包保持原扩展名（解压工具靠它判断格式），裸二进制用 .bin
  const tmpExt = src.kind === 'archive' ? path.extname(src.asset) : '.bin'
  const tmpFile = path.join(os.tmpdir(), `ffmpeg-${Date.now()}${tmpExt}`)

  try {
    await download(url, tmpFile)
    const size = fs.statSync(tmpFile).size / 1024 / 1024
    console.log(`  下载完成（${size.toFixed(1)} MB）`)

    fs.mkdirSync(targetDir, { recursive: true })

    if (src.kind === 'binary') {
      // 裸二进制：直接搬过去 + 赋可执行权限
      fs.copyFileSync(tmpFile, dest)
      fs.chmodSync(dest, 0o755)
      console.log('  已就位（单文件二进制，无需解压）')
    } else {
      // 压缩包：解压后从 bin/ 取 ffmpeg
      const tmpDir = path.join(os.tmpdir(), `ffmpeg-x-${Date.now()}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      if (process.platform === 'win32') {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Path '${tmpFile}' -DestinationPath '${tmpDir}' -Force"`,
          { stdio: 'inherit' }
        )
      } else {
        // tar.xz 用 tar（Linux/macOS 自带）；旧版脚本假设 zip 用 unzip，这里按实际扩展名分支
        if (tmpFile.endsWith('.tar.xz')) {
          execSync(`tar -xJf '${tmpFile}' -C '${tmpDir}'`)
        } else {
          execSync(`unzip -q -o '${tmpFile}' -d '${tmpDir}'`)
        }
      }
      const inner = fs.readdirSync(tmpDir)[0]
      const binDir = path.join(tmpDir, inner, 'bin')
      const ffmpegBin = path.join(binDir, exeName)
      if (!fs.existsSync(ffmpegBin)) throw new Error(`未找到 ${ffmpegBin}`)
      fs.copyFileSync(ffmpegBin, dest)
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    fs.writeFileSync(
      path.join(targetDir, 'version.txt'),
      `${src.name} / ${src.asset} (${new Date().toISOString()})`
    )

    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }

    // 验证可执行
    const ver = execSync(`"${dest}" -version`).toString().split('\n')[0]
    console.log(`✅ ffmpeg 就绪: ${ver}`)
    console.log(`   位置: ${dest}`)
  } catch (e) {
    console.error('❌ 下载失败:', e.message)
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    process.exit(1)
  }
}

main()
