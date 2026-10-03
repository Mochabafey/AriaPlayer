# 咏叹调 · Aria Player

> **三音源**（网易云 + QQ 音乐 + B 站）解析 / 播放 / 下载桌面客户端。
> 把上游 API 服务全部内置进 Electron，绕开 web 端限制，做成一台完整的桌面播放器。

[api-enhanced]: https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
[qq-music-api]: https://github.com/Rain120/qq-music-api

---

## 目录

- [特性总览](#特性总览)
- [架构](#架构)
- [播放可靠性设计](#播放可靠性设计)
- [B 站 MV 源](#b-站-mv-源)
- [关键实现细节](#关键实现细节)
- [开发](#开发)
- [打包](#打包)
- [目录结构](#目录结构)
- [踩坑记录](#踩坑记录)
- [许可](#许可)

---

## 特性总览

### 音源

| 音源 | 能力 |
|---|---|
| **网易云** | 搜索、URL 解析、歌词、排行榜、推荐、私人 FM、MV、评论、歌手/专辑/歌单（[api-enhanced]） |
| **QQ 音乐** | 搜索、播放、歌词、扫码登录（[qq-music-api]） |
| **B 站** | 视频搜索、DASH 取流、HLS 实时合流、4K/1080P+ 画质、扫码登录、三行字幕歌词 |

- **多音源聚合** — 同名歌曲自动折叠（展开切换音源）、平台 Logo 标识、歌手/专辑/MV 双源聚合；默认音源可在设置中选择
- **登录与解灰** — 网易云二维码/手机号登录、QQ 音乐扫码、**B 站扫码**；会员自动走官方音源（无损/Hi-Res），仅无版权或试听片段才解灰兜底
- **播放记录同步** — 网易云听歌打卡（30s 或 50% 阈值触发，按真实收听时长计，暂停不计）

### 播放

- **磁盘预缓冲** — 起播即后台整曲落盘，播放读本地，网络抖动不影响
- **音频持久缓存** — 完整下载的歌自动转正，二次播放零网络；上限 0–8GB 可调，LRU 淘汰
- **音量感知曲线** — 滑块→振幅走三次方映射，符合人耳对数感知（详见[关键实现细节](#音量曲线)）
- **播放稳定性纵深** — 断点续传自愈 + 换源重连 + ffmpeg 转码兜底，多层冗余对抗网络抖动
- **视频接管** — B 站 MV 播放时底部播放条自动接管（标题/进度/音量统一），全局快捷键不再误操作后台音乐

### 界面

- **歌词面板** — Apple Music 风格：rAF 缓动逐行高亮、翻译同步、F11 沉浸全屏、当前队列抽屉
- **B 站 MV 播放页** — 仿 B 站交互：三层进度条（已播/缓冲/悬停预览）、倍速菜单、画质菜单、网页全屏、控制条 3s 自动隐藏
- **三行字幕歌词** — MV 页在进度条上方叠加三行（上=已播/中=高亮/下=待播），歌词自动匹配网易云，支持手动搜索
- **下载反馈** — 完成 toast + 底部角标进度环 + 全局进度指示器；断点续传，`.part` 保留续下
- **无边框窗口** — 自绘标题栏，最小化/最大化/关闭嵌入页面

### 数据与安全

- **SQLite** — Node 内置 `node:sqlite`，零原生依赖；设置/曲库/歌单/下载任务/API 缓存/会话统一入库，含旧 JSON 自动迁移
- **本地曲库** — 文件夹扫描、元数据读取、ID3 写回（MP3）、封面墙、自建歌单、m3u/json 导入导出、NCM 批量转换
- **安全加固** — IPC 白名单桥 + sandbox 渲染隔离、音频代理 URL 校验（防 SSRF）、HLS 协议目录穿越防护
- **登录态加密** — cookie 经 safeStorage / AES-256-GCM 加密存盘，不进仓库
- **零原生依赖打包** — 纯 JS（music-metadata、node-id3、node:sqlite、hls.js），无 better-sqlite3 等编译依赖

---

## 架构

```
┌────────────────────────────────────────────┐
│  Vue 3 + Pinia 渲染进程                     │
│    <audio>/<video> 走 ncm-audio:// 自定义协议 │
│    hls.js 播 B 站实时合流分片                 │
└───────────────────┬────────────────────────┘
                    │ IPC（contextBridge 白名单）
┌───────────────────▼────────────────────────┐
│  Electron 主进程                             │
│   ┌──────────────────────────────────────┐ │
│   │ ncmServer 子进程                       │ │
│   │  api-enhanced（ELECTRON_RUN_AS_NODE）  │ │
│   │  Named Pipe / Unix Socket             │ │
│   └──────────────────────────────────────┘ │
│   ┌──────────────────────────────────────┐ │
│   │ qqMusicServer 子进程                   │ │
│   └──────────────────────────────────────┘ │
│   ┌──────────────────────────────────────┐ │
│   │ audioCache      预缓冲 + 持久缓存      │ │
│   │ biliStream      HLS 实时合流会话管理    │ │
│   │ biliClient      WBI 签名 + 取流 + 字幕  │ │
│   │ downloadManager 断点续传 + 进度推送     │ │
│   │ ffmpeg          合流 / 转码兜底         │ │
│   └──────────────────────────────────────┘ │
│   ┌──────────────────────────────────────┐ │
│   │ SQLite (node:sqlite)                  │ │
│   │  settings/library/playlists/downloads │ │
│   │  session(加密)/api_cache/audio_cache   │ │
│   └──────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

**设计要点**：三音源服务与主进程全部走 **Named Pipe / Unix Socket**，不占用任何 TCP 端口 —— 无端口冲突、无本机抓包、无防火墙弹窗。

---

## 播放可靠性设计

| 层级 | 机制 |
|---|---|
| 磁盘预缓冲 | 起播即后台整曲下载到临时文件，播放读本地盘，网络抖动不影响播放 |
| 上游自愈 | 上游断开/停滞 >10s → 断点续传重连 ×3（退避 400ms 起），播放无感 |
| 直连兜底 | 超前 seek / M4A 尾部探测 → 独立连接直连上游，不等顺序下载追赶 |
| 渲染层恢复 | 刷新音源地址重连 ×2（第二次降级音质换 CDN 线路）；恢复流程互斥锁防死循环 |
| 转码兜底 | 解码类错误 → ffmpeg 转码 WAV 再播 |
| 下一曲预解析 | 临近结束 30s 预取音源地址，连播零空隙 |
| 持久缓存 | 完整曲自动转正，二次播放零网络 |

---

## B 站 MV 源

### 为什么需要单独实现

B 站**没有可用的公开 API 文档** —— 原 `bilibili-API-collect` 仓库已于 2026-01-28
收到律师函后永久关停（含上游 `SocialSisterYi/bilibili-API-collect`）。
本项目所有 B 站接口行为均**通过实测逆向验证**，未参考任何文档。

### WBI 签名

B 站对部分接口（搜索、playurl）要求 WBI 签名，流程：

```
GET /x/web-interface/nav  →  wbi_img.img_url / sub_url
     ↓ 各取文件名（去扩展名）拼接成 64 字符
     ↓ 按固定的 MIXIN_KEY_ENC_TAB（64 项重排表）重排
     ↓ 取前 32 字符 = mixinKey
     ↓ 参数按 key 排序 → urlencode（过滤 !'()* ）→ 拼接
     ↓ w_rid = md5(query + mixinKey)，与 wts 一同入参
```

mixinKey **每日轮换**，故每次进程启动重新拉取并缓存。

### 取流策略：durl vs DASH

B 站提供两种流，本项目按画质择优：

| 模式 | 特点 | 适用 |
|---|---|---|
| **durl** | 单文件 mp4，秒开、零 ffmpeg 开销 | 低画质（≤720P） |
| **DASH** | 音视频分离，画质档位完整（可到 4K） | 高画质 |

**关键坑**：durl 的 `accept_quality` 表**不完整**（实测只有 `[64,16]`，而 DASH 返回 `[120,112,80,64,32,16]`）。
若用 durl 的档位表做 UI，用户会看不到 1080P/4K 选项 —— **档位表必须始终取自 DASH**。

另一坑：Chromium **不能解码 HEVC**。若某档位只提供 HEVC，画面会黑屏
（`readyState=4`、`duration` 正常、无 error，但 `videoWidth=0`）。
故取流时按 `avc > av1 > hev` 排序，并仅在 HEVC 独占时提示用户。

### HLS 实时合流

**问题**：DASH 是音视频分离的，`<video>` 无法直接播，必须先合流。
全量合流要等整个视频下完才能播 —— 用户盯着「正在合并…」等几十秒到几分钟，体验割裂。

**方案**：ffmpeg 边合边切 HLS 分片，hls.js 边收边播。

```
ffmpeg -i video.m4s -i audio.m4s -c copy \
  -f hls -hls_time 2 -hls_segment_type fmp4 \
  -hls_flags independent_segments+omit_endlist+temp_file \
  index.m3u8
        ↓ 边生成边写盘
hls.js 持续重读播放列表 → 新分片一出现就加载
        ↓
首片生成即可开播（实测 1.2 秒）
```

关键参数：

| 参数 | 作用 |
|---|---|
| `-c copy` | 不重编码，只做容器封装，几乎零 CPU |
| `-hls_time 2` | 每片 2 秒（越小首帧越快，请求越频繁） |
| `-hls_list_size 0` | 保留全部分片，便于 seek 回看 |
| `omit_endlist` | **关键**：写 `#EXT-X-ENDLIST` 表示「流已结束」，hls.js 会停止轮询，边合边播就断了 |
| `temp_file` | m3u8 先写临时文件再原子改名，避免 hls.js 读到写了一半的列表 |

**画质偏好持久化**：用户选的档位存 `settings.biliQuality`，下次播放任意视频自动应用
（存**实际生效**的档位而非请求值，因为上游可能降级）。

### 三行字幕歌词

MV 页在进度条上方叠加三行：上=已播放完 / 中=正在播放（高亮+翻译）/ 下=等待播放。

**歌词来源**（并行取，择优）：

1. **B 站自带字幕（CC）** — 与视频天然同步，但很多视频没有；即使有也可能不完整
   （实测某 MV 仅 56 句，而完整歌词 100+ 句）
2. **网易云歌词** — 按视频标题自动匹配，覆盖绝大多数音乐 MV，通常最完整
3. **手动搜索** — 右下角按钮打开面板，改关键词后点结果即用

**择优规则**：两个来源并行请求，都有时取**行数更多**的（更完整）。

**标题智能清洗**：B 站音乐区标题噪声极多，需提取有效关键词：

```
【4K】皇后乐队《波西米亚狂想曲》MV  AI高清修复
  → 关键词「波西米亚狂想曲 皇后乐队」

【Hi-Res无损】《夜的第七章》- 周杰伦
  → 关键词「夜的第七章 周杰伦」
```

清洗规则：
1. 优先提取 `《》「」""` 内的歌名 —— **不能**把 `【】[]` 算进来，
   它们装的是画质标签（`【4K】【中文字幕】`），当歌名会让关键词变成 "4K"
2. 去掉所有括号内容与噪声词（画质/来源/版本）
3. `A - B` 拆分为 歌手 - 歌名
4. 歌手字段限长 24 字且不含句末标点，避免副标题污染关键词

### 底部播放条接管

MV 播放时底部播放条显示视频信息（标题/进度/音量），且**全局快捷键不再误操作后台音乐** ——
否则按空格会出现「视频暂停了、歌曲开始放了」的双响应。

音量与静音统一由 store 作为**单一来源**，视频元素通过 sink 接收（参数已是振幅，不再套曲线）。

---

## 关键实现细节

### 音量曲线

**问题**：滑块 13% 的响度明显高于网易云的 21%。

**根因**：人耳对响度的感知是**对数**的（感知响度 ∝ 20·log10(振幅)），
而线性实现直接把滑块值当振幅 —— 线性 0.5 只有 -6dB，所以「调一半感觉没小多少」。

**方案**：`ampOf(slider) = slider³`，让「滑块走一半 ≈ 感知音量减半」。

| 滑块 | 实际振幅 | 线性会是 | 倍数 |
|---|---|---|---|
| 5% | 0.000125 | 0.05 | 400× |
| 13% | 0.002197 | 0.13 | 59× |
| 50% | 0.125 | 0.5 | 4× |
| 100% | 1 | 1 | 1× |

**设计约定**：全应用状态与持久化**一律保存「滑块位置」**（0..1），
只在最后一步设置媒体元素时换算成振幅 —— 设置格式不变、UI 显示符合直觉、音视频两条链路共用同一曲线。

### 不占 TCP 端口

`bridge.cjs` 劫持 `net.Server.listen`，服务绑定 Named Pipe（Windows）/ Unix Socket（Unix）。
私有通道下 `req.ip` 未定义，bridge 伪装 `socket.remoteAddress` 为 `127.0.0.1`（服务端 realIP 依赖）。

### 快速拖动进度条不卡死

`registerSchemesAsPrivileged` 注册 `standard: true` ——
媒体栈对「标准协议」的 seek / 缓存 / 取消语义与自定义 scheme 不同，
缺 `standard` 时 media seek 可能被误判失败（`MEDIA_ERR_NETWORK` 卡死）。

### HLS 需要 `corsEnabled`

页面运行在 `file://` 下（打包版 `loadFile`），hls.js 用 fetch/XHR 加载 m3u8 与分片。
从 `file://` origin 发起的跨源请求会被 Chromium **在发出前**就以 CORS 拒绝 ——
补响应头 `Access-Control-Allow-Origin` 也没用（请求根本没到协议处理器）。

**必须**在 `registerSchemesAsPrivileged` 里加 `corsEnabled: true`。

（`<video>` 元素走媒体加载路径不受此限，所以直连 mp4 一直正常，引入 HLS 才暴露。）

### 启动速度

从 4.97s 优化到 2.08s：
- 两个服务**并行启动**（原为串行）
- 关闭 api-enhanced 启动时的 `npm info` 版本检查（联网查 registry 会卡住 listen）
- 惰性模块加载（jsdom 占 812ms / 68%，改为按需加载）

启动竞态兜底：`waitUntilReady(12000)` —— 避免「启动瞬间按播放」报 `NCM_SERVER_NOT_READY`。

---

## 开发

需要本地 **Node.js 22+**（推荐 `nvm`/`fnm`）和 **Git**。

```bash
# 1. 安装依赖
npm install

# 2. vendor 上游服务到 server/（首次必需）
npm run vendor        # api-enhanced
npm run vendor:qq     # qq-music-api

# 3. 拉取 ffmpeg（B 站合流 / 转码兜底需要）
npm run fetch:ffmpeg

# 4. 启动开发模式
npm run dev
```

`npm run dev` 会自动检测 `server/`，缺失则先执行 vendor。

### 构建

```bash
npm run build     # 编译三进程（out/）
```

> **注意**：用 `node scripts/build-app.mjs` 直接调用，比 `npm run build` 更可靠
> —— npm script 在某些环境下会静默失败。

---

## 打包

```bash
npm run pack:win       # Windows NSIS + portable
npm run pack:mac       # macOS dmg（仅 macOS 上执行）
npm run pack:dir       # 解包测试，不生成安装器

# 自签名打包（免费，本机无 SmartScreen 警告）
powershell -ExecutionPolicy Bypass -File scripts\gen-selfsigned-cert.ps1   # 首次生成证书
powershell -ExecutionPolicy Bypass -File scripts\pack-signed.ps1           # 签名打包
```

- 自签名证书存放在 `%USERPROFILE%\.ntr-certs\`（项目外，不进 git）；换机器需重新生成并导入信任
- 对外发布建议使用 Azure Trusted Signing（免费真签名，electron-builder v26 原生支持）或商业证书
- `afterPack` 钩子补全 `resources/ncm-server` 的 node_modules
  （electron-builder 的 extraResources **不复制依赖**）

---

## 目录结构

```
.
├── package.json
├── electron.vite.config.mjs
├── electron-builder.yml
├── scripts/
│   ├── vendor-server.mjs        # 克隆 api-enhanced + 装依赖 + 应用本地补丁
│   ├── vendor-qqmusic.mjs       # 同上（QQ 音乐）
│   ├── dev-server.mjs           # dev 入口（自动检查 vendor）
│   ├── build-app.mjs            # 三进程编译
│   ├── fetch-ffmpeg.mjs         # 下载 ffmpeg
│   ├── after-pack.cjs           # 打包后补全依赖
│   ├── gen-selfsigned-cert.ps1  # 生成自签名证书
│   └── pack-signed.ps1          # 自签名打包
├── resources/
│   ├── icon.png
│   └── ffmpeg/                  # fetch:ffmpeg 后生成
├── src/
│   ├── main/
│   │   ├── index.js             # 窗口 + IPC 注册 + 协议特权注册
│   │   ├── ncmServer.js         # api-enhanced 子进程管理
│   │   ├── qqMusicServer.js     # qq-music-api 子进程管理
│   │   ├── ncm/bridge.cjs       # listen() 劫持 → Named Pipe / Unix Socket
│   │   ├── audioProtocol.js     # ncm-audio:// 协议（local/stream/cover/img/hls 五通道）
│   │   ├── audioCache.js        # 预缓冲 + 持久缓存 + 断点续传
│   │   ├── biliClient.js        # B 站：WBI 签名/搜索/取流/字幕/标题清洗
│   │   ├── biliStream.js        # B 站：合流缓存 + HLS 会话管理
│   │   ├── ffmpeg.js            # 合流（全量 + HLS）/ 转码
│   │   ├── downloadManager.js   # 断点续传 + 进度推送
│   │   ├── upstream.js          # 上游请求头（按域名推断 Referer）
│   │   ├── db/                  # SQLite 仓储层（含 JSON 迁移）
│   │   └── ipc/                 # api / download / library / playlist / ncmConvert / bilibili
│   ├── preload/index.js         # contextBridge 白名单桥
│   └── renderer/src/
│       ├── App.vue / main.js / router/
│       ├── stores/              # player / library / downloads / settings
│       ├── views/               # Discover / Daily / Search / Library / Profile / MvDetail / BiliView
│       ├── components/          # PlayerBar / LyricPanel / BiliPlayer / BiliSubtitle / SongTable
│       ├── composables/         # useVolumeSlider
│       ├── api/ utils/ assets/
├── server/                      # 上游服务（vendor 后生成）
└── .github/workflows/build.yml
```

---

## 踩坑记录

开发过程中踩过的坑，按主题归类，供后续维护参考。

### B 站相关

| 坑 | 现象 | 解法 |
|---|---|---|
| durl 档位表残缺 | 画质菜单只有 2 档 | 档位表**始终取自 DASH**（`[120,112,80,64,32,16]`） |
| HEVC 黑屏 | `readyState=4`、时长正常、无 error，但 `videoWidth=0` | Chromium 不解 HEVC → 按 `avc > av1 > hev` 排序 |
| durl 403 | `upstream 403` | B 站 CDN 校验防盗链，Referer 必须是 `bilibili.com` 而非 `music.163.com` |
| HLS 请求被 CORS 拦 | `Failed to fetch`，协议处理器日志为空 | `registerSchemesAsPrivileged` 加 **`corsEnabled: true`** |
| HLS 分片 404 | 分片请求丢了目录参数 | 目录必须编码进**路径**而非 query —— 标准 URL 相对解析会**丢弃 base 的 query** |
| `init.mp4` 缺失 | m3u8 声明了 `#EXT-X-MAP` 但文件不存在 | `-hls_fmp4_init_filename` 相对名按**进程 cwd** 解析 → spawn 时设 `cwd: outDir` |
| sessionId 未回传 | 拼出 `hls/undefined/index.m3u8` | `hlsSessionStatus` 需返回 `sessionId` |
| 空格双响应 | 视频暂停、歌曲开始播 | 全局 keydown 先检查 `player.videoSession` |
| 切换画质回退旧档位 | 切 1080P 后变回 720P | 合流时**不要用 `v-if` 卸载 video**（会丢失状态与接管），改用叠加层 |

### 音频与播放

| 坑 | 现象 | 解法 |
|---|---|---|
| 快速拖动卡死 | seek 后 `MEDIA_ERR_NETWORK` | 协议注册 `standard: true` |
| 收藏红心不显示 | 已收藏却无红心 | CSS 优先级问题：`.like-btn` 在 `.like-on` 之后同权重覆盖了红色 |
| 音量条不可见 | 用 `border` 扩热区后内容高度为 0 | `box-sizing: border-box` 下改用 `::before` 伪元素扩热区 |
| 13% 比网易云 21% 还响 | 低音量段过陡 | 线性振幅 → 三次方曲线（见[音量曲线](#音量曲线)） |

### 工程与构建

| 坑 | 现象 | 解法 |
|---|---|---|
| `SetNamedSecurityInfoW failed (Win32 5)` | pwsh 全部被拦 | 运行 `diagnose-windows-sandbox-acl.ps1` 修复 ACL |
| `Get-Content`/`Set-Content` 损坏中文 | 源码中文乱码 | 改用编辑器工具（`edit`/`write`）读写源文件 |
| `node -e "..."` 嵌套模板字符串 | 语法错误 | 写成脚本文件再执行 |
| `spawn EPERM` | sandbox 下 piped stdio 被拒 | 用 `stdio: 'inherit'` |
| 打包版服务起不来 | 缺依赖 | `afterPack` 钩子补全 node_modules |

### 测试方法

**CDP 远程调试**是排查渲染层问题的有效手段：

```
NCM_DEBUG_PORT=9xxx 启动 → fetch /json/list → WebSocket → Runtime.enable
  → Runtime.evaluate 注入探针脚本
```

**重要教训**：测试脚本的**等待条件必须足够严格**。
曾因 `!querySelector('.bp-merging')`（元素"不存在"在"还没渲染"和"已消失"两种情况都为真）
导致提前退出、读到旧值，误判「切换画质不生效」。
应改用明确信号（如等 `videoWidth` 达到预期值）。

**先怀疑测试，再怀疑代码。**

---

## 许可

本项目仅供学习交流使用，**请尊重版权，勿用于商业用途**。

依赖项目许可：
- [api-enhanced][api-enhanced] — MIT
- [qq-music-api][qq-music-api] — MIT
- B 站接口行为通过实测逆向验证，**未参考任何文档**（原文档仓库已因法律原因关停）
