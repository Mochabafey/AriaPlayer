import { ipcMain } from 'electron'
import http from 'http'
import {
  searchVideos,
  videoInfo,
  playUrl,
  checkLogin,
  qrGenerate,
  qrPoll,
  logout,
  setCookieString,
  getCookieString,
  clearCookie,
  fetchSubtitle,
  cleanTitle
} from '../biliClient.js'
import {
  mergeToCache,
  jobStatus,
  cacheKeyOf,
  cachedFile,
  biliCacheStats,
  clearBiliCache,
  startHlsSession,
  hlsSessionStatus,
  stopHlsSession,
  stopAllHlsSessions
} from '../biliStream.js'

/**
 * B 站相关 IPC。
 *
 * 设计：取流与合流都在主进程做（渲染层拿不到 Node 能力，也不该直接访问
 * B 站 CDN——防盗链头需要主进程注入）。渲染层只拿到「本地可播地址」或
 * 「需要合流」的标记，然后轮询合流进度。
 */
export function registerBiliIpc(getNcmServer) {
  /**
   * 经私有通道向内置网易云服务发请求（搜歌 / 取歌词用）。
   * 复用 registerApiIpc 里同样的 socketPath 方式，避免重复起 TCP 连接。
   *
   * 启动竞态兜底：B 站页可能在 ncm 服务就绪前就请求歌词（窗口先于服务显示），
   * 此时直接返回 null 会让「自动匹配歌词」静默失败。这里短暂等待服务就绪
   * ——与 ipc/api.js 的 ncm:api 保持一致的策略。
   */
  async function ncmGet(srv, urlPath) {
    if (!srv) return null
    if (srv.status !== 'ready') {
      const ready = await srv.waitUntilReady(12000)
      if (!ready) return null
    }
    return new Promise((resolve) => {
      const req = http.request(
        { socketPath: srv.socketPath, path: urlPath, method: 'GET' },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
            } catch {
              resolve(null)
            }
          })
        }
      )
      req.on('error', () => resolve(null))
      req.setTimeout(20000, () => req.destroy(new Error('ncm timeout')))
      req.end()
    })
  }

  // ---- 登录态 ----
  ipcMain.handle('bili:login-status', () => checkLogin())

  ipcMain.handle('bili:login-qr', async () => {
    const r = await qrGenerate()
    return r
  })

  ipcMain.handle('bili:login-poll', async (_e, qrcodeKey) => {
    return await qrPoll(qrcodeKey)
  })

  ipcMain.handle('bili:logout', () => logout())

  ipcMain.handle('bili:get-cookie', () => getCookieString())

  ipcMain.handle('bili:set-cookie', (_e, str) => {
    const keys = setCookieString(str)
    return { ok: true, keys }
  })

  ipcMain.handle('bili:clear-cookie', () => {
    clearCookie()
    return true
  })

  // ---- 搜索 / 详情 ----
  ipcMain.handle('bili:search', async (_e, { keyword, page = 1, pageSize = 20 }) => {
    const list = await searchVideos(keyword, page, pageSize)
    return { ok: true, list }
  })

  ipcMain.handle('bili:video-info', async (_e, bvid) => {
    return await videoInfo(bvid)
  })

  /**
   * 解析播放源。
   * 返回结构（渲染层据此决定怎么播）：
   *   { mode:'proxy', url }                    → 直接交给 ncm-audio:// 播放
   *   { mode:'hls', sessionId, playlist }      → HLS 实时合流，用 hls.js 播
   *   { mode:'merge', key }                    → 全量合流（下载/兜底），轮询 merge-status
   *   { mode:'ready', key, file }              → 已缓存完整文件，直接播本地
   *
   * @param {object} p
   *   - live: 是否用 HLS 实时合流（默认 true）。下载场景传 false 拿完整文件。
   */
  ipcMain.handle('bili:resolve', async (_e, { bvid, cid, quality, preferSingle = true, live = true }) => {
    const info = await playUrl(bvid, cid, { qn: quality, preferSingle })

    if (info.mode === 'durl') {
      return {
        mode: 'proxy',
        url: info.url,
        quality: info.quality,
        qualityName: info.qualityName,
        acceptQuality: info.acceptQuality,
        acceptDesc: info.acceptDesc,
        duration: info.duration,
        codecs: info.codecs
      }
    }

    // DASH：先看有没有已缓存的完整文件（有就直接播，最省事）
    const key = cacheKeyOf(bvid, cid, info.quality)
    const hit = cachedFile(key)
    if (hit) {
      return {
        mode: 'ready',
        key,
        file: hit,
        quality: info.quality,
        qualityName: info.qualityName,
        acceptQuality: info.acceptQuality,
        acceptDesc: info.acceptDesc,
        duration: info.duration,
        codecs: info.video?.codecs,
        hevcOnly: info.hevcOnly
      }
    }

    /**
     * 无缓存：决定用哪条路径
     *   live=true（播放场景）→ HLS 实时合流，首片生成即可开播
     *   live=false（下载场景）→ 全量合流，产出完整 mp4 文件
     */
    if (live) {
      try {
        const { sessionId, playlist } = startHlsSession({
          bvid,
          cid,
          quality: info.quality,
          videoUrl: info.video.url,
          audioUrl: info.audio?.url,
          // 备用地址：B 站流常含 PCDN 节点（域名带 mcdn、端口 8082），
          // 稳定性差，实测会连接被重置（ffmpeg -138）。主地址失败时自动切换。
          videoBackups: info.video?.backupUrls,
          audioBackups: info.audio?.backupUrls
        })
        return {
          mode: 'hls',
          sessionId,
          playlist,
          quality: info.quality,
          qualityName: info.qualityName,
          acceptQuality: info.acceptQuality,
          acceptDesc: info.acceptDesc,
          duration: info.duration,
          video: { width: info.video?.width, height: info.video?.height, codecs: info.video?.codecs },
          codecs: info.video?.codecs,
          hevcOnly: info.hevcOnly
        }
      } catch (e) {
        // HLS 启动失败（如 ffmpeg 缺失）：回退到全量合流
        console.warn('[bili] HLS 启动失败，回退全量合流:', e.message)
      }
    }

    // 全量合流：立即启动（后台跑），把 key 返回给前端轮询
    mergeToCache({
      bvid,
      cid,
      quality: info.quality,
      videoUrl: info.video.url,
      audioUrl: info.audio?.url
    }).catch((e) => console.warn('[bili] merge failed', e.message))

    return {
      mode: 'merge',
      key,
      needMerge: true,
      quality: info.quality,
      qualityName: info.qualityName,
      acceptQuality: info.acceptQuality,
      acceptDesc: info.acceptDesc,
      duration: info.duration,
      video: { width: info.video?.width, height: info.video?.height, codecs: info.video?.codecs },
      codecs: info.video?.codecs,
      availableCodecs: info.availableCodecs,
      // 该画质只有 HEVC 时前端要给出明确提示（Chromium 解不了，会黑屏）
      hevcOnly: info.hevcOnly
    }
  })

  /** 合流进度（前端轮询） */
  ipcMain.handle('bili:merge-status', (_e, key) => {
    const st = jobStatus(key)
    if (!st) {
      // job 不存在：可能已完成并被清理 → 看缓存文件
      const f = cachedFile(key)
      if (f) return { done: true, percent: 100, file: f }
      return { done: false, percent: 0, missing: true }
    }
    return {
      done: st.done,
      percent: st.percent,
      time: st.time,
      speed: st.speed,
      error: st.error,
      file: st.done ? st.output : null
    }
  })

  // ---- 字幕 / 歌词 ----

  /**
   * 取 B 站视频自带字幕（CC）。多数视频没有，取不到返回空数组。
   */
  ipcMain.handle('bili:subtitle', async (_e, { bvid, cid }) => {
    const list = await fetchSubtitle(bvid, cid)
    return { ok: true, list }
  })

  /**
   * 按 B 站视频标题自动匹配网易云歌词。
   *
   * 流程：清洗标题 → 搜网易云 → 取首条命中 → 拉歌词（含翻译）。
   * 匹配质量用「歌名+歌手是否都出现在标题里」粗判，供前端提示置信度。
   *
   * @returns {{ ok, keyword, matched?: {id,name,artist}, lyrics?: Array, tlyric?: string, confidence }}
   */
  ipcMain.handle('bili:auto-lyric', async (_e, { title }) => {
    const srv = getNcmServer && getNcmServer()
    const { keyword, songName, artist } = cleanTitle(title)
    if (!keyword) return { ok: false, reason: 'no-keyword' }

    const search = await ncmGet(
      srv,
      `/cloudsearch?keywords=${encodeURIComponent(keyword)}&type=1&limit=5`
    )
    const songs = search?.result?.songs || []
    if (!songs.length) {
      return { ok: false, reason: 'no-result', keyword }
    }

    // 选匹配度最高的一条：歌名包含关系 + 歌手出现在标题里
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
    const tNorm = norm(title)
    let best = null
    let bestScore = -1
    for (const s of songs) {
      const n = norm(s.name)
      const a = norm((s.ar || []).map((x) => x.name).join(''))
      let score = 0
      if (n && tNorm.includes(n)) score += 2
      if (a && tNorm.includes(a)) score += 2
      if (songName && norm(songName) === n) score += 1
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    if (!best) return { ok: false, reason: 'no-match', keyword }

    const lyric = await ncmGet(srv, `/lyric?id=${best.id}`)
    const lrc = lyric?.lrc?.lyric || ''
    const tlyric = lyric?.tlyric?.lyric || ''
    if (!lrc) return { ok: false, reason: 'no-lyric', keyword, matched: { id: best.id, name: best.name } }

    return {
      ok: true,
      keyword,
      matched: {
        id: best.id,
        name: best.name,
        artist: (best.ar || []).map((x) => x.name).join('/'),
        album: best.al?.name || '',
        duration: Math.round((best.dt || 0) / 1000)
      },
      lyrics: lrc,
      tlyric,
      // 置信度：0=仅关键词命中 1=歌名命中 2=歌名+歌手都命中
      confidence: Math.min(2, Math.max(0, bestScore - (songName ? 1 : 0)))
    }
  })

  /**
   * 手动搜索网易云歌曲（歌词匹配不准时的兜底入口）。
   */
  ipcMain.handle('bili:search-song', async (_e, { keyword, limit = 10 }) => {
    const srv = getNcmServer && getNcmServer()
    if (!keyword) return { ok: true, list: [] }
    const search = await ncmGet(
      srv,
      `/cloudsearch?keywords=${encodeURIComponent(keyword)}&type=1&limit=${limit}`
    )
    const songs = search?.result?.songs || []
    return {
      ok: true,
      list: songs.map((s) => ({
        id: s.id,
        name: s.name,
        artist: (s.ar || []).map((x) => x.name).join('/'),
        album: s.al?.name || '',
        duration: Math.round((s.dt || 0) / 1000)
      }))
    }
  })

  /** 按歌曲 id 取歌词（手动选定后加载） */
  ipcMain.handle('bili:song-lyric', async (_e, { id }) => {
    const srv = getNcmServer && getNcmServer()
    if (!id) return { ok: false }
    const lyric = await ncmGet(srv, `/lyric?id=${id}`)
    const lrc = lyric?.lrc?.lyric || ''
    const tlyric = lyric?.tlyric?.lyric || ''
    if (!lrc) return { ok: false, reason: 'no-lyric' }
    return { ok: true, lyrics: lrc, tlyric }
  })

  // ---- HLS 实时合流会话 ----

  /** 查询 HLS 会话状态（渲染层轮询到 ready 即可加载播放列表） */
  ipcMain.handle('bili:hls-status', (_e, sessionId) => hlsSessionStatus(sessionId))

  /** 停止 HLS 会话（切换画质 / 关闭播放器时调用，释放 ffmpeg 与临时分片） */
  ipcMain.handle('bili:hls-stop', (_e, sessionId) => stopHlsSession(sessionId))

  /** 停止全部 HLS 会话（离开 B 站页时兜底清理） */
  ipcMain.handle('bili:hls-stop-all', () => {
    stopAllHlsSessions()
    return true
  })

  // ---- 缓存管理 ----
  ipcMain.handle('bili:cache-stats', () => biliCacheStats())
  ipcMain.handle('bili:cache-clear', () => {
    stopAllHlsSessions()
    return clearBiliCache()
  })
}
