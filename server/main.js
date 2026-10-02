const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()
const { cookieToJson } = require('./util')

const anonymousTokenPath = path.resolve(tmpPath, 'anonymous_token')
if (!fs.existsSync(anonymousTokenPath)) {
  fs.writeFileSync(anonymousTokenPath, '', 'utf-8')
}

/** @type {Record<string, any>} */
let obj = {}

const modulePath = path.join(__dirname, 'module')
const moduleFiles = fs.readdirSync(modulePath).reverse()

let requestModule = null

// [patched] 惰性模块加载：原实现用 forEach 同步 require 全部 436 个模块文件，
// 其中 register_checktoken_v2 顶层引 jsdom（单模块加载 812ms，占全量的 68%）。
// 本应用（AriaPlayer）只用到 register_anonimous 一个函数，其余 435 个纯属浪费，
// 且 server.js 已改为按路由惰性加载，这里的全量 require 是启动耗时的最大残余项。
// 现改为：只记文件名，函数首次被调用时才 require 该模块（Node require 自带缓存，
// 后续命中零开销）。对外行为完全不变——导出的仍是一组同名函数。
const fileModuleCache = new Map()
const loadFileModule = (filePath) => {
  if (!fileModuleCache.has(filePath)) {
    fileModuleCache.set(filePath, require(filePath))
  }
  return fileModuleCache.get(filePath)
}

moduleFiles.forEach((file) => {
  if (!file.endsWith('.js')) return

  const filePath = path.join(modulePath, file)
  let fn = file.split('.').shift() || ''

  obj[fn] = function (data = {}) {
    const cookie =
      typeof data.cookie === 'string'
        ? cookieToJson(data.cookie)
        : data.cookie || {}

    return loadFileModule(filePath)(
      {
        ...data,
        cookie,
      },
      async (...args) => {
        if (!requestModule) {
          requestModule = require('./util/request')
        }

        return requestModule(...args)
      },
    )
  }
})

let serverModule = null

/**
 * @type {Record<string, any> & import("./server")}
 */
module.exports = {
  get server() {
    if (!serverModule) {
      serverModule = require('./server')
    }
    return serverModule
  },
  ...obj,
}

Object.assign(module.exports, require('./server'))
