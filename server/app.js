#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

async function start() {
  // 检测是否存在 anonymous_token 文件,没有则生成
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }
  // 启动时更新 anonymous_token
  //
  // 【本应用补丁】启动路径优化：
  // generateConfig() 内含两次联网请求（register_anonimous 注册匿名 token +
  // getXeapiPublicKey 取公钥）。上游实现每次启动都 await 它，弱网/上游抖动时
  // 实测可阻塞 19s，表现为「启动中…」长时间卡住、服务迟迟不就绪。
  //
  // 改为：缓存已存在 → 直接放行启动，配置刷新丢到后台异步做；
  //       缓存缺失（首次运行）→ 仍同步等待，保证首次可用。
  //
  // 注意：util/request.js 在 require 时同步读取 anonymous_token 文件，
  // 故此处只需保证「文件已存在且非空」。后台刷新写的是同一个文件，
  // 本进程已读入内存的旧值不影响运行，下次启动生效。
  //
  // global.cnIp / global.deviceId 原先在 generateConfig 内部设置，跳过同步
  // 刷新会让它们缺失（server.js 用 cnIp 兜底 req.ip，request.js 用 deviceId
  // 拼 cookie）。二者都是纯本地随机计算，故先同步 initLocalConfig() 补上。
  const generateConfig = require('./generateConfig')
  const tokenPath = path.resolve(tmpPath, 'anonymous_token')
  const keyPath = path.resolve(tmpPath, 'xeapi_public_key')
  const hasCache =
    fs.existsSync(tokenPath) &&
    fs.statSync(tokenPath).size > 0 &&
    fs.existsSync(keyPath) &&
    fs.statSync(keyPath).size > 0

  if (hasCache) {
    generateConfig.initLocalConfig()
    console.log('[app] anonymous_token 缓存命中，跳过同步配置刷新（后台异步更新）')
    generateConfig().catch((e) => console.log('[app] background generateConfig failed:', e))
  } else {
    await generateConfig()
  }

  require('./server').serveNcmApi({
    // 版本检查会 exec `npm info` 联网查 registry，慢/被墙会让 listen 延迟
    // （表现为"服务拉起慢 / 服务未就绪"）。本应用不需要，关闭。
    checkVersion: false,
  })
}
start()
