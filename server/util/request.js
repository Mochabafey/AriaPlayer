// 预先导入和绑定常用模块及函数
const encrypt = require('./crypto')
const CryptoJS = require('crypto-js')
const { default: axios } = require('axios')
const logger = require('./logger')
const { PacProxyAgent } = require('pac-proxy-agent')
const http = require('http')
const https = require('https')
const tunnel = require('tunnel')
const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()
const {
  cookieToJson,
  cookieObjToString,
  toBoolean,
  generateRandomChineseIP,
} = require('./index')
const { URLSearchParams, URL } = require('url')
const { APP_CONF } = require('./config.json')
// 【本应用补丁】反作弊 token 模块改为懒加载。
// register_checktoken_v2/v3 顶层 require('jsdom')，而 jsdom 的模块加载
// 实测耗时 812ms（占全部 436 个模块加载耗时 1189ms 的 68%）。
// 但这两个 getToken 只在 options.checkToken === 'v2'/'v3' 时才被调用
// （见下方 createRequest 的 switch），搜索/歌词/播放地址等常用接口都不用它。
// 原先顶层 require 让每次启动都白付这 800ms；改为调用时按需加载。
let _antiCheatV2 = null
let _antiCheatV3 = null
const antiCheatTokenV2 = async (...args) => {
  if (!_antiCheatV2) {
    _antiCheatV2 = require('../module/register_checktoken_v2').getToken
  }
  return _antiCheatV2(...args)
}
const antiCheatTokenV3 = async (...args) => {
  if (!_antiCheatV3) {
    _antiCheatV3 = require('../module/register_checktoken_v3').getToken
  }
  return _antiCheatV3(...args)
}

// 预先读取匿名token并缓存
const anonymous_token = fs.readFileSync(
  path.resolve(tmpPath, './anonymous_token'),
  'utf-8',
)
const xeapiPublicKeyPath = path.resolve(tmpPath, './xeapi_public_key')
let xeapi_public_key = null
const loadXeapiPublicKey = () => {
  if (!xeapi_public_key && fs.existsSync(xeapiPublicKeyPath)) {
    try {
      xeapi_public_key = JSON.parse(
        fs.readFileSync(xeapiPublicKeyPath, 'utf-8'),
      )
    } catch (error) {
      console.log('[ERR]', error)
    }
  }
  return xeapi_public_key
}

// 预先绑定常用函数和常量
const floor = Math.floor
const random = Math.random
const now = Date.now
const keys = Object.keys
const stringify = JSON.stringify
const parse = JSON.parse
const characters = 'abcdefghijklmnopqrstuvwxyz'
const charactersLength = characters.length

// 预先创建HTTP/HTTPS agents并重用
const createHttpAgent = () => new http.Agent({ keepAlive: true })
const createHttpsAgent = () => new https.Agent({ keepAlive: true })

// 预先计算WNMCID（只计算一次）
const WNMCID = (function () {
  let randomString = ''
  for (let i = 0; i < 6; i++) {
    randomString += characters.charAt(floor(random() * charactersLength))
  }
  return `${randomString}.${now().toString()}.01.0`
})()

// 预先定义osMap
const osMap = {
  pc: {
    os: 'pc',
    appver: '3.1.17.204416',
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    channel: 'netease',
  },
  linux: {
    os: 'linux',
    appver: '1.2.1.0428',
    osver: 'Deepin 20.9',
    channel: 'netease',
  },
  android: {
    os: 'android',
    appver: '8.20.20.231215173437',
    osver: '14',
    channel: 'xiaomi',
  },
  iphone: {
    os: 'iPhone OS',
    appver: '9.0.90',
    osver: '16.2',
    channel: 'distribution',
  },
  osx: {
    os: 'osx',
    appver: '3.1.10.5100',
    osver: '15.5',
    channel: 'netease',
  },
}

// 预先定义userAgentMap
const userAgentMap = {
  weapi: {
    pc: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  },
  linuxapi: {
    linux:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
  },
  api: {
    pc: 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117',
    android:
      'NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 12; HBN-AL00 Build/cd737a2.0)',
    iphone: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
  },
}

// 预先定义常量
const DOMAIN = APP_CONF.domain
const API_DOMAIN = APP_CONF.apiDomain
const EAPI_DOMAIN = APP_CONF.eapiDomain
const XEAPI_DOMAIN = APP_CONF.xeapiDomain
const ENCRYPT_RESPONSE = APP_CONF.encryptResponse
const SPECIAL_STATUS_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803])

/**
 * weapi 的备用域名（自动回退，解决「域名解析到不可达 IP」的问题）
 *
 * ## 为什么需要
 *
 * `weapi` 的 URL 是 `DOMAIN + '/weapi/' + path`，而 `DOMAIN` 默认是
 * `https://music.163.com`。实测在部分网络环境下该域名会解析到**不可达的 IP**
 * （IPv6 `2408:874c:...` 或 IPv4 `116.153.63.82`），表现为：
 *
 *     所有走 weapi 的接口 → 502 read ECONNRESET
 *     而走 eapi 的接口（interface.music.163.com）→ 正常
 *
 * 受影响的接口多达 200+（含每日推荐、我的歌单、登录状态、听歌排行、
 * 相似推荐、云漫游、私人FM、歌曲详情、最近播放…），而搜索/播放/歌词走 eapi
 * 不受影响 —— 所以症状看起来像「部分功能坏了」。
 *
 * ## 为什么换域名可行
 *
 * 实测 `/weapi/` 路径在其他网易云域名上**完全可用**（返回 200）：
 *
 *     music.163.com            → ❌ ECONNRESET
 *     interface.music.163.com  → ✅ 200
 *     interfacepc.music.163.com→ ✅ 200
 *     interface3.music.163.com → ✅ 200
 *     api.music.163.com        → ✅ 200
 *
 * 即「weapi 加密协议」并不绑定 `music.163.com` 这个域名，
 * 只是历史配置把它写成了默认值。
 *
 * ## 策略
 *
 * 只在**网络层失败**（ECONNRESET / ETIMEDOUT / ENOTFOUND / socket hang up）
 * 时回退，业务错误（如 401 未登录）不回退 —— 避免把正常的登录失效
 * 变成无谓的重试。
 */
const WEAPI_FALLBACK_DOMAINS = [
  'https://interface.music.163.com',
  'https://interfacepc.music.163.com',
  'https://interface3.music.163.com',
]

/** 判断是否为「网络层」错误（值得换域名重试） */
const isNetworkError = (err) => {
  const code = err?.code || ''
  const msg = String(err?.message || '')
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    /socket hang up|ECONNRESET|ETIMEDOUT|timeout of/i.test(msg)
  )
}

/**
 * 记录每个域名最近一次失败的时间，做短期熔断：
 * 一旦某域名网络失败，接下来 5 分钟内直接跳过它，避免每次请求都白等一次超时。
 */
const domainCooldown = new Map()
const COOLDOWN_MS = 5 * 60 * 1000
const inCooldown = (d) => {
  const t = domainCooldown.get(d)
  return t != null && Date.now() - t < COOLDOWN_MS
}
const markFailed = (d) => domainCooldown.set(d, Date.now())

let xeapiSessionId = ''
let xeapiSessionKey = ''

// chooseUserAgent函数
const chooseUserAgent = (crypto, uaType = 'pc') => {
  return (userAgentMap[crypto] && userAgentMap[crypto][uaType]) || ''
}

// cookie处理
const processCookieObject = (cookie, uri) => {
  const _ntes_nuid = CryptoJS.lib.WordArray.random(32).toString()
  const os = osMap[cookie.os] || osMap['pc']

  const processedCookie = {
    ...cookie,
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: cookie._ntes_nuid || _ntes_nuid,
    _ntes_nnid: cookie._ntes_nnid || `${_ntes_nuid},${now().toString()}`,
    WNMCID: cookie.WNMCID || WNMCID,
    WEVNSM: cookie.WEVNSM || '1.0.0',
    osver: cookie.osver || os.osver,
    deviceId: cookie.deviceId || global.deviceId,
    os: cookie.os || os.os,
    channel: cookie.channel || os.channel,
    appver: cookie.appver || os.appver,
  }

  if (uri.indexOf('login') === -1) {
    processedCookie['NMTID'] = CryptoJS.lib.WordArray.random(16).toString()
  }

  if (!processedCookie.MUSIC_U) {
    processedCookie.MUSIC_A = processedCookie.MUSIC_A || anonymous_token
  }

  return processedCookie
}

// header cookie生成
const createHeaderCookie = (header) => {
  const headerKeys = keys(header)
  const cookieParts = new Array(headerKeys.length)

  for (let i = 0, len = headerKeys.length; i < len; i++) {
    const key = headerKeys[i]
    cookieParts[i] =
      encodeURIComponent(key) + '=' + encodeURIComponent(header[key])
  }

  return cookieParts.join('; ')
}

// requestId生成
const generateRequestId = () => {
  return `${now()}_${floor(random() * 1000)
    .toString()
    .padStart(4, '0')}`
}

const createRequest = async (uri, data, options) => {
  let token = ''
  switch (options.checkToken) {
    case 'v2':
      // 每次实时获取反作弊 token，不缓存
      token = await antiCheatTokenV2()
      break
    case 'v3':
      // 每次实时获取反作弊 token，不缓存
      token = await antiCheatTokenV3()
      break
  }

  return new Promise((resolve, reject) => {
    // 变量声明和初始化
    const headers = options.headers ? { ...options.headers } : {}
    const ip = options.realIP || options.ip || ''

    // IP头设置
    if (ip) {
      headers['X-Real-IP'] = ip
      headers['X-Forwarded-For'] = ip
    }

    let cookie = options.cookie || {}
    if (typeof cookie === 'string') {
      cookie = cookieToJson(cookie)
    }

    if (typeof cookie === 'object') {
      cookie = processCookieObject(cookie, uri)
      headers['Cookie'] = cookieObjToString(cookie)
    }
    let url = ''
    let encryptData = ''
    let crypto = options.crypto
    const csrfToken = cookie['__csrf'] || ''

    // 加密方式选择
    if (crypto === '') {
      crypto = APP_CONF.encrypt ? 'eapi' : 'api'
    }

    const answer = { status: 500, body: {}, cookie: [] }

    data.e_r = toBoolean(
      options.e_r !== undefined
        ? options.e_r
        : data.e_r !== undefined
          ? data.e_r
          : ENCRYPT_RESPONSE,
    )
    // 根据加密方式处理
    switch (crypto) {
      case 'weapi':
        headers['Referer'] = options.domain || DOMAIN
        headers['User-Agent'] = options.ua || chooseUserAgent('weapi')
        data.csrf_token = csrfToken
        if (options.checkToken) {
          headers['X-antiCheatToken'] = token
        }
        encryptData = encrypt.weapi(data)
        url = (options.domain || DOMAIN) + '/weapi/' + uri.substr(5)
        break

      case 'linuxapi':
        headers['User-Agent'] =
          options.ua || chooseUserAgent('linuxapi', 'linux')
        encryptData = encrypt.linuxapi({
          method: 'POST',
          url: (options.domain || DOMAIN) + uri,
          params: data,
        })
        url = (options.domain || DOMAIN) + '/api/linux/forward'
        break

      case 'xeapi':
        const xeapiPublicKey = loadXeapiPublicKey()
        if (!xeapiPublicKey) {
          throw new Error('xeapi public key is missing')
        }
        const xeapiOs = cookie.os === 'android' ? cookie.os : 'android'
        const xeapiAppver =
          cookie.os === 'android' && cookie.appver ? cookie.appver : '9.1.65'
        const xeapiOsver =
          cookie.os === 'android' && cookie.osver ? cookie.osver : '16'
        const xeapiBuildver = cookie.buildver || now().toString().substr(0, 10)
        headers['User-Agent'] = options.ua || chooseUserAgent('api', 'android')
        headers['X-Client-Enc-State'] = 'ENCRYPTED'
        headers['x-aeapi'] = true
        headers['content-type'] =
          'application/x-www-form-urlencoded;charset=utf-8'
        headers['x-deviceid'] = cookie.deviceId
        headers['x-os'] = xeapiOs
        headers['x-osver'] = xeapiOsver
        headers['x-appver'] = xeapiAppver
        headers['x-sdeviceid'] = cookie.sDeviceId || cookie.deviceId
        headers['x-buildver'] = xeapiBuildver
        if (cookie.MUSIC_U) headers['x-music-u'] = cookie.MUSIC_U
        if (options.checkToken) {
          headers['X-antiCheatToken'] = token
        }
        const xeapiCookie = {
          ...cookie,
          os: xeapiOs,
          osver: xeapiOsver,
          appver: xeapiAppver,
          buildver: xeapiBuildver,
          deviceId: cookie.deviceId,
          sDeviceId: cookie.sDeviceId || cookie.deviceId,
        }
        headers['Cookie'] = cookieObjToString(xeapiCookie)
        url = (options.domain || XEAPI_DOMAIN) + '/xeapi/' + uri.substr(5)
        encryptData = encrypt.xeapi(uri, data, {
          ...options,
          publicKeyState: xeapiPublicKey,
          sessionId: xeapiSessionId,
          sessionKey: xeapiSessionKey,
          appver: xeapiAppver,
          deviceId: cookie.deviceId,
          os: xeapiOs,
          uid: cookie.uid || cookie.userId || '',
        })
        break

      case 'eapi':
      case 'api':
        // header创建
        const header = {
          osver: cookie.osver,
          deviceId: cookie.deviceId,
          os: cookie.os,
          appver: cookie.appver,
          versioncode: cookie.versioncode || '140',
          mobilename: cookie.mobilename || '',
          buildver: cookie.buildver || now().toString().substr(0, 10),
          resolution: cookie.resolution || '1920x1080',
          __csrf: csrfToken,
          channel: cookie.channel,
          requestId: generateRequestId(),
          // clientSign: APP_CONF.clientSign,
        }

        if (cookie.MUSIC_U) header['MUSIC_U'] = cookie.MUSIC_U
        if (cookie.MUSIC_A) header['MUSIC_A'] = cookie.MUSIC_A
        if (options.checkToken) {
          header['X-antiCheatToken'] = token
        }

        headers['Cookie'] = createHeaderCookie(header)
        headers['User-Agent'] =
          options.ua ||
          (cookie.os === 'osx'
            ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            : chooseUserAgent('api', 'iphone'))

        if (crypto === 'eapi') {
          // headers['x-aeapi'] = true // 服务器会使用gzip压缩返回值
          data.header = header

          encryptData = encrypt.eapi(uri, data)
          url = (options.domain || EAPI_DOMAIN) + '/eapi/' + uri.substr(5)
        } else if (crypto === 'api') {
          url = (options.domain || API_DOMAIN) + uri
          encryptData = data
        }
        break

      default:
        console.log('[ERR]', 'Unknown Crypto:', crypto)
        break
    }
    // settings创建
    let settings = {
      method: 'POST',
      url: url,
      headers: headers,
      data: new URLSearchParams(encryptData).toString(),
      httpAgent: createHttpAgent(),
      httpsAgent: createHttpsAgent(),
    }

    // 自定义超时
    if (options.timeout > 0) {
      settings.timeout = options.timeout
    }

    // 使用返回值加密
    const use_e_r = (crypto === 'eapi' || crypto === 'weapi') && data.e_r
    const use_xeapi = crypto === 'xeapi'
    if (use_e_r || use_xeapi) {
      settings.encoding = null
      settings.responseType = 'arraybuffer'
    }

    // 代理处理
    if (options.proxy) {
      if (options.proxy.indexOf('pac') > -1) {
        const agent = new PacProxyAgent(options.proxy)
        settings.httpAgent = agent
        settings.httpsAgent = agent
      } else {
        try {
          const purl = new URL(options.proxy)
          if (purl.hostname) {
            const isHttps = purl.protocol === 'https:'
            const agent = tunnel[isHttps ? 'httpsOverHttp' : 'httpOverHttp']({
              proxy: {
                host: purl.hostname,
                port: purl.port || 80,
                proxyAuth:
                  purl.username && purl.password
                    ? purl.username + ':' + purl.password
                    : '',
              },
            })
            settings.httpsAgent = agent
            settings.httpAgent = agent
            settings.proxy = false
          } else {
            console.error('代理配置无效,不使用代理')
          }
        } catch (e) {
          console.error('代理URL解析失败:', e.message)
        }
      }
    } else {
      settings.proxy = false
    }
    // console.log(settings.headers);

    /**
     * 发起请求，带「weapi 域名自动回退」。
     *
     * 为什么在这里做：weapi 的 URL 在 switch 里就拼好了（DOMAIN + '/weapi/...'），
     * 而失败要等到 axios 抛错才知道。所以在请求层按「网络错误」判断并换域名重试，
     * 对上层模块完全透明（200+ 个 module 无需改动）。
     *
     * 只对 weapi 生效：eapi/xeapi 的域名（interface*.music.163.com）实测可达，
     * 不需要回退；且它们有会话状态（xeapiSessionId），重试语义更复杂。
     */
    const doRequest = async () => {
      // 组装候选 URL 列表：weapi 时把备用域名排在原域名之后
      let urlCandidates = [url]
      if (crypto === 'weapi' && !options.domain) {
        const suffix = url.slice(DOMAIN.length) // '/weapi/xxx'
        const alts = WEAPI_FALLBACK_DOMAINS
          .filter((d) => !inCooldown(d))
          .map((d) => d + suffix)
        // 原域名若处于熔断期，直接排到最后（仍会试，但优先级最低）
        if (inCooldown(DOMAIN)) {
          urlCandidates = [...alts, url]
        } else {
          urlCandidates = [url, ...alts]
        }
      }

      let lastErr = null
      for (let i = 0; i < urlCandidates.length; i++) {
        const target = urlCandidates[i]
        const domainOf = (u) => {
          const m = /^(https?:\/\/[^/]+)/.exec(u)
          return m ? m[1] : u
        }
        try {
          const res = await axios({ ...settings, url: target })
          // 成功：若用的是备用域名，记录一下（便于排查）
          if (i > 0) {
            console.log(
              `[weapi-fallback] ${domainOf(url)} 不可达，已改用 ${domainOf(target)}`,
            )
          }
          return res
        } catch (err) {
          lastErr = err
          const dom = domainOf(target)
          if (isNetworkError(err)) {
            markFailed(dom)
            // 还有候选就继续试；否则抛出
            if (i < urlCandidates.length - 1) {
              console.log(
                `[weapi-fallback] ${dom} 网络失败(${err.code || err.message})，尝试下一个域名…`,
              )
              continue
            }
          }
          throw err
        }
      }
      throw lastErr || new Error('no url candidate')
    }

    doRequest()
      .then((res) => {
        const body = res.data
        answer.cookie = (res.headers['set-cookie'] || []).map((x) =>
          x.replace(/\s*Domain=[^(;|$)]+;*/, ''),
        )

        // debug: 统一注释块，需要时取消注释查看请求/返回的原始密文

        // logger.debug(`[${crypto}]`, uri)
        // logger.debug(`[${crypto}] encrypted data:`, JSON.stringify(encryptData))
        // logger.debug(
        //   `[RAW] [${crypto}]`,
        //   use_xeapi
        //     ? Buffer.from(body).toString('base64')
        //     : body.toString('hex').toUpperCase(),
        // )

        try {
          if (use_xeapi) {
            if (res.headers['x-encr-ssid'] && res.headers['x-encr-sskey']) {
              xeapiSessionId = res.headers['x-encr-ssid']
              xeapiSessionKey = res.headers['x-encr-sskey']
            }
            answer.body = encrypt.xeapiResDecrypt(Buffer.from(body))
          } else if (use_e_r) {
            answer.body = encrypt.eapiResDecrypt(
              body.toString('hex').toUpperCase(),
              headers['x-aeapi'],
            )
          } else {
            answer.body =
              typeof body === 'object' ? body : parse(body.toString())
          }

          if (answer.body.code) {
            answer.body.code = Number(answer.body.code)
          }

          answer.status = Number(answer.body.code || res.status)

          // 状态码检查（使用Set提升查找性能）
          if (SPECIAL_STATUS_CODES.has(answer.body.code)) {
            answer.status = 200
          }
        } catch (e) {
          answer.body = body
          answer.status = res.status
        }

        answer.status =
          answer.status > 100 && answer.status < 600 ? answer.status : 400

        if (answer.status === 200) {
          resolve(answer)
        } else {
          console.log('[ERR]', answer)
          reject(answer)
        }
      })
      .catch((err) => {
        answer.status = 502
        answer.body = { code: 502, msg: err.message || err }
        console.log('[ERR]', answer)
        reject(answer)
      })
  })
}

module.exports = createRequest
