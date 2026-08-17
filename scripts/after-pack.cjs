/**
 * after-pack.cjs — electron-builder 打包后钩子
 *
 * 把完整 server/（含 node_modules）复制进 <outDir>/resources/ncm-server；
 * 把完整 qqmusic/（Rain120 的 TS 源码 + node_modules，含 ts-node）复制进
 * <outDir>/resources/qqmusic。
 *
 * 为什么需要：electron-builder 对 extraResources 的 from 目录**不复制 node_modules**
 * （已知行为），导致打包版内置服务缺依赖 → 子进程启动即崩。
 * 复制在 electron-builder 生成 win-unpacked/mac .app 之后、压缩成安装包之前执行。
 */
const fs = require('fs')
const path = require('path')

function copyTree(src, dest) {
  if (!fs.existsSync(src)) {
    console.log('[after-pack] skip (missing):', src)
    return
  }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p)
      if (!rel) return true
      // 跳过纯开发/版本库内容，减小安装包
      if (/[\\/]\.git([\\/]|$)/.test(rel)) return false
      if (/[\\/]node_modules[\\/]\.bin([\\/]|$)/.test(rel)) return false
      return true
    }
  })
  console.log('[after-pack] copied', src, '->', dest)
}

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const projectDir = packager.info.projectDir

  // 网易云 api-enhanced（现有）
  copyTree(
    path.join(projectDir, 'server'),
    path.join(appOutDir, 'resources', 'ncm-server')
  )
  // QQ音乐 api（Rain120，TS 源码 + ts-node 等依赖）
  copyTree(
    path.join(projectDir, 'qqmusic'),
    path.join(appOutDir, 'resources', 'qqmusic')
  )
}
