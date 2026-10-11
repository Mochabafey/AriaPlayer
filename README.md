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
  - [WBI 签名](#wbi-签名) · [durl vs DASH](#取流策略durl-vs-dash) · [HLS 实时合流](#hls-实时合流)
  - [歌词系统](#歌词系统mv-页) · [自动对轨](#歌词自动对轨) · [背景模糊](#歌词背景模糊)
  - [弹幕](#弹幕) · [双上报](#双上报观看历史--听歌打卡) · [层级](#弹幕与歌词的层级)
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
| **B 站** | 视频搜索、DASH 取流、HLS 实时合流、4K/1080P+ 画质、**弹幕**、扫码登录、歌词自动对轨 |

- **多音源聚合** — 同名歌曲自动折叠（展开切换音源）、平台 Logo 标识、歌手/专辑/MV 双源聚合；默认音源可在设置中选择
- **登录与解灰** — 网易云二维码/手机号登录、QQ 音乐扫码、**B 站扫码**；会员自动走官方音源（无损/Hi-Res），仅无版权或试听片段才解灰兜底
- **播放记录同步** — 网易云听歌打卡（30s 或 50% 阈值触发；一次播放上报一条，
  按真实收听时长计，暂停/卡顿不计；同时写「播放记录」与「听歌时长」）

### 播放

- **磁盘预缓冲** — 起播即后台整曲落盘，播放读本地，网络抖动不影响
- **音频持久缓存** — 完整下载的歌自动转正，二次播放零网络；上限 0–8GB 可调，LRU 淘汰
- **音量感知曲线** — 滑块→振幅走三次方映射，符合人耳对数感知（详见[关键实现细节](#音量曲线)）
- **播放稳定性纵深** — 断点续传自愈 + 换源重连 + ffmpeg 转码兜底，多层冗余对抗网络抖动
- **视频接管** — B 站 MV 播放时底部播放条自动接管（标题/进度/音量统一），全局快捷键不再误操作后台音乐

### 界面

- **歌词面板** — Apple Music 风格：rAF 缓动逐行高亮、翻译同步、F11 沉浸全屏、当前队列抽屉
- **B 站 MV 播放页** — 仿 B 站交互：三层进度条（已播/缓冲/悬停预览）、倍速菜单、画质菜单、网页全屏、控制条 3s 自动隐藏
- **三行字幕歌词** — MV 页三行聚焦窗口（中文在上、原文在下），双源自动择优 +
  自动对轨 + 手动微调 + 背景模糊，支持手动搜索换歌词
- **弹幕** — 滚动/顶部/底部三轨道，CSS 动画驱动（不逐帧计算）、
  安全间距防重叠、重复弹幕合并（xN）、可开关
- **下载反馈** — 完成 toast + 底部角标进度环 + 全局进度指示器；断点续传，`.part` 保留续下
- **无边框窗口** — 自绘标题栏，最小化/最大化/关闭嵌入页面

### 数据与安全

- **SQLite** — Node 内置 `node:sqlite`，零原生依赖；设置/曲库/歌单/下载任务/API 缓存/会话统一入库，含旧 JSON 自动迁移
- **本地曲库** — 文件夹扫描、元数据读取、ID3 写回（MP3）、封面墙、自建歌单、m3u/json 导入导出、NCM 批量转换
- **本地歌单** — 曲库页左侧歌单栏：新建/重命名/删除、批量加歌与移出、右键菜单、拖拽排序；
  **网易云歌单导入**（粘贴链接或 ID，存曲目快照，可离线浏览、按需下载）；
  导出 M3U / JSON / TXT
- **便携模式** — 便携版数据全部落在程序同级的 `AriaData/`，换机插上即用（见[便携模式](#便携模式)）
- **安全加固** — IPC 白名单桥 + sandbox 渲染隔离、音频代理 URL 校验（防 SSRF）、HLS 协议目录穿越防护
- **登录态加密** — cookie 经 safeStorage / AES-256-GCM 加密存盘，不进仓库

> **凭据存放位置**：所有登录态（网易云 / QQ 音乐 / B 站）经加密后存在
> `%APPDATA%/Aria Player/ncm-store/`（**项目目录之外**），`.gitignore` 已排除。
> 便携版则存在 `<exe 同级>/AriaData/ncm-store/`。
> 全历史核查确认：`SESSDATA` / `bili_jct` / `DedeUserID` / `MUSIC_U` 等
> 真实凭据值**从未进入 git 历史**（仓库中的 `MUSIC_U=xxx` 均为上游文档占位符）。
>
> 已知历史遗留：`server/data/deviceid.txt`（网易云**设备指纹池**，非账号凭据）
> 曾进入过 git 历史，现已从 HEAD 移除并加入 `.gitignore`，但历史副本仍在。
> 风险很低（随机设备 ID，与账号无关），如需彻底清理可用
> `git filter-repo --path server/data/deviceid.txt --invert-paths` 后强推。
- **零原生依赖打包** — 纯 JS（music-metadata、node-id3、node:sqlite、hls.js），无 better-sqlite3 等编译依赖

---

## 便携模式

electron-builder 的 `portable` target 是一个**自解压 NSIS 包装器**：运行时把应用解包到
`%TEMP%`，再启动真正的 exe，同时注入 `PORTABLE_EXECUTABLE_DIR`（包装器 exe 所在目录）。

**问题**：不处理这个变量的话，所有数据仍走 `app.getPath('userData')` = `%APPDATA%\Aria Player`：

- 换台电脑插上 U 盘 → 曲库/歌单/设置全空，失去「便携」意义
- 在借用的电脑上留下数据（音频缓存上限 8GB）
- **与安装版共用同一个 userData** → `requestSingleInstanceLock` 判重冲突：
  便携版启动会把安装版的窗口唤到前台，然后自己静默退出

**做法**（[src/main/portable.js](src/main/portable.js)，在 `app ready` 前调用）：

```js
const portable = setupPortableMode()   // → app.setPath('userData', <exe 同级>/AriaData)
```

配套改动：

| 项 | 处理 |
|---|---|
| 数据目录 | `userData` + `sessionData` 一起重定向，写权限自检（探测文件用完即删） |
| 目录不可写 | 只读介质 / 权限不足 → **回退系统目录**，功能不受影响，设置页展示原因 |
| 开机自启 | **禁用**。便携版 execPath 在临时解压目录，写注册表只会留下失效项并污染宿主机 |
| 下载目录 | 默认改为 `<数据目录>/Music`，而不是宿主机的「音乐」文件夹 |
| 登录态加密 | 便携模式改用 **keyfile 派生的 AES-256-GCM**（magic `PG01`），密钥随数据目录走 |

**为什么便携模式不能用 DPAPI**：`safeStorage`（Windows DPAPI）的密文绑定
**加密它的那台机器与账户**，换机后 `decryptString` 抛异常 → 会话被静默丢弃 →
每次换机都要重新扫码。便携模式改用数据目录内的随机 keyfile（`.session-key`），
密钥随 U 盘一起走。**代价是密钥与密文同盘**（能读 db 的人也能读 key），
这是「数据随身带」的固有取舍，且不影响安装版（仍优先走 safeStorage）。

> 顺带解决了单一实例锁冲突：便携版与安装版从此使用不同的 userData。

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

### 歌词系统（MV 页）

MV 页在进度条上方叠加**三行聚焦窗口**：上=已播放完 / 中=正在播放 / 下=等待播放，
整列表滚动（rAF 缓动），点击某行可 seek 到该句。

**排列与视觉层级**（字幕组惯例）：**中文在上（主视线）、原文在下（对照）**。
中文 19.7px / 纯白 / 700；原文 19.3px / 0.82 透明度 / 600。

**歌词来源**（三路，可切换）：

1. **B 站自带字幕（CC）** — 与视频天然同步，但很多视频没有
2. **网易云歌词** — 按视频标题自动匹配，通常最完整（含翻译）
3. **手动搜索** — 播放器下方常驻面板，改关键词后点结果即用

`auto` 模式下按**可靠性**择优：网易云需同时满足「行数 ≥ 20、置信度 ≥ 1、
时长差 ≤ 15s」，否则回退 CC 字幕 —— 因为网易云可能只有翻唱/片段版
（实测周杰伦《晴天》MV：网易云候选全是翻唱，时长差 205s、歌词仅 16 行）。

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
2. 去掉所有括号内容与噪声词（画质/来源/版本，含 `2160P/1440P/2K`）
3. `A - B` 拆分为 歌手 - 歌名
4. 歌手字段限长 24 字且不含句末标点，避免副标题污染关键词

### 歌词自动对轨

**问题**：LRC 时间戳相对**歌曲**，而播放时间相对**视频**。MV 常带额外前奏/尾奏
（实测某 MV 317s vs 原曲 269s，差 48s），直接套用必然错位。

**方案**：用 B 站 CC 字幕（与视频天然同步）作基准，与歌词做文本匹配求偏移：

```
offset = CC时间 - 歌词时间     （取多句的中位数）
```

抗离群处理（歌词常有重复段落，匹配会错位 ±180s）：
- 只取相似度 ≥ 0.6 的匹配（最长公共子串 / 较长串长度）
- 取**中位数**而非平均值
- 迭代收紧：剔除偏离中位数 >3s 的样本后重算，最多 3 轮
- 置信度 = 落在中位数 ±1.5s 内的样本比例

实测：35 句匹配成功，中位数偏移 12.7s。控制条上有 `[− +0s +]` 可手动微调 ±2s。

### 歌词背景模糊

歌词块背后一层高斯模糊（`backdrop-filter: blur(10px) saturate(1.15)` +
轻微压暗 + 四边羽化），画面花哨时显著提升可读性。

**关键**：模糊层与歌词块**同尺寸同位置**（`inset: 0` 铺满由内容决定尺寸的
`.bs-inner`），故自动跟随字号缩放、控制条下沉、窗口大小变化。

### 弹幕

参照 B 站网页播放器行为，**三轨道**：滚动（mode 1/2/3/6）、顶部（5）、底部（4）。

**渲染方案**：CSS 动画驱动，JS 不参与逐帧计算。

- 弹幕只在**进入时间窗时挂载一次**，之后不再修改其动画样式
  → CSS 动画连续跑完，不重置（早期版本每次 timeupdate 重建 DOM，
    导致动画每 250ms 重置一次，表现为「一跳一跳」）
- 用 Map/Set 做增量增删 + `v-memo` 双保险
- 窗口裁剪：按时间二分查找，只渲染 `[t-10, t+10]` 内的（实测 76~127 条）
- 暂停时 `animation-play-state: paused` 冻结

**轨道分配**（参考 [NipaPlay-Reload](https://github.com/AimesSoft/NipaPlay-Reload)）：

```
nextAvailable = time + D × (W + margin) / (S + W)
```

`D`=滚动总时长，`W`=文本宽度，`margin`=安全间距（屏宽 3%），`S`=容器宽度。
含义是「本条的尾部完全离开右边缘并留出安全间距」所需的时间 ——
比「完全进入屏幕」更保守，避免相邻两条挨得过近。

**弹幕合并**：短时间内内容相同的弹幕合并为「内容 xN」（参考 NipaPlay 的
`countText` 设计）。刷屏弹幕不再占满轨道，实测弹幕数 151 → 127。

**数据来源**：`/x/v1/dm/list.so?oid=<cid>` 返回 **deflate 压缩的 XML**，
需拿原始 buffer 解压（转成 utf-8 字符串会损坏二进制）。模式 7（高级代码弹幕）跳过。

### 双上报（观看历史 + 听歌打卡）

MV 播放同时上报两个平台，**共用同一套门槛**（对齐官方行为，避免刷量）：

```
首次：有效播放 ≥ 30s，或 ≥ 总时长 50%
之后：每 ≥ 20s 一次心跳，且播放位置确实前进 ≥ 5s
```

- **B 站**：`/x/click-interface/web/heartbeat`（网页播放器同款），
  播完调 `reportFinished` 把进度打满
- **网易云**：`scrobble/v1`，**仅当歌词用的是网易云曲目时**上报
  （用 CC 字幕时无对应歌曲，跳过）

时长按**真实时间**累加（暂停不计、卡顿不计），而非音频位置差 ——
否则拖动 seek 或倍速播放会把时长算错。

#### 歌曲播放的听歌打卡：一次播放只发一条

网易云的语义是「**一次播放片段 = 一条日志**」（参考实现
`netease-report-listen-song` 的 `pld.ts`：`logtime = startTime + played * 1000`、
`time = played`）。用户实测确认的官方行为：

- 听一半就切走 → **也计入**（按实际播放时长）
- 同一首歌反复听 → **每遍都累加**（服务端按事件的 `time` 累加）

所以正确做法是「播放结束时上报一条，`time` = 本次真实播放秒数」，
而**不是**播放中周期性上报递增的累计值 —— 后者在累加模型下会重复计入：

```
听 300 秒的歌，若上报 30/90/150/210/270/300
→ 服务端累加 = 1050 秒（虚增 3.5 倍）
```

实现上：`maybeScrobble` 只做纯计算（在 `timeupdate` 里高频调用，不发请求），
真正的上报在切歌 / 播完时由 `flushScrobble` 发一次。

##### ⚠️ 两个会虚增时长的坑（都实测踩过）

**坑 1：`ended` 不能无条件报整曲时长**

`ended` 事件**不代表真的听完了** —— 流被截断、seek 到结尾、音频元数据
时长有误，都会触发它。原实现 `finished ? total : ...` 无条件取整曲：

```
只听 15 秒 → ended → 上报 210 秒   ❌ 虚增 14 倍
```

修复：加完整度校验 `FINISH_TOLERANCE = 0.9` —— 只有实际累计播放
≥ 曲长 × 0.9 才按整曲报（吸收卡顿导致的少算），否则按实际播放时长报。

**坑 2：两个接口都带 `time` 会双重计入**

`server/module/scrobble.js` 的 `play` 日志里**也有 `time` 字段**：

```js
{ action: 'play', json: { ..., time: query.time, ... } }
```

所以两个接口都传 `time` 很可能被服务端计入两次。修复：只让
`scrobble/v1` 带 `time`，`scrobble` 不传（它只负责写「最近播放」）。

**实测症状**：用户用秒表计时 10 分 27 秒，网易云「听歌时长」涨了 36 分钟，
而歌曲数只增加 3 首 —— 涨幅是实际的 3 倍以上。以上两坑叠加所致。

两个接口都发（实测两者都会写记录）：

| 接口 | 作用 | 是否带 time |
|---|---|---|
| `scrobble` | weblog `startplay` + `play`，写播放记录 | ❌ 不传（避免双重计入） |
| `scrobble/v1` | NCBL 加密日志（PLV + PLD），写听歌时长 | ✅ 传（唯一负责时长） |

> **服务端缓存坑**：`server.js` 对所有 200 响应挂了 `cache('2 minutes')`，
> 查「今日收听 / 时长统计」若不绕过会命中旧快照，表现为
> 「刚听完的歌查不到，过一会儿又出现了」。故 `listen_data` 已加入
> `src/main/ipc/api.js` 的 `FORCE_FETCH_RE` 白名单（带
> `x-apicache-force-fetch` 头强制实时）。

### 底部播放条接管

MV 播放时底部播放条显示视频信息（标题/进度/音量），且**全局快捷键不再误操作后台音乐** ——
否则按空格会出现「视频暂停了、歌曲开始放了」的双响应。

音量与静音统一由 store 作为**单一来源**，视频元素通过 sink 接收（参数已是振幅，不再套曲线）。

### 弹幕与歌词的层级

播放器内各层的 z-index 需明确指定 —— 歌词有 z-index 时会盖住没有 z-index 的交互元素
（实测画质菜单被歌词遮挡，只能看到最下面一两项）：

```
bp-error        7   错误提示（最高）
bp-merging      6   合流进度层
bp-controls     5   控制条（含画质/倍速菜单）
bp-center-play  5   中央播放按钮
bp-top          5   顶部标题
bp-sres         5   搜索结果
──────────────────
bs-wrap         4   歌词
dm-wrap         3   弹幕
bs-list         2   歌词文本
bs-blur         1   歌词模糊底
```


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

### 歌单的两种形态

`playlists` 表用 `source` 区分，因为它们的数据结构本质不同：

| source | songIds | tracks | 说明 |
|---|---|---|---|
| `local` | 引用曲库 id | NULL | 本地歌单。曲库删歌后引用悬空，读取时按曲库现状过滤（不级联清理 —— 重新加回同一文件即复原） |
| `m3u` | 引用曲库 id | NULL | m3u 导入，只收录曲库已有的文件 |
| `netease` | `[]` | 曲目快照 | 网易云导入。歌通常不在本地磁盘，无法用 id 引用 → 存完整快照，播放走在线音源 |

**快照不同步上游是刻意的**：用户「导入」即拿走一份副本，不应因上游改歌单而丢失。
渲染时若曲库里恰好有同 id 的下载歌曲，会**优先本地播放**（`resolvePlaylistSongs` 补 `filePath`），
省一次音源解析与网络请求。

### 歌单导入导出的纯函数拆分

导出的「内容生成」与「弹对话框 + 写文件」是两件事，导入的「解析」与「弹选择框」也是。
原先它们内联在 IPC handler 里，导致**内容逻辑无法被测试** —— 每次都要先弹一个
`dialog.showSaveDialog`，无人值守环境下根本走不到那一步（只能靠复刻算法来"验证"，
而那验证的不是真实代码）。

拆成两个零依赖模块后，普通 Node 即可单测真实实现：

| 模块 | 职责 | 测试 |
|---|---|---|
| [src/main/playlistExport.js](src/main/playlistExport.js) | 生成 m3u/json/txt 内容、文件名安全化 | `playlistExport.test.mjs`（26 项） |
| [src/main/playlistImport.js](src/main/playlistImport.js) | 解析 m3u/m3u8/json 为路径列表 | `playlistImport.test.mjs`（33 项） |

```
npm run test:playlist    # 59 项
```

> **拆出来才发现的一个真实缺陷**：M3U 是跨平台文本格式，foobar2000 / Winamp /
> MusicBee 导出的 Windows 播放列表**普遍用正斜杠** `D:/Music/a.mp3`，而曲库存的是
> `path.join` 的 `D:\Music\a.mp3`。查库是精确字符串匹配，两者不等 →
> 明明文件在曲库里，导入却全部算 missing（用户看到「导入 0 首，跳过 50 首」）。
>
> 坑点在于 `path.isAbsolute('D:/x') === true`，所以只判 isAbsolute 发现不了。
> 修复：解析层用 `path.normalize` 规范化；并在**仓储层**（libraryRepo 的
> hasFile/getByFile/insertSong）也统一规范化，这样无论调用方怎么写路径都对齐。

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

优化历程（冷启动，实测）：

| 阶段 | 首屏可交互 | 措施 |
|---|---|---|
| 初版 | 4.97s | — |
| 第一轮 | 2.08s | 两服务并行启动 / 关闭 `npm info` 版本检查 / 惰性模块加载（jsdom 占 812ms） |
| 第二轮 | **0.7s** | QQ 音乐改**懒启动**（见下） |
| 第三轮 | 0.7s | QQ 音乐 **esbuild 预编译**（首次用 QQ 音源 4.9s → 0.33s） |
| 第四轮 | 0.7s | 就绪判定改**事件驱动**（服务就绪提前 ~200ms） |

**QQ 音乐**是两轮优化的主角。实测各服务冷启动：

| 服务 | 耗时 | 原因 |
|---|---|---|
| 网易云（api-enhanced） | 0.6s | 纯 JS |
| QQ 音乐（qq-music-api） | **4.9s** | 用 `ts-node` 实时编译 92 个 TS 文件 |

它还会**拖慢其他一切** —— 对照实验（同一台机器）：

```
只启动网易云:              636ms
两个并行:                  638ms
QQ 先启动、网易云后启动:   6537ms   ← 慢 10 倍（抢 CPU/磁盘）
```

**两项措施**：

1. **懒启动** —— QQ 是可选音源，多数用户开机只用网易云。改为首次真正用到才启动
   （`ipc/qqmusic.js` 的 `requireReadyServer()` 收口）。首屏不再受它影响。
   - `QqMusicServer` 初始状态是 **`idle`**（不是 `down`）——「还没启动」是
     正常状态，用 `down` 会让前端显示成错误态
   - 常用 QQ 音源的用户可在设置里开启「启动时预加载 QQ 音乐」

2. **esbuild 预编译** —— `scripts/build-qqmusic.mjs` 把 TS 编成单个 92 KB 的 CJS。
   `bridge.cjs` 优先用预编译产物，缺失时回退 ts-node（慢但能跑）。
   - 产物输出到 `qqmusic/dist/` 是**刻意的**：源码里
     `path.join(__dirname, '../public')` 在 `dist/` 下语义自动一致，无需 hack
   - `vendor-qqmusic.mjs` 末尾自动预编译；CI 有独立步骤校验产物存在，
     避免静默降级到慢速路径

3. **就绪判定事件驱动** —— 子进程在 `listen` 回调里打 `###NTR_READY###` 标记，
   主进程从 stdout 识别即置 ready，取代原先「每 300ms 连一次 socket 探测」：

   ```
   轮询: 平均 622ms（首次探测在 300ms 处发起，信号 ~420ms 到达时正好错过窗口）
   事件: 平均 428ms
   ```

   保留 500ms 兜底轮询（纯靠事件会在信号丢失时卡死启动）。
   用 stdout 而非 `process.send`：spawn 的 stdio 不含 `'ipc'` 时后者是 undefined。

启动竞态兜底：`waitUntilReady(12000)` —— 避免「启动瞬间按播放」报 `NCM_SERVER_NOT_READY`。

### 托盘与开机自启

三个**互相独立**的开关（布局参照 VRCX）：

| 开关 | 控制什么 | 默认 |
|---|---|---|
| 开机自启动 | 登录系统后自动启动 | 关 |
| **以最小化的形式启动** | **启动那一刻**窗口是否显示（手动启动也生效） | 关 |
| 最小化到系统托盘 | **点关闭按钮时**是否驻留后台 | 关 |

后两者语义不同，**不可互相依赖** —— 早期实现错误地把「最小化启动」写成
`isStartMinimized() && trayEnabled()`，导致只开前者时完全不生效且看不出原因。

**实现要点**：

- **托盘创建时机**：托盘模式开启 **或** 本次要最小化启动。
  否则窗口藏起来后用户**没有任何入口唤回**。
- **跳过超时兜底**：原有「5 秒后强制显示窗口」会破坏最小化启动
  （用户选了静默驻留，5 秒后窗口自己弹出来）。
- **`close` 事件**必须用 `isQuitting()` 区分「用户点关闭」与「真退出」，否则退不掉；
  `window-all-closed` 在托盘模式下也不能退出。

#### ⚠️ 托盘图标必须显式加进 extraResources（实测踩过）

`directories.buildResources: resources` 里的 `icon.png` **只用于生成 exe 图标**，
**不会**被复制进 `resources/` 目录。而托盘图标是运行时从
`process.resourcesPath` 读的 —— 漏了配置就会拿到空 `nativeImage`，
**托盘区看不到图标也点不到**。

配合「以最小化的形式启动」（窗口启动即隐藏），用户会**完全找不到程序入口**，
以为程序没启动。所以：

```yaml
extraResources:
  - from: resources/icon.png
    to: icon.png
```

同时 `tray.js` 做了**运行时兜底**：找不到图片时按 PNG 规范生成一个
16×16 的品牌色圆形图标（`IHDR + IDAT(zlib) + IEND`，CRC32 自算），
并打印 warning 提示检查配置 —— 不再静默失败。

> 注：最初本娘内联了一段 base64 PNG 作兜底，但实测它**结构不完整**
> （`nativeImage.createFromBuffer` 拒绝、图片查看器报 malformed）。
> 手写 base64 极易出错且难校验，改为运行时编码。

#### 开机自启的两个坑（都实测踩过）

**① `getLoginItemSettings()` 必须传与写入时相同的 `args`**

官方文档：

> If you provided `path` and `args` options to `app.setLoginItemSettings`,
> then you need to pass the same arguments here for `openAtLogin` to be set correctly.

本项目写入时带 `args: ['--start-minimized']`，读取时若用默认（空数组）就匹配不上：

    getLoginItemSettings({args:['--start-minimized']}).openAtLogin  → true   ✅
    getLoginItemSettings().openAtLogin                             → false  ❌

→ 读取时把两种 args 组合都试一遍。

**② 注册表兜底必须校验「项属于本进程」**

`app.getName()` 在开发模式（`electron .`）下取的是 package.json 的
**productName**，不是 `"Electron"` —— 所以**开发版与安装版共用同一个注册表项名**。

若兜底只判断「项是否存在」，开发版会**把安装版的自启项误认成自己的**
（表现为「关掉自启仍显示已开启」）。必须同时校验项里的 exe 路径等于
本进程的 `process.execPath`。

> 排查用环境变量：`NTR_DEBUG_AUTOLAUNCH=1` 会打印命中了哪一级判据。

> **踩坑**：新增的 IPC 通道必须同时加进 `src/preload/index.js` 的
> `INVOKE_ALLOWLIST` / `EVENT_ALLOWLIST`，否则调用被拒且**返回 undefined
> 而非报错**，很容易误判成「逻辑没生效」。

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

### 测试

```bash
npm test              # 单元测试：歌单导入导出 + 标签写回（85 项）
npm run test:playlist # 歌单导出内容生成 + 歌单文件解析（59 项）
npm run test:tags     # ID3/FLAC/M4A 标签写回

# 集成测试（需 app 已运行 + 调试端口）
NCM_DEBUG_PORT=9333 npm run dev        # 终端 A
npm run test:integration               # 终端 B
```

纯函数模块（`playlistExport.js` / `playlistImport.js`）零依赖，普通 Node 直接跑，
不需要 Electron —— 这也是把它们从 IPC handler 里拆出来的原因。

集成测试（`tests/playlist-integration.mjs`）补单测够不着的那部分：
**IPC handler 是否正确透传参数**。它用 ffmpeg 生成真实音频跑完整生命周期，
结束后自行清理，可反复运行。这个脚本已经抓到过一个真实缺陷 ——
`ncm:playlist-save` 曾经只解构 `{ id, name, songIds }`，把调用方传的
`source`/`tracks` 静默丢掉（不报错），快照歌单因此被当成本地歌单。

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

### 三平台自动构建（GitHub Actions）

`.github/workflows/build.yml` 在 Windows / macOS / Linux 三个 runner 上并行构建。

**触发方式**：

| 你的操作 | 行为 | 耗时 |
|---|---|---|
| push / PR 到 master | 只跑 `npm ci` + 编译三进程 → **验证代码能编译** | 约 1-2 分钟 |
| 命令行 `git push origin v0.4.0` | 完整打包三平台 + 创建 Release | 约 6 分钟 |
| **网页 Releases 页建 Release** | 同上（自动建 tag） | 约 6 分钟 |
| **网页 Tags 页单独建 tag** | 同上 | 约 6 分钟 |
| Actions 页面手动触发 | 打包并上传 artifact（不发 Release） | 约 6 分钟 |

> **为什么监听三个事件**：GitHub 网页界面创建 tag 时**不会触发 `push` 事件**
> （官方行为）。只监听 `push.tags` 的话，在网页上打 tag 会「什么都没发生」。
> 故额外监听 `release`（建 Release）与 `create`（单独建 tag）。
> `create` 事件对「新建分支」也会触发，已用 `github.ref_type == 'tag'` 过滤。

**为什么普通 push 不打包**：完整打包三平台约 18 分钟 runner 时间
（3 job × 6 min），私有仓库免费额度 2000 分钟/月 —— 每次 push 都打包
约 110 次就烧完。日常只需知道「能否编译」，出包走 tag 或手动触发。

**发版流程**：

```bash
# 1. 改 package.json 的 version（必须与 tag 一致，CI 会校验）
# 2. 提交并推送
git add -A && git commit -m "chore: release v0.4.0"
git push

# 3. 打 tag → 自动构建三平台 + 发布 Release
git tag v0.4.0
git push origin v0.4.0
```

也可以在网页上操作：**Releases → Draft a new release → 填 tag 名（如 `v0.4.0`）
→ Publish release**，CI 会自动构建并把三平台产物挂上去。

CI 会校验 `tag` 与 `package.json` 的 `version` 一致（不一致直接失败，
避免产物文件名与 tag 对不上）。

**CI 上必须现场准备的依赖**（本地已有、但被 `.gitignore` 排除）：

| 依赖 | 原因 |
|---|---|
| `qqmusic/` | 22000+ 文件，不入库 → CI 跑 `vendor-qqmusic.mjs` 现场克隆 |
| `resources/ffmpeg/` | 平台相关二进制 → CI 跑 `fetch-ffmpeg.mjs` 按平台下载 |
| `server/` | **已入库**，但 CI 仍跑 `vendor-server.mjs` 以应用本地补丁 |

**ffmpeg 数据源按平台区分**（踩过坑）：

```
Windows / Linux → BtbN/FFmpeg-Builds（zip / tar.xz）
macOS           → eugeneware/ffmpeg-static（裸可执行文件）
```

BtbN **只发布 Windows 与 Linux**，没有 macOS 构建
（`ffmpeg-master-latest-macos64-gpl.zip` 返回 404）。

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
│   │   ├── portable.js          # 便携模式：userData 重定向（app ready 前调用）
│   │   ├── playlistExport.js    # 歌单导出内容生成（纯函数，可单测）
│   │   ├── playlistImport.js    # 歌单文件解析（纯函数，可单测）
│   │   ├── ncmServer.js         # api-enhanced 子进程管理
│   │   ├── qqMusicServer.js     # qq-music-api 子进程管理
│   │   ├── ncm/bridge.cjs       # listen() 劫持 → Named Pipe / Unix Socket
│   │   ├── audioProtocol.js     # ncm-audio:// 协议（local/stream/cover/img/hls 五通道）
│   │   ├── audioCache.js        # 预缓冲 + 持久缓存 + 断点续传
│   │   ├── biliClient.js        # B 站：WBI 签名/搜索/取流/字幕/弹幕/标题清洗/观看上报
│   │   ├── biliStream.js        # B 站：合流缓存 + HLS 会话管理
│   │   ├── ffmpeg.js            # 合流（全量 + HLS）/ 转码
│   │   ├── downloadManager.js   # 断点续传 + 进度推送
│   │   ├── upstream.js          # 上游请求头（按域名推断 Referer）
│   │   ├── db/                  # SQLite 仓储层（含 JSON 迁移）
│   │   └── ipc/                 # api / download / library / playlist / ncmConvert / bilibili
│   ├── preload/index.js         # contextBridge 白名单桥
│   └── renderer/src/
│       ├── App.vue / main.js / router/
│       ├── stores/              # player / library / playlist / downloads / settings
│       ├── views/               # Discover / Daily / Search / Library / Profile / MvDetail / BiliView
│       ├── components/          # PlayerBar / LyricPanel / BiliPlayer / BiliSubtitle / BiliDanmaku / SongTable / ContextMenu / PromptModal
│       ├── composables/         # useVolumeSlider
│       ├── api/ utils/ assets/  # utils: lrc(解析/中英拆分) / lrcSync(自动对轨) / volume(音量曲线) / scrobble(双上报)
├── server/                      # 上游服务（vendor 后生成）
├── tests/
│   └── playlist-integration.mjs # 歌单集成测试（需 app 运行 + 调试端口）
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
| 高画质合流卡在 90% | ffmpeg 连不上 CDN 又不报错退出 | 流地址含 **PCDN 节点**（域名带 `mcdn`、端口 8082），实测连接被重置（`-138`）；`backup_url[]` 此前只采集未使用 → 加**备用地址自动切换** + 把 PCDN 排到最后（首次 34.7s → 1.9s） |
| 弹幕接口拿到乱码 | XML 解析失败 | `/x/v1/dm/list.so` 返回 **deflate 压缩的 XML**；`toString('utf-8')` 会损坏二进制 → `biliRequest` 回传 `buffer`，依次尝试 `inflateRaw/inflate/gunzip` |
| 歌词与画面错位 | 00:34 显示开头的歌词 | LRC 时间戳相对**歌曲**、播放时间相对**视频**，MV 有额外前奏 → 用 CC 字幕作基准做**文本匹配求偏移**（中位数 + 迭代收紧抗离群） |
| 标题清洗搜出无关歌 | 关键词变成「周杰伦 晴天 2160P 版」 | 噪声词表漏了 `2160P/1440P/2K`；且**不能**把 `【】` 当歌名容器（那是画质标签） |
| 网易云匹配到翻唱 | 歌词时间轴对不上 | 网易云可能无原唱版权（实测《晴天》候选全是翻唱，时长差 205s）→ 加**时长维度**评分 + 可靠性判定，不可靠时**回退 CC 字幕** |
| 歌词中英挤在一行 | 原文与翻译同行显示 | **B 站 CC 字幕本身把原文+翻译塞在同一条文本里**（非样式问题）→ 按首个中日韩字符拆分 |
| 手动选的歌词被覆盖 | 切一次画质就变回自动匹配 | url watch 无条件重载 → 加 `subManual` 锁定，换视频才清除 |
| 画质菜单被歌词遮挡 | 只能看到菜单最下面一两项 | 有 `z-index` 的元素会盖住 `auto` 的（**与 DOM 顺序无关**）→ 交互层显式指定层级 |
| 弹幕一跳一跳 | 每 250ms 跳回起点 | 每次 `timeupdate` 重建 DOM 并重设 `animationDelay` → 改为**一次性挂载**、之后不动动画样式（+ `v-memo` 双保险） |
| 弹幕刚出现就消失 | 追踪显示只显示 0.2 秒 | 卸载窗口按「弹幕出现时间」滞后 1s，但滚动要 9s → `LAG = SCROLL_SEC + 1` |

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
| **`git checkout -b` 权限被拒** | `cannot lock ref ... Permission denied` | 两层原因：① `.git`、`.git/refs`、`.git/refs/heads` 三级缺当前用户的完全控制权限 → 用 `diagnose-windows-sandbox-acl.ps1` 修复；② **修完仍被拒**（根目录可写、所有子目录被拒，而编辑器工具却能写）→ 是沙箱进程令牌限制，需提权执行 |
| **ESM 裸跑 Electron 主进程** | `does not provide an export named 'app'` | Electron 内置模块只有 CJS 导出，源码是 ESM；必须经 electron-vite 打成 CJS 才能跑。验证主进程逻辑请直接跑构建产物 |
| **验证便携模式时主进程崩溃** | `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')` | 环境里继承了 `ELECTRON_RUN_AS_NODE=1`（DSH 自身是 Electron 应用，注入给了子进程）→ Electron 以纯 Node 模式运行，`require('electron')` 只返回路径字符串。测试脚本须 `delete env.ELECTRON_RUN_AS_NODE`（`dev-server.mjs` 同样在防这个坑） |
| **开发版与安装版抢单一实例锁** | 开发版启动后立刻退出，安装版窗口被唤到前台 | 两者 `app.getName()` 都是 productName「Aria Player」→ 共用 `%APPDATA%\Aria Player`。排查时给开发版加 `--user-data-dir=<独立目录>` |
| **正斜杠路径查库不命中** | 导入 M3U 显示「0 首，跳过 50 首」，但文件确实在曲库 | M3U 跨平台惯例用正斜杠（`D:/Music/a.mp3`），曲库存的是 `path.join` 的反斜杠形式，精确匹配失败。`path.isAbsolute('D:/x')` 为 **true**，所以只判 isAbsolute 发现不了 → 必须 `path.normalize`；仓储层读写两侧都规范化 |
| **构建产物跑不起来内置服务** | 直接跑 `dist/out/main/index.js` 报 `app.js not found at dist/out/main/server/app.js` | 打包路径布局（`process.resourcesPath`）只在 electron-builder 产物里存在。要在源码目录跑就用 `npm run dev`，别直接跑构建产物 |
| **IPC handler 静默丢字段** | 传了 `source:'netease'` 却存成 `'local'`，快照曲目全丢，**且不报错** | handler 里解构参数时漏了字段（`{ id, name, songIds }` 丢了 tracks/cover/description/source/sourceId），仓储层支持也没用。加字段时要同步改 handler；这类缺陷单测够不着，靠 `npm run test:integration` 兜住 |

| **weapi 接口全部 502** | 每日推荐/我的歌单/推荐歌单等页面全空，而搜索/播放正常 | `weapi` 走 `music.163.com`，该域名在部分网络下解析到**不可达 IP**（IPv6 + 某 IPv4 均 ECONNRESET），而 `interface.music.163.com` 正常。实测 `/weapi/` 路径在 `interface*.music.163.com` 上完全可用 → 在 `request.js` 请求层加**域名自动回退**（仅网络错误时重试 + 5 分钟熔断）。影响 217 个接口 |
| **打包版服务起不来（CI 构建）** | 界面显示「服务未就绪」，「我的」页卡在加载中 | `vendor-server.mjs` 旧判据「有 `app.js` 就 `process.exit(0)`」在 CI 上误跳过依赖安装（`server/node_modules` 被 gitignore 排除）→ 判据改为**「有源码**且**关键依赖齐全」**，并移除顶层 exit 以免连本地补丁一起跳过 |
| **正则匹配转换前形式** | 「刚听完查不到记录，过一会又出现」 | `method.replace(/_/g,'/')` 之后才做 `FORCE_FETCH_RE.test(route)`，而正则写的是下划线形式 → 7 个实时接口的强制刷新**从未生效**。正则改用 `[/_]` 兼容两种形式 |
| 打包版服务起不来（本地） | 缺依赖 | `afterPack` 钩子补全 node_modules |
| **构建产物累积** | 代码改了但行为不变、日志不输出 | Vite 每次产出带 hash 的新文件但**不清旧文件**；残留 44 个 `BiliView-*.js` 时 Electron 可能加载旧产物 → **先清 `dist/out/renderer` 再查代码** |
| **Vite 生产构建 drop `console.log`** | 调试日志完全不输出（`.vue` 里的却保留），误判「代码没执行」 | 调试改用 `console.warn` |
| **CSS 百分比位移 ≠ 容器宽度** | 弹幕滚动距离错误 | `translateX(100%)` 是相对**元素自身宽度**；需要「容器右边缘外→左边缘外」时必须由 JS 算像素值 |
| **flex 子项被 stretch 拉伸** | `width: fit-content` 失效，模糊层比内容宽 247px | 父级 flex 容器下子项默认 `align-items: stretch`，需显式 `flex: 0 0 auto` |
| **宽度循环依赖** | 父 `fit-content` + 子 `width: 100%` → 浏览器按 auto 处理 | 子元素改用明确单位（如 `86cqw`） |
| **z-index 盖住无 z-index 元素** | 画质菜单被歌词遮挡 | 有 `z-index` 的元素会盖住 `auto` 的（**与 DOM 顺序无关**）；交互层需显式层级 |

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

其他踩过的测试坑（**都是测试脚本的问题，代码本身正常**）：

| 误判 | 真因 |
|---|---|
| 切换画质不生效 | 等待条件在「未渲染」时也为真 |
| 视频接管振幅不对 | 引用了路由切换后失效的 DOM 节点 |
| 搜索无结果 / 未居中 | `input.value=` 不触发 Vue v-model（需原生 setter）；`0 \|\| 99` 逻辑错 |
| 控制条不隐藏 | `window.dispatchEvent` 事件目标不对（Vue 监听绑在具体元素上） |
| 源切换无效 | 直接改 settings 未触发组件 watch（改用 UI 按钮即正常） |
| 上报未触发 | 用 `playbackRate=4` 加速测试，但时长按**真实时间**累加，永远到不了门槛 |
| 弹幕一跳一跳（误判为渲染问题） | 实为构建产物残留（见上表） |

**先怀疑测试，再怀疑代码。**

**测量动画连续性**：不要按文本查找元素（会误匹配），应**直接持元素引用**
（`document.body.contains(el)` + `getComputedStyle(el).transform` 取 `m41`），
逐帧采样看是否单调推进。

---

## 许可

本项目仅供学习交流使用，**请尊重版权，勿用于商业用途**。

依赖项目许可：
- [api-enhanced][api-enhanced] — MIT
- [qq-music-api][qq-music-api] — MIT
- B 站接口行为通过实测逆向验证，**未参考任何文档**（原文档仓库已因法律原因关停）
- 弹幕轨道分配算法参考 [NipaPlay-Reload](https://github.com/AimesSoft/NipaPlay-Reload)（Flutter 弹幕播放器）
