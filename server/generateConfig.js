const fs = require('fs')
const path = require('path')
const { register_anonimous } = require('./main')
const { cookieToJson, generateRandomChineseIP } = require('./util/index')
const { getXeapiPublicKey } = require('./util/xeapiKey')
const tmpPath = require('os').tmpdir()

/**
 * 本地配置初始化（纯计算，零网络，毫秒级）。
 * 【本应用补丁】从 generateConfig 拆出：
 * global.cnIp 与 global.deviceId 是纯本地随机计算（见 util/index.js 的
 * generateRandomChineseIP / generateDeviceId），却原先夹在两次联网请求之间，
 * 导致「跳过同步联网刷新」时这两个全局量会缺失（server.js 用 global.cnIp
 * 兜底 req.ip、request.js 用 global.deviceId 拼 cookie）。拆出后可在启动
 * 第一时间同步就位，网络刷新异步做也不影响正确性。
 */
function initLocalConfig() {
  global.cnIp = generateRandomChineseIP()
  // deviceId 由 register_anonimous 在联网注册时生成；此处先给一个本地随机值兜底，
  // 使任何在刷新完成前到达的请求也有合法 deviceId（刷新完成后会被覆盖为注册值）
  if (!global.deviceId) {
    try {
      global.deviceId = require('./util/index').generateDeviceId()
    } catch (_) {}
  }
}

async function generateConfig() {
  initLocalConfig()
  try {
    const res = await register_anonimous()
    const cookie = res.body.cookie
    if (cookie) {
      const cookieObj = cookieToJson(cookie)
      fs.writeFileSync(
        path.resolve(tmpPath, 'anonymous_token'),
        cookieObj.MUSIC_A,
        'utf-8',
      )
    }
  } catch (error) {
    console.log(error)
  }
  try {
    let currentPublicKey = {}
    try {
      currentPublicKey = JSON.parse(
        fs.readFileSync(path.resolve(tmpPath, 'xeapi_public_key'), 'utf-8'),
      )
    } catch (_) {}
    const publicKey = await getXeapiPublicKey(currentPublicKey, global.deviceId)
    fs.writeFileSync(
      path.resolve(tmpPath, 'xeapi_public_key'),
      JSON.stringify(publicKey),
      'utf-8',
    )
  } catch (error) {
    console.log(error)
  }
}
module.exports = generateConfig
module.exports.initLocalConfig = initLocalConfig
