/* 临时：批量测歌，判断 cookie 是否被 QQ 播放接口识别 */
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync('C:/Users/Master/AppData/Roaming/Aria Player/ncm-store/ntr.db')
const row = db.prepare("SELECT value FROM settings WHERE key='qqCookie'").get()
const ck = JSON.parse(row.value)
db.close()

const UA = 'Mozilla/5.0'
async function searchSongs(kw) {
  const u = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&outCharset=utf-8&ct=24&qqmusic_ver=1298&remoteplace=txt.yqq.song&t=0&aggr=1&cr=1&lossless=0&flag_qc=0&platform=yqq.json&w=' + encodeURIComponent(kw) + '&p=1&n=8&catZhida=1'
  const r = await fetch(u, { headers: { 'User-Agent': UA } })
  const j = await r.json()
  return (j.data.song.list || []).map((s) => ({ mid: s.songmid, name: s.songname, singer: (s.singer || []).map((x) => x.name).join('/') }))
}
async function getPlay(mid, uin) {
  const data = JSON.stringify({
    req_0: {
      module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
      param: { filename: ['M500' + mid + mid + '.mp3'], guid: '1429839143', songmid: [mid], songtype: [0], uin, loginflag: 1, platform: '20' }
    },
    loginUin: uin, comm: { uin, format: 'json', ct: 24, cv: 0 }
  })
  const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&sign=zzannc1o6o9b4i971602f3554385022046ab796512b7012&data=' + encodeURIComponent(data), {
    headers: { 'User-Agent': UA, 'Cookie': ck }
  })
  const j = await r.json()
  const m = (j.req_0 && j.req_0.data && j.req_0.data.midurlinfo && j.req_0.data.midurlinfo[0]) || {}
  return { purl: m.purl || '', result: m.result }
}

const uin = '3524353484'
const kws = ['光年之外', '起风了', '平凡之路', '我的祖国', '小苹果']
for (const kw of kws) {
  try {
    const songs = await searchSongs(kw)
    for (const s of songs.slice(0, 3)) {
      const p = await getPlay(s.mid, uin)
      console.log(`${kw} | ${s.name} - ${s.singer} | result=${p.result} purl=${p.purl ? 'YES' : 'no'}`)
      if (p.purl) { console.log('>>> 免费歌可播！cookie 被识别！'); process.exit(0) }
    }
  } catch (e) { console.log(kw, 'ERR', e.message) }
}
console.log('>>> 所有测的歌都无法播放（可能都需 VIP，或 cookie 未被识别）')
