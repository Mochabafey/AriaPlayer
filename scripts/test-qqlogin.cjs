/* 临时脚本：ptqrshow 重写成功；ptqrlogin 保持原样（daid=383 + 页面 cookie），看轮询结果 */
const { app, BrowserWindow, session } = require('electron')

const U1 = 'https%3A%2F%2Fy.qq.com%2Fportal%2Fwmp_qq_login.html'
const XLOGIN = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=716027609&s_url=' + U1 + '&pt_3rd_aid=100497308&pt_feedback_link=' + U1 + '&style=40&daid=383&pt_disable_pwd=1'

async function main() {
  const ses = session.fromPartition('qq-login-test')
  await ses.setProxy({ mode: 'direct' })
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (details.url.includes('ptqrshow') && details.url.includes('xui.')) {
      let url = details.url.replace('https://xui.ptlogin2.qq.com/ssl/ptqrshow', 'https://ssl.ptlogin2.qq.com/ptqrshow')
      url = url.replace(/&?daid=383/, '')
      url += '&da=1&pt_feedback_link=' + U1 + '&pt_redirect_aid=100497308&pt_redir_pttype=8'
      return cb({ cancel: false, redirectURL: url })
    }
    cb({ cancel: false })
  })
  ses.webRequest.onCompleted((d) => {
    if (d.url.includes('ptqrlogin')) console.log('[login-http]', d.statusCode, d.url.slice(0, 100))
  })

  const win = new BrowserWindow({ width: 400, height: 400, show: false, webPreferences: { session: ses, sandbox: true } })
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        await win.webContents.executeJavaScript(`
          (function(){
            window.__qqLoginState = { code: -1, ts: 0 };
            if (window.ptuiCB) {
              const orig = window.ptuiCB;
              window.ptuiCB = function() {
                window.__qqLoginState = { code: arguments[0], args: Array.prototype.slice.call(arguments), ts: Date.now() };
                return orig.apply(this, arguments);
              };
            }
            return 'hooked';
          })()
        `)
      } catch (e) { console.log('hook fail', e.message) }
    }, 2500)
  })

  await win.loadURL(XLOGIN)
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const state = await win.webContents.executeJavaScript(`window.__qqLoginState || null`)
      console.log(`[t+${(i + 1) * 2}s] state=${JSON.stringify(state)}`)
      if (state && (state.code === 65 || state.code === 66 || state.code === 0)) {
        console.log('>>> 链路打通，code=' + state.code)
        break
      }
    } catch (e) { console.log('read fail', e.message) }
  }
  app.exit(0)
}

app.whenReady().then(main)
