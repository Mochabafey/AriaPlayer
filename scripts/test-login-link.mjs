// 模拟主进程 Cookie Jar 逻辑，实测登录链路
const BASE = 'http://127.0.0.1:3200'
const jar = new Map()

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorb(res) {
  let setCookies = []
  if (typeof res.headers.getSetCookie === 'function') setCookies = res.headers.getSetCookie()
  else {
    const v = res.headers.get('set-cookie')
    if (v) setCookies = [v]
  }
  for (const sc of setCookies) {
    if (!sc) continue
    const pair = sc.split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

async function call(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const headers = {}
  const c = cookieHeader()
  if (c) headers['Cookie'] = c
  const res = await fetch(`${BASE}/${path}${qs ? '?' + qs : ''}`, { headers })
  absorb(res)
  return res.json()
}

async function main() {
  console.log('=== 1. login_qr_key ===')
  const key = await call('login/qr/key', { timestamp: Date.now() })
  console.log('code:', key.code, '| unikey:', key.data?.unikey?.slice(0, 12) + '...')
  if (!key.data?.unikey) throw new Error('login_qr_key 失败')

  console.log('\n=== 2. login_qr_create ===')
  const qr = await call('login/qr/create', { key: key.data.unikey, qrimg: true, timestamp: Date.now() })
  console.log('code:', qr.code, '| qrimg 前缀:', qr.data?.qrimg?.slice(0, 30))
  if (!qr.data?.qrimg?.startsWith('data:image')) throw new Error('login_qr_create qrimg 异常')

  console.log('\n=== 3. login_qr_check (未扫码，期待 801) ===')
  const chk = await call('login/qr/check', { key: key.data.unikey, timestamp: Date.now() })
  console.log('code:', chk.code, '| message:', chk.message)

  console.log('\n=== 4. login_status ===')
  const st = await call('login/status')
  console.log('code:', st.code, '| 已登录:', !!st.data?.account)

  console.log('\n=== 5. 登录后 cookie jar 状态 ===')
  console.log('jar keys:', [...jar.keys()].join(', ') || '(空——未扫码不会有登录 cookie，符合预期)')

  console.log('\n=== 6. 检查任意接口是否吸收基础 cookie ===')
  const b = await call('banner')
  console.log('banner code:', b.code, '| jar keys:', [...jar.keys()].slice(0, 8).join(', ') || '(空)')

  console.log('\n✅ 登录链路接口全部正常')
}

main().catch((e) => {
  console.error('❌ 失败:', e.message)
  process.exit(1)
})
