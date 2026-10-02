import { ipcMain } from 'electron'
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
  clearCookie
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
export function registerBiliIpc() {
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
          audioUrl: info.audio?.url
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
