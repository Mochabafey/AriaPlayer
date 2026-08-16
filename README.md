# 网易牛具 · Netease Track Resolver

> 基于 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 的网易云音乐解析/播放/下载桌面工具。

网易牛具是一台「轻量级网易云音乐客户端」：把整个 api-enhanced 服务内置进 Electron，绕开 web 端各种限制，桌面化体验（歌词滚动、封面墙曲库、下载、扫码登录、解灰）。

## 核心特性

- **内置完整 api-enhanced 服务** — 用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE` 模式）跑子进程，无须用户预装 Node
- **私有通道通信** — 主进程与 api 服务走 Named Pipe / Unix Socket，**不占用任何 TCP 端口**，无端口冲突、无本机抓包
- **全网最全的网易云接口** — 搜索、歌曲 URL 解析、歌词、排行榜、推荐、私人 FM、MV、评论、歌手/专辑/歌单
- **播放稳定性纵深** — 磁盘预缓冲（边下边播落盘）+ 断点续传自愈 + 换源重连 + ffmpeg 转码兜底，多层冗余对抗网络抖动
- **音频持久缓存** — 完整下载的歌自动转正进 `userData/audio-cache/`，再次播放零网络秒开；上限 0–8GB 可调（设置页），LRU 淘汰；下载任务命中缓存直接本地拷贝
- **歌词面板** — Apple Music 风格播放页：rAF 缓动逐行高亮滚动、翻译同步高亮（可开关）、沉浸模式（10 秒无操作自动隐藏控制区）、当前播放队列抽屉、单曲循环/音量/收藏
- **无边框窗口** — 自绘标题栏，最小化/最大化/关闭嵌入页面，标题栏区域可拖拽
- **登录与解灰** — 二维码 / 手机号登录；会员自动走官方音源（无损/Hi-Res），仅无版权或试听片段才解灰兜底；登录态用 Electron safeStorage 加密持久化
- **SQLite 数据库** — Node.js 内置 `node:sqlite`，零原生依赖；设置/曲库/歌单/下载任务/API 缓存/会话统一入库，含旧 JSON 数据自动迁移
- **下载管理** — 320k 高品 / FLAC 无损可切换，断点续传、songId 去重、进度推送
- **本地曲库** — 文件夹扫描导入、元数据读取、ID3 标签写回（MP3）、封面墙可视化管理、本地自建歌单、m3u/json 导入导出、NCM 批量转换
- **打包** — Windows (NSIS+portable) + macOS (dmg)，GitHub Actions 自动构建，零原生依赖

## 架构

```
┌──────────────────────────────┐
│  Vue 3 + Pinia 渲染进程       │  <audio> 走 ncm-audio:// 自定义协议
└──────────────┬───────────────┘
               │ IPC (contextBridge)
┌──────────────▼───────────────┐
│   Electron 主进程              │  无边框窗口、下载、SQLite、ncm-audio 协议
│  ┌────────────────────────┐  │
│  │ ncmServer 子进程         │  │  api-enhanced（ELECTRON_RUN_AS_NODE=1）
│  │  Named Pipe/Unix Socket │  │  bridge.cjs 劫持 listen() 绑定私有通道
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ audioCache 播放缓存      │  │  预缓冲落盘 + 持久缓存 + 断点续传自愈
│  ├────────────────────────┤  │
│  │ SQLite (node:sqlite)   │  │  settings/library/playlists/downloads/
│  │ userData/ncm-store/    │  │  session(加密)/api_cache/audio_cache
│  └────────────────────────┘  │
└──────────────────────────────┘
```

## 播放可靠性设计

| 层级 | 机制 |
|---|---|
| 磁盘预缓冲 | 起播即后台整曲下载到临时文件，播放读本地盘，网络抖动不影响播放 |
| 上游自愈 | 上游断开/停滞 >10s → 断点续传重连 ×3（退避 400ms 起），播放无感 |
| 直连兜底 | 超前 seek / M4A 尾部探测 → 独立连接直连上游，不等顺序下载追赶 |
| 渲染层恢复 | 刷新音源地址重连 ×2（第二次降级音质换 CDN 线路） |
| 转码兜底 | 解码类错误 → ffmpeg 转码 WAV 再播 |
| 下一曲预解析 | 临近结束 30s 预取音源地址，连播零空隙 |
| 持久缓存 | 完整曲自动转正，二次播放零网络 |

## 开发

需要本地 **Node.js 22+**（推荐用 `nvm`/`fnm`）和 **Git**。

```bash
# 1. 安装依赖
npm install

# 2. vendor api-enhanced 到 server/（首次必需）
npm run vendor

# 3. 启动开发模式
npm run dev
```

`npm run dev` 会自动检测 `server/`，缺失则先执行 vendor。Electron 主进程会通过 `ELECTRON_RUN_AS_NODE=1` 自动拉起内置 api-enhanced 子进程。

## 打包

```bash
# 当前平台构建
npm run build          # 编译三进程（out/）
npm run pack:win       # Windows NSIS+portable（仅 Windows 上执行）
npm run pack:mac       # macOS dmg（仅 macOS 上执行）
npm run pack:dir       # 解包测试，不生成安装器
```

Windows 在 Windows 机器上构建，macOS 在 macOS 机器上构建（或用 GitHub Actions）。

## GitHub Actions 双平台构建

`.github/workflows/build.yml` 在 `windows-latest` 和 `macos-latest` runner 上分别构建并上传 artifact。
在 commit 上传 v* tag 即可在 Release 页面自动发布。

## 关键技术点

| 关注点 | 方案 |
|---|---|
| 不用额外打包 Node 运行时 | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 把 Electron 自身当 Node |
| 不占 TCP 端口 | `bridge.cjs` 劫持 `net.Server.listen`，服务绑定 Named Pipe（win）/ Unix Socket（unix） |
| 私有通道下 req.ip 未定义 | bridge 伪装 `socket.remoteAddress` 为 `127.0.0.1`（服务端 realIP 依赖） |
| 网易音频无 CORS | 自定义 `ncm-audio://stream?url=` + `ncm-audio://local?path=` 协议 |
| Range/seek 拖动 | 协议层完整透传 `Range`/`Content-Range`/`Content-Length`，支持后缀 Range（M4A moov 探测） |
| 持久化 | SQLite（Node 内置 `node:sqlite`），API 响应缓存含 TTL 与登录态指纹隔离 |
| 登录态安全 | cookie（MUSIC_U）经 safeStorage/AES-256-GCM 加密存 `userData/ncm-store/session`，不进仓库 |
| 会员音源 | 仅 url 为空或试听片段才解灰，fee=VIP 不再误换第三方源 |
| 零原生依赖打包 | 纯 JS（music-metadata、node-id3、node:sqlite），无 better-sqlite3 等 |

## 目录

```
.
├── package.json
├── electron.vite.config.mjs
├── electron-builder.yml
├── scripts/
│   ├── vendor-server.mjs    # 克隆 api-enhanced + 装生产依赖
│   ├── dev-server.mjs       # dev 入口（自动检查 vendor）
│   └── gen-icon.py          # 零依赖生成应用图标
├── resources/
│   └── icon.png             # 自动生成的红渐变 + 音符图标
├── src/
│   ├── main/                # 主进程
│   │   ├── index.js         # 无边框窗口 + IPC 注册
│   │   ├── ncmServer.js     # api-enhanced 子进程管理（私有通道）
│   │   ├── ncm/bridge.cjs   # listen() 劫持 → Named Pipe / Unix Socket
│   │   ├── audioProtocol.js # ncm-audio:// 协议（三档读通道分流）
│   │   ├── audioCache.js    # 预缓冲会话 + 持久缓存 + 断点续传
│   │   ├── downloadManager.js
│   │   ├── ffmpeg.js        # 音频转码兜底
│   │   ├── db/              # SQLite 仓储层（含 JSON 迁移）
│   │   └── ipc/{api,download,library,playlist,ncmConvert}.js
│   ├── preload/index.js     # contextBridge 桥
│   └── renderer/            # Vue 3 前端
│       └── src/
│           ├── App.vue / main.js / router/
│           ├── stores/      # player / library / downloads / settings
│           ├── views/       # 12 个页面
│           ├── components/  # PlayerBar / LyricPanel / SongTable
│           ├── api/ / utils/ / assets/
├── server/                  # api-enhanced（执行 vendor 后生成）
└── .github/workflows/build.yml
```

## 许可

本项目仅供学习交流使用，**请尊重版权，勿用于商业用途**。

依赖的 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 项目遵循 MIT License。
