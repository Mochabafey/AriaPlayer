/**
 * after-pack.cjs — electron-builder 打包后钩子
 *
 * 把 server/（含 node_modules）复制进 <outDir>/resources/ncm-server；
 * 把 qqmusic/（TS 源码 + node_modules）复制进 <outDir>/resources/qqmusic。
 *
 * 为什么需要：electron-builder 对 extraResources 的 from 目录**不复制 node_modules**
 * （已知行为），导致打包版内置服务缺依赖 → 子进程启动即崩。
 * 复制在 electron-builder 生成 win-unpacked/mac .app 之后、压缩成安装包之前执行。
 *
 * ## 复制时按 pack-filter 裁剪（见该模块说明）
 *
 * 载荷里大量内容与运行时无关（.git / 文档 / 截图 / @types / typescript /
 * @biomejs …）。便携版每次启动都要把它自解压到 %TEMP%，**文件数是耗时主因**，
 * 所以这里边复制边过滤。
 *
 * 注意：裁剪只作用于安装包内容，**源码目录原样不动** —— 开发、vendor
 * 升级、`npm run dev` 都不受影响。
 */
const fs = require('fs')
const path = require('path')
const { shouldExclude } = require('./pack-filter.cjs')

function copyTree(src, dest, label) {
  if (!fs.existsSync(src)) {
    console.log('[after-pack] skip (missing):', src)
    return
  }
  fs.rmSync(dest, { recursive: true, force: true })

  let kept = 0
  let skipped = 0
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p)
      if (!rel) return true
      // .bin 里是指向包内文件的符号链接/转发脚本，运行时用不到且可能悬空
      if (/[\\/]node_modules[\\/]\.bin([\\/]|$)/.test(rel)) { skipped++; return false }
      if (shouldExclude(rel)) { skipped++; return false }
      kept++
      return true
    }
  })
  console.log(`[after-pack] copied ${label}: ${kept} 个文件（跳过 ${skipped}）→ ${dest}`)
}

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const projectDir = packager.info.projectDir

  // 网易云 api-enhanced
  copyTree(
    path.join(projectDir, 'server'),
    path.join(appOutDir, 'resources', 'ncm-server'),
    'ncm-server'
  )
  // QQ音乐 api（Rain120，TS 源码 + 依赖）
  copyTree(
    path.join(projectDir, 'qqmusic'),
    path.join(appOutDir, 'resources', 'qqmusic'),
    'qqmusic'
  )
}
