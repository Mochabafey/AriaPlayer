# 网易牛具 · Netease Track Resolver — Code Wiki

> 本文档为 [Netease Track Resolver](./README.md) 仓库的结构化代码百科，覆盖项目整体架构、主要模块职责、关键类与函数、依赖关系以及运行方式。

---

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 整体架构](#2-整体架构)
- [3. 技术栈与依赖关系](#3-技术栈与依赖关系)
- [4. 目录结构](#4-目录结构)
- [5. 主进程（Electron Main）](#5-主进程electron-main)
- [6. 预加载脚本（Preload）](#6-预加载脚本preload)
- [7. 渲染进程（Vue 3 Renderer）](#7-渲染进程vue-3-renderer)
- [8. 内置服务（api-enhanced）](#8-内置服务api-enhanced)
- [9. IPC 通道总览](#9-ipc-通道总览)
- [10. 自定义协议 ncm-audio://](#10-自定义协议-ncm-audio)
- [11. 数据持久化](#11-数据持久化)
- [12. 关键算法：NCM 解密与标签写回](#12-关键算法ncm-解密与标签写回)
- [13. 数据流与时序](#13-数据流与时序)
- [14. 构建与运行](#14-构建与运行)
- [15. 工程约定与注意事项](#15-工程约定与注意事项)

---

## 1. 项目概览

**Netease Track Resolver（网易牛具）** 是一款基于 Electron + Vue 3 的网易云音乐桌面客户端。它把完整的 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 服务内置进 Electron 子进程，绕开 Web 端 CORS 与各类限制，提供搜索、解析、播放、下载、本地曲库管理、歌词滚动、扫码登录、解灰、.ncm 解密等桌面化体验。

核心特性：

- **零额外 Node 运行时**：用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 把 Electron 自身当 Node 跑子进程。
- **自定义 `ncm-audio://` 协议**：解决网易音频无 CORS 问题，完整透传 `Range` 支持拖动 seek。
- **零原生依赖打包**：纯 JS（music-metadata、node-id3），无 better-sqlite3 等需编译的依赖。
- **JSON 持久化**：原子写（tmp+rename）+ 300ms 防抖，存于 `userData/ncm-store/`。
- **跨平台打包**：Windows（NSIS+portable）+ macOS（dmg），GitHub Actions 自动构建。

---

## 2. 整体架构

```
┌──────────────────────────────────────────────┐
│  渲染进程 (Vue 3 + Pinia + Vue Router)         │
│  <audio> 走 ncm-audio:// 自定义协议           │
│  window.ncm.invoke(channel, ...args) 调主进程  │
└──────────────────┬───────────────────────────┘
                   │ IPC (contextBridge, 白名单)
┌──────────────────▼───────────────────────────┐
│  Electron 主进程                               │
│  ┌────────────────────────────────────────┐  │
│  │ 窗口 / 对话框 / 协议 / IPC 注册          │  │
│  ├────────────────────────────────────────┤  │
│  │ NcmServer 子进程管理                     │  │
│  │   spawn(execPath, ['app.js'],            │  │
│  │     { env: { ELECTRON_RUN_AS_NODE:1 } }) │  │
│  │   监听随机空闲端口 127.0.0.1              │  │
│  ├────────────────────────────────────────┤  │
│  │ DownloadManager 下载管理器               │  │
│  │ Library / Playlist / NcmConvert IPC     │  │
│  └────────────────────────────────────────┘  │
└──────────────────┬───────────────────────────┘
                   │ HTTP (127.0.0.1:<randomPort>)
┌──────────────────▼───────────────────────────┐
│  api-enhanced 子进程 (Node 模式)               │
│  Express 服务，自动扫描 module/*.js 注册路由    │
│  对外请求网易云 API（eapi/weapi 加密）          │
└──────────────────────────────────────────────┘
```

### 三进程模型

| 进程 | 角色 | 入口 | 构建产物 |
|---|---|---|---|
| 主进程 | Electron 主、窗口、子进程、协议、IPC、下载、曲库 | `src/main/index.js` | `dist/out/main` |
| 预加载 | contextBridge 桥，暴露 `window.ncm` | `src/preload/index.js` | `dist/out/preload` |
| 渲染进程 | Vue 3 UI | `src/renderer/src/main.js` | `dist/out/renderer` |
| api-enhanced | vendored 第三方服务，子进程运行 | `server/app.js` | `extraResources/ncm-server`（不进 asar） |

---

## 3. 技术栈与依赖关系

### 运行时依赖（dependencies）

| 依赖 | 版本 | 用途 |
|---|---|---|
| `hls.js` | ^1.7.0 | MV/视频 HLS 流播放（自定义 Loader 走 ncm-audio 代理） |
| `music-metadata` | ^11.14.0 | 本地音频元数据解析（标题/艺术家/专辑/封面/时长） |
| `node-id3` | ^0.2.9 | MP3 文件 ID3v2 标签写回 |

### 开发依赖（devDependencies）

| 依赖 | 版本 | 用途 |
|---|---|---|
| `electron` | ^43.4.0 | 桌面应用壳 |
| `electron-vite` | ^5.0.0 | 三进程统一构建工具 |
| `electron-builder` | ^26.15.3 | 打包成安装器 |
| `vue` | ^3.5.41 | 渲染进程 UI 框架 |
| `vue-router` | ^4.6.4 | 前端路由（hash 模式） |
| `pinia` | ^3.0.4 | 状态管理 |
| `vite` | ^7.3.6 | 渲染进程打包 |
| `@vitejs/plugin-vue` | ^6.0.8 | Vue SFC 支持 |
| `cross-env` | ^7.0.3 | 跨平台环境变量 |

### 依赖关系图（模块层）

```
渲染进程
  ├─ api/index.js ──── window.ncm (preload 桥)
  ├─ stores/* ─────── api/index.js
  ├─ views/* ──────── stores/*, api, components/*
  └─ components/* ──── stores/*, api, utils/*

主进程
  ├─ index.js ──── ncmServer, audioProtocol, ipc/*, store/db
  ├─ ncmServer.js ─ store/db (读 settings)
  ├─ ipc/api.js ─── store/db, ffmpeg
  ├─ ipc/download.js ─ downloadManager ─ store/db
  ├─ ipc/library.js ── store/db, tags/writeTags, music-metadata
  ├─ ipc/playlist.js ─ store/db
  ├─ ipc/ncmConvert.js ─ ncm/ncmDecrypt, ffmpeg, store/db
  └─ audioProtocol.js ─ (独立，仅依赖 electron/Node 内置)

server (api-enhanced，vendored)
  ├─ app.js ──── generateConfig, server.js
  ├─ server.js ─ Express, util/request, module/*.js (自动扫描)
  └─ util/request.js ─ axios, crypto, anonymous_token
```

---

## 4. 目录结构

```
NTR/
├── package.json                 # 项目元数据 + scripts
├── electron.vite.config.mjs     # 三进程构建配置
├── electron-builder.yml         # 打包配置（NSIS/portable/dmg）
├── README.md
├── CODE_WIKI.md                 # 本文档
│
├── scripts/                     # 构建/开发/工具脚本
│   ├── dev-server.mjs           # dev 入口（自动检查 vendor）
│   ├── build-app.mjs            # 生产构建入口
│   ├── vendor-server.mjs        # 克隆 api-enhanced + 装依赖 + 打补丁
│   ├── fetch-ffmpeg.mjs         # 下载 ffmpeg 二进制到 resources/ffmpeg/
│   ├── smoke-server.mjs         # 烟测模式（CI 验证启动）
│   ├── gen-icon.py              # 零依赖生成应用图标
│   ├── gen-tag-samples.js       # 生成标签测试样本
│   ├── ncm-dump.mjs             # .ncm 解密命令行工具
│   └── test-*.mjs               # 各类测试脚本
│
├── resources/
│   ├── icon.png                 # 应用图标
│   └── ffmpeg/                  # ffmpeg 二进制（fetch-ffmpeg 下载，不入 git）
│
├── src/
│   ├── main/                    # 主进程
│   │   ├── index.js             # 入口：窗口、协议、bootstrap
│   │   ├── ncmServer.js         # api-enhanced 子进程生命周期
│   │   ├── audioProtocol.js     # ncm-audio:// 协议注册
│   │   ├── downloadManager.js   # 下载管理器
│   │   ├── ffmpeg.js            # ffmpeg 封装
│   │   ├── store/db.js          # JSON 持久化（JsonStore）
│   │   ├── ipc/                 # IPC 处理器
│   │   │   ├── api.js           # 通用 API 转发 + cookie + 对话框
│   │   │   ├── download.js      # 下载任务
│   │   │   ├── library.js       # 本地曲库扫描/编辑/导入导出
│   │   │   ├── playlist.js      # 本地歌单
│   │   │   └── ncmConvert.js    # .ncm 批量转换
│   │   ├── ncm/ncmDecrypt.mjs   # .ncm 解密（纯 JS）
│   │   └── tags/writeTags.mjs   # FLAC/M4A 标签写回（纯 JS）
│   │
│   ├── preload/index.js         # contextBridge 桥
│   │
│   └── renderer/                # 渲染进程
│       ├── index.html
│       └── src/
│           ├── main.js          # Vue app 入口
│           ├── App.vue          # 根组件（侧边栏 + 路由出口 + 播放栏）
│           ├── router/index.js  # 路由表（hash 模式，12 个页面）
│           ├── api/index.js     # 前端统一 API 封装
│           ├── stores/          # Pinia stores
│           │   ├── player.js    # 播放器（队列/歌词/音量/转码回退）
│           │   ├── library.js   # 本地曲库
│           │   ├── downloads.js # 下载任务
│           │   └── settings.js  # 设置
│           ├── views/           # 12 个页面
│           │   ├── DiscoverView.vue      # 发现（banner/推荐/新歌/排行）
│           │   ├── SearchView.vue        # 搜索
│           │   ├── ResolverView.vue      # 链接/ID 解析
│           │   ├── LibraryView.vue       # 本地曲库
│           │   ├── DownloadsView.vue     # 下载管理
│           │   ├── ProfileView.vue       # 我的（登录/用户信息）
│           │   ├── SettingsView.vue      # 设置
│           │   ├── PlaylistDetailView.vue
│           │   ├── AlbumDetailView.vue
│           │   ├── ArtistDetailView.vue
│           │   └── MvDetailView.vue      # MV 播放（hls.js）
│           ├── components/      # 复用组件
│           │   ├── PlayerBar.vue   # 底部播放栏
│           │   ├── LyricPanel.vue  # 全屏歌词
│           │   ├── SongTable.vue   # 歌曲列表
│           │   └── AppToast.vue    # 轻提示
│           ├── utils/
│           │   ├── format.js    # 时间/大小/数字/日期格式化
│           │   ├── hlsLoader.js # hls.js 自定义 Loader（走 ncm-audio 代理）
│           │   ├── lrc.js       # LRC 歌词解析
│           │   └── toast.js     # 全局提示队列
│           └── assets/base.css  # 全局样式 + CSS 变量
│
├── server/                      # api-enhanced（vendor 后生成）
│   ├── app.js                   # 服务入口
│   ├── server.js                # Express 工厂（自动扫描 module/）
│   ├── main.js                  # 作为依赖被引入时的入口
│   ├── module/*.js              # 300+ 网易云接口（文件名即路由）
│   ├── util/                    # request/crypto/cache/logger...
│   └── generateConfig.js        # 刷新 anonymous_token + xeapi 公钥
│
└── .github/workflows/build.yml  # 双平台 CI 构建
```

---

## 5. 主进程（Electron Main）

主进程是整个应用的「大脑」，负责窗口管理、子进程托管、自定义协议、IPC 路由、下载与曲库的文件 I/O。

### 5.1 [src/main/index.js](src/main/index.js) — 主入口

**职责**：注册协议特权、创建窗口、装配 IPC、启动子进程、单实例锁、退出清理。

**关键流程**：

1. `protocol.registerSchemesAsPrivileged` — 在 `app.ready` 前注册 `ncm-audio` 协议特权（`stream: true` 支持流式响应）。
2. `app.commandLine.appendSwitch('proxy-bypass-list', ...)` — 绕过系统代理访问本地地址（避免白屏卡死）。
3. `bootstrap()` — 装配 5 个 IPC 模块，创建窗口，启动 `NcmServer`。
4. 单实例锁 `app.requestSingleInstanceLock()` — 第二实例启动时聚焦已有窗口。
5. `before-quit` — 停止子进程 + `flushAll()` 落盘所有 store。

**关键函数**：

| 函数 | 作用 |
|---|---|
| `createWindow()` | 创建 1280×820 主窗口，contextIsolation 开启，sandbox 关闭，加载 dev URL 或本地 index.html |
| `bootstrap()` | 装配 IPC、创建窗口、启动子进程；支持烟测（`NCM_SMOKE=1`）和探测（`NCM_PROBE=1`）模式 |

**容错设计**：

- `ready-to-show` 5s 超时兜底强制显示窗口。
- `uncaughtException` 静默 EPIPE/ECONNRESET/ENOTCONN，避免弹窗。
- 渲染进程 `console-message` 转发到主进程日志，便于排障。

### 5.2 [src/main/ncmServer.js](src/main/ncmServer.js) — 子进程管理

**类 `NcmServer`**：管理 api-enhanced 子进程的完整生命周期。

| 成员/方法 | 说明 |
|---|---|
| `status` | `down` / `starting` / `ready` / `missing` |
| `serverDir()` | 打包后取 `resourcesPath/ncm-server`，开发取 `appPath/server` |
| `findFreePort()` | 监听 0 端口让 OS 分配空闲端口后立即关闭 |
| `buildEnv()` | 构造子进程环境：`ELECTRON_RUN_AS_NODE=1`、`PORT`、`HOST=127.0.0.1`、解灰/FLAC/音质开关、剥离 `HTTP_PROXY` 等代理变量 |
| `start()` | spawn 子进程，`waitReady()` 轮询探测，启动文件监听 |
| `waitReady()` | 每 300ms fetch `http://127.0.0.1:<port>/`，任意 HTTP 响应（含 404）即视为就绪，超时 20s |
| `startWatchServer()` | 每 1.5s 检查 `server.js`/`app.js` mtime，变更自动 restart（dev 下热修复） |
| `restart()` | 主动停止 + 重新启动，重置 restarts 计数 |
| `stop()` | 停止子进程与文件监听 |

**自动重启策略**：子进程异常退出时最多自动重启 `RESTART_MAX=3` 次，间隔 `RESTART_DELAY=5000ms`。

**关键坑点**：剥离系统代理变量——api-enhanced 注册匿名 token 时会对外请求，若继承 `HTTP_PROXY` 会被本机代理（如 `127.0.0.1:10808`）卡住导致 `listen` 永远执行不到。

### 5.3 [src/main/audioProtocol.js](src/main/audioProtocol.js) — 自定义协议

**函数 `registerAudioProtocol()`**：注册 `ncm-audio://` 协议处理器，支持 4 种 host：

| host | 用途 | 说明 |
|---|---|---|
| `stream` | 远程音频代理 | `ncm-audio://stream?url=<真实地址>`，用 Node 原生 http/https 请求上游，透传 Range/Content-Range，绕开 Chromium 网络栈与 CORS |
| `local` | 本地曲库播放 | `ncm-audio://local?path=<本地路径>`，读文件流，支持 Range seek |
| `cover` | 本地封面 | `ncm-audio://cover?path=<图片路径>`，按扩展名定 MIME |
| `img` | 远程图片代理 | `ncm-audio://img?url=<远程图片>`，绕开 Chromium 被系统代理拦截导致的 `ERR_BLOCKED_BY_CLIENT` |

**辅助函数 `fetchUpstream(url, headers)`**：用 Node 原生 `http`/`https` 而非 `net.fetch`，因为后者在代理环境对 http 目标常报 `ERR_BLOCKED_BY_CLIENT`。

**安全限制**：`stream` host 对 url 做白名单校验（必须匹配音频扩展名或 netease/126.net/music.163 域名），否则返回 403。

### 5.4 [src/main/downloadManager.js](src/main/downloadManager.js) — 下载管理器

**类 `DownloadManager`**：并发池、songId 去重、断点续传、进度推送。

| 方法 | 说明 |
|---|---|
| `resolveUrl(songId, quality)` | 兜底：调用方未传 url 时向 api-enhanced 现取播放地址 |
| `add({songId,title,artist,url,quality,cover})` | 新建任务，songId 去重（已存在非失败/暂停则拒绝），无 url 时现取 |
| `pump()` | 维持并发池 `CONCURRENCY=2`，从队列取任务执行 |
| `run(task)` | 执行下载：断点续传（已存在文件用 `Range` 头续传，服务器返回 200 则从头重下），流式写盘，200ms 节流推送进度 |
| `cancel(id)` | AbortController 中止，标记 paused |
| `retry(id)` | 重置进度、删残缺文件、重新入队 |
| `remove(id, {deleteFile})` | 取消 + 从列表移除，可选删文件 |

**文件命名**：`{sanitize(artist)} - {sanitize(title)}.{ext}`，`sanitize` 过滤非法字符并截断 120 字符。

**任务状态机**：`pending → downloading → done | failed | paused`。

### 5.5 [src/main/ffmpeg.js](src/main/ffmpeg.js) — ffmpeg 封装

二进制由 `scripts/fetch-ffmpeg.mjs` 下载到 `resources/ffmpeg/`，打包走 `extraResources`。

| 函数 | 作用 |
|---|---|
| `ffmpegPath()` | 定位二进制（打包后取 `resourcesPath/ffmpeg`） |
| `ffmpegAvailable()` | 检测二进制是否存在 |
| `ffmpegVersion()` | 执行 `ffmpeg -version` 取首行 |
| `transcode(input, output, extraArgs)` | 通用转码，http 输入自动带 UA/Referer |
| `transcodeToWav(input, outputDir)` | 任意音频 → wav（播放回退用） |
| `transcodeToMp3(input, outputDir, name)` | 任意音频 → mp3 |

### 5.6 [src/main/store/db.js](src/main/store/db.js) — JSON 持久化

**类 `JsonStore`**：轻量 JSON 文件存储，带 300ms 防抖和原子写。

| 方法 | 说明 |
|---|---|
| `load()` | 懒加载，合并 defaults |
| `get(key)` / `set(key, value)` | 读写单字段 |
| `update(fn)` | 函数式更新整个对象 |
| `scheduleSave()` | 300ms 防抖后落盘 |
| `saveNow()` | 立即落盘：写 `.tmp` 再 `rename`（原子写，防写坏） |

**预定义 stores**：

| store | 文件 | 默认值 |
|---|---|---|
| `library` | `library.json` | `{ songs: [], folders: [] }` |
| `playlists` | `playlists.json` | `{ list: [] }` |
| `downloads` | `downloads.json` | `{ tasks: [] }` |
| `settings` | `settings.json` | `{ downloadDir, quality:'320000', enableUnblock:true, enableFlac:true, volume:0.8, playMode:'list' }` |

**`QUALITY_MAP`**：`128000→mp3/128k`、`320000→mp3/320k`、`lossless→flac/999k`。

**特殊处理**：用 `require('electron')` 取 `app`，绕开 rollup 对 `import { app }` 的 `__toESM` 命名空间 interop 陷阱。

---

## 6. 预加载脚本（Preload）

### [src/preload/index.js](src/preload/index.js)

**白名单式 IPC 桥**，通过 `contextBridge.exposeInMainWorld('ncm', api)` 暴露最小 API：

```js
window.ncm.invoke(channel, ...args)  // 主进程 invoke 调用
window.ncm.on(channel, cb)           // 订阅主进程事件，返回取消订阅函数
```

安全约束：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`（sandbox 关闭是为了主进程能 spawn 子进程并访问文件系统）。

---

## 7. 渲染进程（Vue 3 Renderer）

### 7.1 [src/renderer/src/main.js](src/renderer/src/main.js) — Vue 入口

创建 Vue app，挂载 Pinia + Vue Router，加载全局样式 `base.css`。

### 7.2 [src/renderer/src/App.vue](src/renderer/src/App.vue) — 根组件

**布局**：左侧深色导航栏 + 右侧顶部搜索栏 + 主内容区 + 底部 PlayerBar + 全屏 LyricPanel。

**导航分组**：

- 推荐 / 搜索 / 解析
- 我的音乐：曲库 / 下载 / 我的
- 设置

**全局快捷键**（`onGlobalKeydown`）：

| 键 | 动作 |
|---|---|
| Space | 播放/暂停 |
| ← / → | 快退/快进 5s |
| ↑ / ↓ | 音量 ±5% |
| Esc | 关闭歌词面板 |

**启动流程**：`onMounted` 加载 settings → 同步音量到 player → 订阅服务状态。

### 7.3 [src/renderer/src/router/index.js](src/renderer/src/router/index.js) — 路由

`createWebHashHistory`（Electron file:// 友好），12 个路由，全部懒加载：

| 路径 | 组件 | 说明 |
|---|---|---|
| `/discover` | DiscoverView | 发现页（默认） |
| `/search` | SearchView | 搜索 |
| `/resolver` | ResolverView | 链接/ID 解析 |
| `/library` | LibraryView | 本地曲库 |
| `/downloads` | DownloadsView | 下载管理 |
| `/profile` | ProfileView | 我的 |
| `/settings` | SettingsView | 设置 |
| `/playlist/:id` | PlaylistDetailView | 歌单详情 |
| `/album/:id` | AlbumDetailView | 专辑详情 |
| `/artist/:id` | ArtistDetailView | 歌手详情 |
| `/mv/:id` | MvDetailView | MV 详情 |

### 7.4 [src/renderer/src/api/index.js](src/renderer/src/api/index.js) — 前端 API 封装

统一的 API 调用层，封装 `window.ncm` 桥。

| 导出 | 作用 |
|---|---|
| `bridge` | `window.ncm` 引用 |
| `routeOf(method)` | 模块名转路由：`song_url_v1` → `song/url/v1` |
| `waitServerReady()` | 轮询服务状态，最多等 15s |
| `api(method, params)` | 调用 api-enhanced 接口，code 非 200/0 抛错 |
| `ncm` 对象 | 按域分组的 IPC 调用封装（server/download/library/playlist/settings/system/convert） |
| `parseLink(input)` | 解析网易云链接 → `{type, id}`，支持 song/playlist/album/artist/mv |
| `resolveLinkInput(input)` | 先 parseLink，失败则尝试短链跳转（163cn.tv）后再解析 |
| `coverUrl(id, size)` | 拼接网易云封面 CDN URL |
| `imgUrl(url)` | 远程图片包装为 `ncm-audio://img?url=` 代理 |

### 7.5 Pinia Stores

#### [stores/player.js](src/renderer/src/stores/player.js) — 播放器

全局播放器单例，`<audio>` 元素挂载在 PlayerBar。

| 状态 | 说明 |
|---|---|
| `queue` / `currentIndex` | 播放队列与当前索引 |
| `playing` / `buffering` | 播放态、缓冲态 |
| `currentTime` / `duration` | 当前时间、总时长 |
| `volume` | 音量（0-1） |
| `lyrics` | 当前歌曲歌词 `[{time, text}]` |
| `showLyrics` | 是否展开全屏歌词 |
| `playError` | 播放错误信息（6s 后自动清空） |

| 关键方法 | 说明 |
|---|---|
| `attachAudio(el)` | 绑定 audio 元素，监听 timeupdate/play/pause/waiting/ended/error |
| `audioUrl(song)` | 本地走 `ncm-audio://local`，远程走 `ncm-audio://stream` |
| `normalizeSong(song)` | 统一网易云歌曲字段（ar→artist, al→album）为内部结构 |
| `playList(list, index)` | 替换队列并播放，歌词并行加载不阻塞起播 |
| `playCurrent()` | 起播：无 url 时先 `song_url_v1` 解析，乐观置播放态 |
| `fallbackTranscode()` | 格式不支持时用 ffmpeg 转 wav 重播（每首只尝试一次） |
| `loadLyrics(song)` | 拉 `lyric` 接口 + `parseLrc` 解析 |
| `next(auto)` / `prev()` | 切歌：`loop` 模式 auto 重播当前，`shuffle` 随机 |
| `setVolume(v)` | 同步 audio 元素 + 持久化到 settings |

#### [stores/settings.js](src/renderer/src/stores/settings.js) — 设置

Options API 风格 store，`load()` 从主进程读，`set(key, value)` 写回主进程并同步本地。

#### [stores/library.js](src/renderer/src/stores/library.js) — 本地曲库

`load()` 并行拉 songs + folders；`scan()` 扫描后重载；`byId(id)` getter。

#### [stores/downloads.js](src/renderer/src/stores/downloads.js) — 下载任务

`watch()` 订阅 `ncm:download-progress` / `ncm:download-done` 事件实时更新任务。

### 7.6 关键组件

| 组件 | 职责 |
|---|---|
| [PlayerBar.vue](src/renderer/src/components/PlayerBar.vue) | 底部播放栏：圆形封面 + 进度条（拖拽+悬停提示）+ 控制按钮 + 音量条 + 播放模式切换（list/loop/shuffle） |
| [LyricPanel.vue](src/renderer/src/components/LyricPanel.vue) | 全屏歌词：滚动跟随、封面背景模糊 |
| [SongTable.vue](src/renderer/src/components/SongTable.vue) | 歌曲列表：双击播放、下载、喜欢、当前播放高亮 + EQ 动画 |
| [AppToast.vue](src/renderer/src/components/AppToast.vue) | 全局轻提示队列渲染 |

### 7.7 [utils/](src/renderer/src/utils)

| 文件 | 作用 |
|---|---|
| [format.js](src/renderer/src/utils/format.js) | `fmtTime`/`fmtSize`/`fmtCount`（万为单位）/`fmtDate` |
| [lrc.js](src/renderer/src/utils/lrc.js) | `parseLrc(raw)` 解析 LRC 为 `[{time,text}]`；`activeIndex(lines, time)` 按时间找当前行 |
| [hlsLoader.js](src/renderer/src/utils/hlsLoader.js) | `NcmProxyLoader` 实现 hls.js Loader 接口，把清单/分片请求走 `ncm-audio://stream` 代理 |
| [toast.js](src/renderer/src/utils/toast.js) | `toast(message, type)` 全局提示队列（最多 5 条，error 4.2s 其余 2.8s 自动消失） |

---

## 8. 内置服务（api-enhanced）

`server/` 目录是 vendored 的 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，由 `scripts/vendor-server.mjs` 克隆并打补丁。

### 8.1 [server/app.js](server/app.js) — 服务入口

1. 确保 `os.tmpdir()/anonymous_token` 存在（不存在则写空文件）。
2. `generateConfig()` 刷新匿名 cookie 与 xeapi 公钥。
3. `server.serveNcmApi({ checkVersion: true })` 启动 Express。

### 8.2 [server/server.js](server/server.js) — Express 工厂

**核心机制**：`getModulesDefinitions()` 自动扫描 `module/*.js`，每个文件注册一条路由。

**路由规则**：文件名 `_` 转 `/`，如 `album_new.js` → `/album/new`、`song_url_v1.js` → `/song/url/v1`、`login_qr_key.js` → `/login/qr/key`。少数特例（`daily_signin`/`fm_trash`/`personal_fm`）硬编码在 `server.js` 的 `special` 对象里。

**中间件**：dotenv、express-fileupload、safe-decode-uri-component、apicache（2 分钟缓存）、cookie 解析。

### 8.3 module/*.js — 接口模块

300+ 个接口文件，标准写法：

```js
module.exports = (query, request) =>
  request(path, data, createOption(query))
```

`createOption`（`util/option.js`）负责 crypto（`api`/`eapi`/`weapi`/`linuxapi`/`xeapi`）、cookie 回退、proxy、realIP/randomCNIP、headers、timeout。

### 8.4 [server/util/request.js](server/util/request.js) — 唯一对外 HTTP 层

基于 axios + 自定义 keep-alive agent，显式 `proxy: false`（环境变量代理不生效）。在 require 时同步读取 `anonymous_token` 与 `xeapi_public_key`。

### 8.5 vendor 补丁

`scripts/vendor-server.mjs` 的 `applyPatches()` 对 `server.js` 打两处补丁（防止 vendor 覆盖后丢失）：

1. 解灰触发条件 `req.baseUrl` → `req.path`（`app.all` 挂载下 `req.baseUrl` 恒为空）。
2. 解灰 `matchID` 加 8s 超时（外部源慢/挂起会导致 `song_url_v1` 30s+ 超时）。

---

## 9. IPC 通道总览

### invoke 通道（渲染 → 主）

| 通道 | 处理器 | 说明 |
|---|---|---|
| `ncm:api` | ipc/api.js | 通用 API 转发到 api-enhanced，带 cookie jar，登录态接口绕过缓存 |
| `ncm:resolve-link` | ipc/api.js | 短链跳转解析（163cn.tv 等） |
| `ncm:server-status` | ipc/api.js | 查询服务状态 |
| `ncm:server-restart` | ipc/api.js | 重启子进程 |
| `ncm:ffmpeg-version` | ipc/api.js | ffmpeg 版本 |
| `ncm:ffmpeg-transcode` | ipc/api.js | 任意音频 → wav（播放回退） |
| `ncm:save-dialog` / `ncm:open-folder` / `ncm:select-folder` | ipc/api.js | 系统对话框 |
| `ncm:settings-get` / `ncm:settings-set` | ipc/api.js | 设置读写 |
| `ncm:download-add` / `list` / `cancel` / `retry` / `remove` | ipc/download.js | 下载任务管理 |
| `ncm:library-list` / `folders` / `add-folder` / `scan` / `edit` / `remove` / `export` / `import` | ipc/library.js | 本地曲库 |
| `ncm:playlist-list` / `save` / `remove` / `export-m3u` / `import-m3u` | ipc/playlist.js | 本地歌单 |
| `ncm:convert-pick-file` / `pick-dir` / `batch` | ipc/ncmConvert.js | .ncm 转换 |

### 事件通道（主 → 渲染）

| 通道 | 触发时机 |
|---|---|
| `ncm:server-status` | 子进程状态变化 |
| `ncm:download-progress` | 下载进度（200ms 节流） |
| `ncm:download-done` | 下载完成 |
| `ncm:library-updated` | 曲库变更 |
| `ncm:convert-progress` | NCM 转换进度 |

---

## 10. 自定义协议 ncm-audio://

在 `app.ready` 前注册特权（`stream: true, supportFetchAPI: true, bypassCSP: true`），`registerAudioProtocol()` 用 `protocol.handle()` 注册处理器。

### 为什么需要

- 网易音频 CDN 无 CORS 头，渲染进程直接 fetch 会被浏览器拦截。
- Chromium 网络栈只认系统代理，本机代理软件残留会让 `net.fetch` 报 `ERR_BLOCKED_BY_CLIENT`。
- 主进程用 Node 原生 http/https 请求上游，可手动补 UA/Referer 防盗链头，并完整透传 Range 支持 seek。

### URL 形态

| URL | 用途 |
|---|---|
| `ncm-audio://stream?url=<远程音频>` | 远程音频代理（透传 Range） |
| `ncm-audio://local?path=<本地路径>` | 本地曲库播放 |
| `ncm-audio://cover?path=<图片>` | 本地封面 |
| `ncm-audio://img?url=<远程图片>` | 远程图片代理 |

---

## 11. 数据持久化

所有持久化数据存于 `app.getPath('userData')/ncm-store/`：

```
userData/
└── ncm-store/
    ├── library.json      # 本地曲库歌曲 + 扫描文件夹
    ├── playlists.json    # 本地自建歌单
    ├── downloads.json    # 下载任务历史
    └── settings.json     # 全局设置
```

### 写入策略

- **防抖**：`scheduleSave()` 300ms 内多次写合并为一次。
- **原子写**：`saveNow()` 先写 `.tmp` 再 `rename`，避免写坏。
- **退出落盘**：`app.before-quit` 调 `flushAll()` 立即写所有 store。

### 封面缓存

本地曲库封面提取后存于 `userData/covers/<fileHash>.{jpg|png}`，`fileHash = md5(path|size|mtimeMs).slice(0,16)`。

---

## 12. 关键算法：NCM 解密与标签写回

### 12.1 [src/main/ncm/ncmDecrypt.mjs](src/main/ncm/ncmDecrypt.mjs) — .ncm 解密

纯 JS 实现（零原生依赖），算法移植自 [taurusxin/ncmdump](https://github.com/taurusxin/ncmdump)（MIT）。

**.ncm 文件结构**（小端字节序）：

```
0x00  8B   魔数 "CTENFDAM"
0x08  2B   跳过
0x0A  4B   key 长度 n
0x0E  nB   key 数据（每字节 ^0x64 → AES-128-ECB 解密(coreKey) → 取 [17:] 构建 keybox）
之后  4B   meta 长度 m（>0 时：m 字节 ^0x63 → 跳 22B → base64 → AES-128-ECB(modifyKey) → 跳 6B → JSON）
之后  5B   跳过（crc32 + image version）
之后  4B   coverFrameLen；4B coverLen；coverLen B 封面图
之后       音频数据（0x8000 分块，逐字节 xor keybox 变换）
```

| 函数 | 作用 |
|---|---|
| `aesEcbDecrypt(key, data)` | AES-128-ECB 解密，按末字节剥除 padding（pad>16 视为 0） |
| `buildKeyBox(key)` | 构建 256 字节 keybox（RC4 KSA 变体） |
| `decryptBlock(buf, box)` | 音频块逐字节解密：`buf[i] ^= box[(box[j] + box[(box[j]+j)&0xff]) & 0xff]` |
| `parseMeta(json)` | 解析 meta JSON，artist 为 `[[name]]` 结构 |
| `decryptNcmFile(inputPath, opts)` | 解密单个文件，首块判断格式（ID3→mp3 否则 flac），可选写标签 |
| `collectNcmFiles(dir)` | 递归收集目录下所有 .ncm |
| `writeTags(filePath, meta, coverPath, format)` | 写标签：mp3 用 node-id3，flac/m4a 调 writeTags.mjs |

### 12.2 [src/main/tags/writeTags.mjs](src/main/tags/writeTags.mjs) — FLAC/M4A 标签写回

纯 JS 字节级操作，补齐 node-id3 不支持的 .flac/.m4a。

| 函数 | 作用 |
|---|---|
| `writeFileTags(filePath, tags)` | 入口：mp3 走 node-id3，flac 走 `writeFlacTags`，m4a 走 `writeMp4Tags` |
| `writeFlacTags(buf, tags)` | 解析 FLAC metadata block 链，替换或插入 VORBIS_COMMENT(type=4)，复用 PADDING 空间避免音频帧偏移变化 |
| `buildVorbisComment(fields, vendor)` | 构造 Vorbis Comment：vendor + 评论数 + 每条 `KEY=value`（长度小端） |
| `writeMp4Tags(buf, tags)` | 解析 MP4 box 树，重建 moov（替换/新建 udta>meta>ilst），修正 stco 偏移（mdat 后的 chunk offset 整体后移 delta） |
| `parseMp4(buf, start, end)` | 递归解析 MP4 box 树，支持 64 位 size、meta full box |
| `buildIlst(items)` | 构造 ilst：每个 item 一个盒子（©nam/©ART/©alb），内含 data box（type=1 UTF-8 文本） |

**安全策略**：仅在标签块已存在或可按容器结构安全插入时才落盘，否则返回 false 保持原文件不变。

---

## 13. 数据流与时序

### 13.1 应用启动

```
app.whenReady()
  → registerAudioProtocol()
  → bootstrap()
      → registerXxxIpc() × 5     // 装配 IPC 处理器
      → createWindow()           // 创建窗口，加载 renderer
      → server.start()           // spawn api-enhanced 子进程
          → findFreePort()
          → spawn(execPath, ['app.js'], { env: ELECTRON_RUN_AS_NODE=1, PORT, ... })
          → waitReady()          // 轮询 fetch / 直到 HTTP 响应
          → startWatchServer()   // 监听 server.js 变更自动重启
  → 渲染进程 onMounted
      → settings.load()          // 从主进程读设置
      → player.setVolume()       // 同步音量
      → serverStatus 订阅
```

### 13.2 播放一首歌

```
用户点击歌曲
  → SongTable.playAt(i)
  → player.playList(songs, i)
      → normalizeSong() 入队
      → startCurrent()  // 乐观置播放态，并行 loadLyrics
      → playCurrent()
          → 无 audioUrl? → api('song_url_v1', {id, level})  // 解析播放地址
          → audioEl.src = ncm-audio://stream?url=<解析到的url>
          → audioEl.play()
              → 失败(格式不支持)? → fallbackTranscode()  // ffmpeg 转 wav 重播
```

### 13.3 下载一首歌

```
用户点下载
  → api('song_url_v1') 取 url
  → downloads.add({songId, title, artist, url, quality, cover})
      → ipc: ncm:download-add
      → DownloadManager.add()
          → songId 去重检查
          → 入队 → pump()
          → run(task)
              → fetch(url, { Range: bytes=已下载- })  // 断点续传
              → 流式写盘，200ms 节流 send('ncm:download-progress')
              → 完成 send('ncm:download-done')
      → 渲染进程 downloads.watch() 订阅事件实时更新 UI
```

### 13.4 .ncm 批量转换

```
用户选文件/目录
  → ipc: ncm:convert-pick-file / pick-dir
  → ipc: ncm:convert-batch({ path, format })
      → collectNcmFiles()  // 递归扫描
      → 逐文件:
          decryptNcmFile()  // 解密 → mp3/flac
          → format ≠ 源格式? transcode()  // ffmpeg 转码
          → writeTags()  // 写标签（按最终格式）
          → send('ncm:convert-progress')
```

---

## 14. 构建与运行

### 14.1 环境要求

- **Node.js 22+**（推荐 nvm/fnm 管理）
- **Git**（vendor 需克隆 api-enhanced）
- 打包 Windows 需要 Windows 机器，macOS 需要 macOS 机器（或用 GitHub Actions）

### 14.2 开发

```bash
# 1. 安装依赖
npm install

# 2. vendor api-enhanced 到 server/（首次必需）
npm run vendor

# 3. 启动开发模式
npm run dev
```

`npm run dev` 走 `scripts/dev-server.mjs`：检测 `server/` 缺失则先 vendor，再用 electron-vite 的 `createServer` API 启动（绕开 CLI 在部分 shell 下静默失败的坑）。

### 14.3 打包

```bash
npm run build          # 编译三进程到 dist/out/
npm run pack:win       # Windows NSIS + portable（仅 Windows）
npm run pack:mac       # macOS dmg（仅 macOS）
npm run pack:dir       # 解包测试，不生成安装器
```

### 14.4 辅助脚本

| 命令 | 作用 |
|---|---|
| `npm run fetch:ffmpeg` | 下载 ffmpeg 二进制到 `resources/ffmpeg/` |
| `npm run smoke` | 烟测模式（`NCM_SMOKE=1` 验证启动后退出） |
| `npm run test:tags` | 标签写回测试 |
| `npm run vendor -- --force` | 强制重新拉取 api-enhanced |

### 14.5 构建产物

```
dist/
├── out/                # electron-vite 构建产物
│   ├── main/
│   ├── preload/
│   └── renderer/
└── release/            # electron-builder 安装包输出
```

### 14.6 打包配置（electron-builder.yml）

- `appId: com.ntr.resolver`
- `extraResources`: `server/` → `ncm-server`（不进 asar，子进程直接运行需写 cookie）、`resources/ffmpeg` → `ffmpeg`
- Windows: NSIS（可改安装路径）+ portable
- macOS: dmg（x64 + arm64）
- Electron 镜像：`npmmirror.com/mirrors/electron/`

### 14.7 GitHub Actions

`.github/workflows/build.yml` 在 `windows-latest` 和 `macos-latest` runner 上分别构建并上传 artifact。push `v*` tag 自动在 Release 页面发布。

---

## 15. 工程约定与注意事项

### 硬约束

- 所有 HLS 错误处理分支必须用一致的 8 空格缩进。
- NCM 转换进度事件必须在渲染进程订阅。
- 歌曲播放历史必须先取 song ID 再取完整歌曲详情。
- Banner 链接必须按 targetType（album/playlist/mv）路由。

### 工程约定

- 路由参数变化（如 `/playlist/:id`）需 watcher 重载组件数据。
- 播放器音量启动时必须与持久化设置同步。
- 歌词面板切歌时必须重置滚动位置。

### 经验教训

- 用 `recoverMediaError()` 处理网络错误会导致 MV 播放黑屏。
- 直接把播放记录原始数据喂给 SongTable 会导致空行。

### 关键技术决策

| 关注点 | 方案 | 原因 |
|---|---|---|
| 不打包额外 Node 运行时 | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | 复用 Electron 自身，减小体积 |
| api-enhanced 不进 asar | `extraResources: server → ncm-server` | 子进程需写 cookie 数据文件，asar 内只读 |
| 网易音频无 CORS | 自定义 `ncm-audio://` 协议 | 主进程 Node http 请求，绕开 Chromium 网络栈 |
| Range/seek 拖动 | 协议层透传 `Range`/`Content-Range` | 完整支持断点播放 |
| 零原生依赖 | 纯 JS（music-metadata、node-id3） | 避免 better-sqlite3 等需编译的依赖 |
| 持久化 | JSON 文件 + 原子写 + 防抖 | 简单可靠，无数据库开销 |
| 渲染进程代理绕过 | `proxy-bypass-list` + 剥离子进程代理变量 | 避免系统代理残留导致白屏/服务挂起 |

### 已知坑点

1. **Chromium 网络栈只认系统代理**：不认 `NO_PROXY` 环境变量，必须 `proxy-bypass-list`。
2. **`net.fetch` 在代理环境对 http 目标报 `ERR_BLOCKED_BY_CLIENT`**：音频/图片代理改用 Node 原生 http/https。
3. **rollup `__toESM` 命名空间 interop 陷阱**：`import { app } from 'electron'` 会丢失 app，改用 `require('electron')`。
4. **Electron Windows 下 `['openFile','openDirectory']` 组合有 bug**（electron#48217）：文件/目录选择拆成两个独立入口。
5. **api-enhanced `req.baseUrl` 在 `app.all` 挂载下恒为空**：解灰触发条件改为 `req.path`（vendor 补丁）。
6. **断点续传服务器返回 200（忽略 Range）**：必须从头重下，否则追加会写坏文件。
7. **EPIPE 在 vite 子进程管道断开时不可避免**：`safeWrite` 静默忽略，避免弹窗。

---

## 许可

本项目仅供学习交流使用，请尊重版权，勿用于商业用途。依赖的 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 遵循 MIT License。
