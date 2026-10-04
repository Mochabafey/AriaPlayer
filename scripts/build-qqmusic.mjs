/**
 * build-qqmusic.mjs — 把 qqmusic 的 TypeScript 源码预编译为单个 CJS 文件。
 *
 * ## 为什么需要
 *
 * qqmusic（Rain120/qq-music-api）是 TS 项目，原实现用 `ts-node/register`
 * **运行时实时编译** 92 个 TS 文件。实测冷启动：
 *
 *     ts-node 实时编译:  ~4900ms（首次）/ ~1100ms（二次，有缓存）
 *     esbuild 预编译:     ~380ms
 *
 * 快 3~13 倍。虽然 v0.3.4 已把 QQ 音乐改为懒启动（不阻塞首屏），
 * 但用户首次切到 QQ 音源时仍要等好几秒 —— 预编译消除这个等待。
 *
 * ## 产物位置（重要）
 *
 * 输出到 `qqmusic/dist/app.cjs`。这个位置是**刻意选的**：
 *
 * 源码 `src/app.ts` 里有 `path.join(__dirname, '../public')`，
 * 源码下 `__dirname = qqmusic/src` → `../public = qqmusic/public` ✅
 *
 * 产物在 `qqmusic/dist/` 下时 `__dirname = qqmusic/dist`
 * → `../public = qqmusic/public` ✅ **语义自动一致**，无需任何 hack。
 *
 * 若输出到别处（如项目根的 build/），`../public` 就会指错 —— 所以
 * 不要随意改 outfile 路径。
 *
 * ## 为什么用 packages: 'external'
 *
 * qqmusic 的运行时依赖（koa/axios 等）留在 node_modules 里按需 require，
 * 不打进 bundle：
 *   - 产物仅 ~92 KB（vs bundle 全部依赖的几十 MB）
 *   - 依赖升级不影响产物
 *   - 避免 esbuild 打包原生模块/动态 require 时的坑
 *
 * ## 用法
 *
 *     node scripts/build-qqmusic.mjs          # 增量（产物存在且比源码新则跳过）
 *     node scripts/build-qqmusic.mjs --force  # 强制重建
 */
import esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const qqRoot = path.join(root, 'qqmusic')
const srcEntry = path.join(qqRoot, 'src', 'app.ts')
const outDir = path.join(qqRoot, 'dist')
const outFile = path.join(outDir, 'app.cjs')

const force = process.argv.includes('--force')

/** 取目录下最新修改时间（用于判断是否需要重建） */
function newestMtime(dir, filter) {
  let newest = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue
        walk(p)
      } else if (filter(e.name)) {
        try {
          const m = fs.statSync(p).mtimeMs
          if (m > newest) newest = m
        } catch { /* ignore */ }
      }
    }
  }
  walk(dir)
  return newest
}

function main() {
  if (!fs.existsSync(srcEntry)) {
    console.error('[build-qqmusic] 源码不存在:', srcEntry)
    console.error('  请先运行: node scripts/vendor-qqmusic.mjs')
    process.exit(1)
  }

  // 增量：产物比所有源码新就跳过
  if (!force && fs.existsSync(outFile)) {
    const outM = fs.statSync(outFile).mtimeMs
    const srcM = newestMtime(path.join(qqRoot, 'src'), (n) => n.endsWith('.ts'))
    const pkgM = (() => { try { return fs.statSync(path.join(qqRoot, 'package.json')).mtimeMs } catch { return 0 } })()
    if (outM > srcM && outM > pkgM) {
      console.log('[build-qqmusic] 产物已是最新，跳过（--force 强制重建）')
      return
    }
  }

  fs.mkdirSync(outDir, { recursive: true })
  const t0 = Date.now()

  try {
    esbuild.buildSync({
      entryPoints: [srcEntry],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      // 运行时依赖留在 node_modules，不打进产物
      packages: 'external',
      // 保持 __dirname 语义（见文件头说明）
      logLevel: 'warning',
      banner: {
        js: '// [prebuilt] esbuild 预编译产物，请勿手改。源码见 qqmusic/src/'
      }
    })
  } catch (e) {
    console.error('[build-qqmusic] 编译失败:', e.message)
    process.exit(1)
  }

  const size = fs.statSync(outFile).size
  console.log(`[build-qqmusic] ✅ 编译完成 ${Date.now() - t0}ms  ${(size / 1024).toFixed(1)} KB`)
  console.log(`[build-qqmusic]    产物: ${path.relative(root, outFile)}`)
}

main()
