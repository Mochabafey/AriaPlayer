/**
 * ncm-dump.mjs — .ncm 解密命令行工具（验证/独立使用）
 * 用法：
 *   node scripts/ncm-dump.mjs <file.ncm> [outputDir]
 *   node scripts/ncm-dump.mjs <dir> [-r] [outputDir]   # 目录（-r 递归）
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { decryptNcmFile, collectNcmFiles } from '../src/main/ncm/ncmDecrypt.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
if (!args.length) {
  console.log('用法: node scripts/ncm-dump.mjs <file.ncm|dir> [outputDir]  (-r 递归目录)')
  process.exit(1)
}

const recursive = args.includes('-r')
const rest = args.filter((a) => a !== '-r')
const input = path.resolve(rest[0])
const outputDir = rest[1] ? path.resolve(rest[1]) : path.dirname(input)
const coverDir = path.join(outputDir, '.covers')

let files = []
if (fs.statSync(input).isDirectory()) {
  files = collectNcmFiles(input).filter((f) => recursive || path.dirname(f) === input)
} else {
  files = [input]
}

if (!files.length) {
  console.log('未找到 .ncm 文件')
  process.exit(0)
}

console.log(`共 ${files.length} 个文件，输出目录: ${outputDir}\n`)

let ok = 0
let fail = 0
for (const f of files) {
  const r = await decryptNcmFile(f, { outputDir, coverDir, writeTags: true })
  if (r.ok) {
    ok++
    const title = r.meta && r.meta.title ? `${r.meta.artist} - ${r.meta.title}` : path.basename(f)
    console.log(`✅ ${title} → ${path.basename(r.outPath)}${r.wroteTag ? ' (已写标签)' : ''}`)
  } else {
    fail++
    console.log(`❌ ${path.basename(f)}: ${r.error}`)
  }
}

console.log(`\n完成: 成功 ${ok}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
