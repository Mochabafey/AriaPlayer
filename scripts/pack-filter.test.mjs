/**
 * 打包载荷裁剪规则的单元测试。
 *
 * 跑法：node scripts/pack-filter.test.mjs
 *
 * 为什么这个测试很重要：裁剪规则直接决定「内置服务能不能起来」。
 * 误裁一个运行时依赖 → 打包版 QQ 音乐服务静默失效，而开发模式完全正常，
 * 极难发现。所以这里把「必须保留」的关键路径逐一钉死。
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { shouldExclude } = require('./pack-filter.cjs')

let pass = 0
let fail = 0
function t(p, want, desc) {
  const got = shouldExclude(p)
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${(got ? '排除' : '保留').padEnd(4)} ${p.padEnd(46)} ${desc}`)
}

console.log('--- 必须排除（开发/文档/版本库）---')
t('.git/', true, 'git 目录本身')
t('.git/config', true, 'git 内文件')
t('.github/workflows/ci.yml', true, 'CI 配置')
t('screenshot/', true, '截图目录本身')
t('screenshot/a.png', true, '截图内文件')
t('docs/', true, '文档目录')
t('docs/readme.md', true, '文档内文件')
t('tests/', true, '测试目录')
t('.agents/', true, 'agent 配置目录')
t('.claude/', true, 'claude 配置目录')

console.log('\n--- 必须排除（开发依赖）---')
t('node_modules/typescript/', true, 'typescript（已用 esbuild 预编译）')
t('node_modules/typescript/lib/tsc.js', true, 'typescript 内文件')
t('node_modules/@biomejs/', true, 'biomejs scope 目录')
t('node_modules/@biomejs/bin/biome', true, 'biomejs 内文件（64MB）')
t('node_modules/@types/', true, '@types scope 目录')
t('node_modules/@types/node/index.d.ts', true, '@types 内文件')
t('node_modules/ts-node/', true, 'ts-node')
t('node_modules/jest/', true, 'jest')
t('node_modules/husky/', true, 'husky')

console.log('\n--- 必须排除（无运行时作用的文件）---')
t('node_modules/axios/dist/axios.js.map', true, 'sourcemap')
t('node_modules/axios/README.md', true, 'README')
t('node_modules/axios/CHANGELOG.md', true, 'CHANGELOG')
t('node_modules/koa/History.md', true, 'History.md')
t('node_modules/some-lib/index.ts', true, '依赖包里的 .ts（运行时只认 .js）')
t('Thumbs.db', true, 'Windows 缩略图缓存')

console.log('\n--- 必须保留（运行时依赖）---')
t('node_modules/koa/', false, 'koa 目录')
t('node_modules/koa/lib/application.js', false, 'koa 主文件')
t('node_modules/axios/dist/axios.js', false, 'axios')
t('node_modules/axios/index.js', false, 'axios 入口')
t('node_modules/moment/moment.js', false, 'moment')
t('node_modules/lodash.get/index.js', false, 'lodash.get')
t('node_modules/zod/lib/index.js', false, 'zod')

console.log('\n--- 必须保留（源码与入口）---')
t('src/', false, '源码目录')
t('src/app.ts', false, 'qqmusic 入口 app.ts')
t('src/router/index.ts', false, '源码内 .ts')
t('dist/', false, 'dist 目录')
t('dist/app.cjs', false, 'esbuild 预编译产物')
t('public/', false, 'public 目录（__dirname/../public 依赖它）')
t('public/index.html', false, 'public 内文件')
t('package.json', false, 'package.json')
t('tsconfig.json', false, 'tsconfig.json')

console.log('\n--- 必须保留（server / ncm）---')
t('module/', false, 'server 模块目录')
t('module/song_url.js', false, 'server 模块文件')
t('app.js', false, 'server 入口')
t('util/request.js', false, 'server 工具')
t('data/deviceid.txt', false, 'deviceid 数据（运行时按需读取）')
t('data/china_ip_ranges.txt', false, 'IP 段数据')

console.log('\n--- 边界 ---')
t('', false, '空路径')
t('a', false, '无扩展名文件')
t('.gitignore', false, '点文件但非黑名单（保守保留）')

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) {
  console.log(`${fail} 项失败 —— 裁剪规则可能误伤运行时依赖！`)
  process.exit(1)
}
console.log('PACK_FILTER_TEST_OK')
