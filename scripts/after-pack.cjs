/**
 * after-pack.cjs — electron-builder 打包后钩子
 *
 * 把完整 server/（含 node_modules）复制进 <outDir>/resources/ncm-server。
 *
 * 为什么需要：electron-builder 对 extraResources 的 from 目录**不复制 node_modules**
 * （已知行为），导致打包版 ncm-server 缺全部依赖（axios/express/...）→
 * 子进程启动即崩 → 内置服务未就绪 → 登录二维码等依赖服务的功能全部失效。
 * 复制在 electron-builder 生成 win-unpacked/mac .app 之后、压缩成安装包之前执行，
 * 产物体积增加约 30MB（server 依赖），换来服务可用。
 */
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const projectDir = packager.info.projectDir
  const src = path.join(projectDir, 'server')
  const dest = path.join(appOutDir, 'resources', 'ncm-server')

  if (!fs.existsSync(src)) {
    console.log('[after-pack] server/ not found, skip')
    return
  }

  // 先清掉 electron-builder 复制的不完整版本（缺 node_modules），再整体覆盖
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
  console.log('[after-pack] copied server ->', dest)
}
