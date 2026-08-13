# 网易牛具 · Netease Track Resolver

> 基于 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 的网易云音乐解析/播放/下载桌面工具。

网易牛具是一台「轻量级网易云音乐客户端」：把整个 api-enhanced 服务内置进 Electron，绕开 web 端各种限制，桌面化体验（歌词滚动、封面墙曲库、下载、扫码登录、解灰）。

## 核心特性

- **内置完整 api-enhanced 服务** — 用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE` 模式）跑子进程，无须用户预装 Node
- **全网最全的网易云接口** — 搜索、歌曲 URL 解析、歌词、排行榜、推荐、私人 FM、MV、评论、歌手/专辑/歌单
- **音频代理** — 自定义 `ncm-audio://` 协议解决网易音频无 CORS 问题，完整透传 Range 支持拖动 seek
- **登录与解灰** — 支持二维码 / 手机号登录，开启全局解灰可听无版权歌曲
- **下载管理** — 320k 高品 / FLAC 无损可切换，断点续传、songId 去重、进度推送
- **本地曲库** — 文件夹扫描导入、元数据读取、ID3 标签写回（MP3）、**封面墙可视化管理**、本地自建歌单、m3u/json 导入导出
- **打包** — Windows (NSIS+portable) + macOS (dmg)，GitHub Actions 自动构建，零原生依赖

## 架构

```
┌──────────────────────────┐
│  Vue 3 + Pinia 渲染进程   │  <audio> 走 ncm-audio:// 自定义协议
└──────────────┬───────────┘
               │ IPC (contextBridge)
┌──────────────▼───────────┐
│   Electron 主进程          │  窗口、对话框、子进程管理、ncm-audio 协议
│  ┌────────────────────┐  │
│  │ ncmServer 子进程     │  │  api-enhanced（ELECTRON_RUN_AS_NODE=1）
│  │  http://127.0.0.1   │  │  占用 30-50MB，来自 Resources/ncm-server
│  └────────────────────┘  │
│  ┌────────────────────┐  │
│  │  下载管理器 + 曲库  │  │  并发 2、断点续传、JSON 持久化
│  └────────────────────┘  │
└──────────────────────────┘
```

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
| api-enhanced 写 cookie | 服务放 `extraResources`（Resources/ncm-server），不进 asar |
| 网易音频无 CORS | 自定义 `ncm-audio://stream?url=` + `ncm-audio://local?path=` 协议 |
| Range/seek 拖动 | 协议层完整透传 `Range`/`Content-Range`/`Content-Length` |
| 零原生依赖打包 | 纯 JS（music-metadata、node-id3），无 better-sqlite3 等 |
| 持久化 | JSON 文件 `userData/ncm-store/`，原子写（tmp+rename）+ 300ms 防抖 |

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
│   │   ├── index.js
│   │   ├── ncmServer.js     # api-enhanced 子进程管理
│   │   ├── audioProtocol.js # ncm-audio:// 协议
│   │   ├── downloadManager.js
│   │   ├── store/db.js      # JSON 持久化
│   │   └── ipc/{api,download,library,playlist}.js
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
