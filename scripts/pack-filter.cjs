/**
 * 打包载荷裁剪规则（供 after-pack.cjs 与 vendor 脚本共用）。
 *
 * ## 为什么要裁
 *
 * 便携版每次启动都要把载荷自解压到 %TEMP%，**耗时主要由文件数决定**
 *（实测 234MB / 27000+ 文件在机械盘上约 100 秒）。而载荷里有大量
 * 运行时根本用不到的东西：
 *
 *   qqmusic/@biomejs      21 文件   64.4 MB   （代码格式化工具）
 *   qqmusic/typescript   132 文件   22.5 MB   （已被 esbuild 预编译替代）
 *   qqmusic/.git          38 文件   15.9 MB   （版本库）
 *   qqmusic/screenshot    51 文件   13.1 MB   （文档截图）
 *   qqmusic/@types       973 文件    3.7 MB   （纯类型定义）
 *   server/data/deviceid 1 文件     1.3 MB    （设备指纹池，运行时按需生成）
 *
 * ## 安全前提
 *
 * 这些**只影响安装包内容，不影响源码目录**（vendor 出来的原样保留，
 * 便于开发与升级）。裁剪在复制到 resources/ 时进行。
 *
 * 判据保守：只裁「明确与运行时无关」的类别（版本库、文档、截图、
 * 类型定义、构建工具、测试）。运行时会 require 的依赖一律保留 ——
 * 宁可能大一点，也不能让内置服务起不来。
 */

/** 目录名黑名单：这些目录在任何层级都不进安装包 */
const EXCLUDED_DIRS = new Set([
  '.git',
  '.github',
  '.agents',
  '.claude',
  '.codebuddy',
  '.continue',
  '.iflow',
  '.kiro',
  '.skills',
  '.trae',
  '.husky',
  '.vscode',
  'screenshot',
  'screenshots',
  'docs',
  'tests',
  '__tests__',
  'coverage',
  'skills'
])

/**
 * node_modules 下的包名黑名单：开发/构建期工具，运行时不需要。
 *
 * 逐项说明为什么安全：
 *   typescript / ts-node / ts-node-dev —— qqmusic 已由 build-qqmusic.mjs
 *     预编译成 dist/app.cjs（bridge 优先加载它），且本项目不再走 ts-node 路径
 *     （bridge 里那条 require('ts-node') 只是「产物缺失时」的回退分支，
 *      打包版必然带 dist/app.cjs）
 *   @biomejs / eslint / prettier —— 纯 lint/格式化
 *   jest / ts-jest / supertest / mocha / chai —— 测试框架
 *   @types —— 纯 TS 类型声明，运行时零作用
 *   husky / lint-staged / commitlint —— git 钩子
 *   docsify-cli / conventional-changelog-cli —— 文档与发版工具
 */
const EXCLUDED_PACKAGES = new Set([
  'typescript',
  'ts-node',
  'ts-node-dev',
  '@biomejs',
  '@types',
  '@typescript-eslint',
  'eslint',
  'prettier',
  'jest',
  'ts-jest',
  'babel-jest',
  'supertest',
  'mocha',
  'chai',
  'husky',
  'lint-staged',
  '@commitlint',
  'commitlint',
  'docsify-cli',
  'conventional-changelog-cli',
  'standard-version'
])

/** 文件名黑名单（任意层级） */
const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db'
])

/**
 * 判断某路径是否应从安装包中排除。
 *
 * @param {string} relPath 相对载荷根目录的路径（用 / 分隔）。
 *   目录可带结尾分隔符（如 'screenshot/'）—— 目录本身也要能命中，
 *   否则遍历时无法提前剪枝（几万个文件的树会白走一遍）。
 * @returns {boolean} true = 排除
 */
function shouldExclude(relPath) {
  const raw = String(relPath || '')
  const isDir = /[\\/]$/.test(raw)
  const parts = raw.split(/[\\/]/).filter(Boolean)
  if (!parts.length) return false

  const base = parts[parts.length - 1]

  /**
   * 目录黑名单匹配。
   *
   * 目录本身（isDir）要看**最后一段**，文件则看它所有的祖先目录段。
   * 否则 `screenshot`（目录）与 `screenshot/a.png`（文件）会一个漏一个中。
   */
  const dirParts = isDir ? parts : parts.slice(0, -1)
  for (const p of dirParts) {
    if (EXCLUDED_DIRS.has(p)) return true
  }

  const inNodeModules = parts.includes('node_modules')

  // node_modules 下的包名黑名单
  const nmIdx = parts.lastIndexOf('node_modules')
  if (nmIdx >= 0 && nmIdx < parts.length - 1) {
    const pkg = parts[nmIdx + 1]
    if (EXCLUDED_PACKAGES.has(pkg)) return true
    // scoped 包（@scope/name）：目录本身只有 scope 一段，也按 scope 命中
    if (pkg.startsWith('@')) {
      if (nmIdx + 2 >= parts.length) return EXCLUDED_PACKAGES.has(pkg)
      if (EXCLUDED_PACKAGES.has(`${pkg}/${parts[nmIdx + 2]}`)) return true
    }
  }

  // 目录到这里就够了（文件名/扩展名规则只对文件有意义）
  if (isDir) return false

  if (EXCLUDED_FILES.has(base)) return true

  // 扩展名
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = base.slice(dot).toLowerCase()

  // sourcemap / 文档：任何位置都无运行时作用
  if (ext === '.map' || ext === '.md' || ext === '.markdown') return true

  // .ts 只在 node_modules 内排除 —— 依赖包里不会有「被 require 的 .ts」
  //（那是 TS 源码，运行时只认编译后的 .js）。而载荷根目录下的 .ts 是
  // qqmusic/src/app.ts 这类真入口，必须保留。
  if (ext === '.ts' && inNodeModules) return true

  return false
}

module.exports = { shouldExclude, EXCLUDED_DIRS, EXCLUDED_PACKAGES }
