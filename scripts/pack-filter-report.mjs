/**
 * 裁剪规则干跑：统计会保留/排除多少，并列出被排除的「非显然」项供人工复核。
 * 用法：node scripts/pack-filter-report.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { shouldExclude } = require('./pack-filter.cjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function walk(dir, base, stats, excludedSamples) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full)
    if (e.isDirectory()) {
      // 目录本身也走过滤（整目录被排时可提前剪枝，避免遍历几万个文件）
      if (shouldExclude(rel + path.sep)) { stats.excludedDirs++; continue }
      walk(full, base, stats, excludedSamples)
    } else {
      let sz = 0
      try { sz = fs.statSync(full).size } catch { /* ignore */ }
      if (shouldExclude(rel)) {
        stats.excludedFiles++
        stats.excludedBytes += sz
        // 记录「值得复核」的排除项：不在明显黑名单目录里的
        if (!/[\\/](\.git|docs|screenshot|tests|\.agents|\.claude|\.kiro|\.trae|\.iflow|\.skills|\.codebuddy|\.continue|\.github|skills)[\\/]/.test(rel)
            && !/node_modules[\\/](@types|typescript|@biomejs|ts-node|jest|ts-jest|eslint|prettier|husky|lint-staged|supertest|mocha|chai)[\\/]/.test(rel)) {
          excludedSamples.push({ rel, sz })
        }
      } else {
        stats.keptFiles++
        stats.keptBytes += sz
      }
    }
  }
}

for (const target of ['server', 'qqmusic']) {
  const base = path.join(root, target)
  if (!fs.existsSync(base)) { console.log(`(跳过 ${target}：不存在)`); continue }
  const stats = { keptFiles: 0, keptBytes: 0, excludedFiles: 0, excludedBytes: 0, excludedDirs: 0 }
  const samples = []
  walk(base, base, stats, samples)

  const mb = (b) => (b / 1024 / 1024).toFixed(1)
  console.log(`\n=== ${target} ===`)
  console.log(`  保留: ${stats.keptFiles} 文件  ${mb(stats.keptBytes)} MB`)
  console.log(`  排除: ${stats.excludedFiles} 文件  ${mb(stats.excludedBytes)} MB（另剪掉 ${stats.excludedDirs} 个整目录）`)

  if (samples.length) {
    console.log(`  ⚠ 需复核的排除项（${samples.length} 个，按大小取前 15）:`)
    samples.sort((a, b) => b.sz - a.sz).slice(0, 15).forEach((s) => {
      console.log(`      ${(s.sz / 1024).toFixed(0).padStart(6)} KB  ${s.rel}`)
    })
  } else {
    console.log('  ✓ 无「非显然」排除项（全部落在明确的开发/文档类别）')
  }
}
