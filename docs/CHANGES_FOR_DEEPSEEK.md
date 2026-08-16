# 变更说明：IPC 白名单桥 + sandbox + SSRF 防护（供 DeepSeek Harness 团队参考）

> 本文件用于向自动化 agent / 外部团队说明本次安全加固的改动范围、影响与放行方式。
> 仓库内对应提交：`c1143c9`（对外编号 / 分支上的引用可能写作 `3d5beca`，内容一致）。

## 变更摘要

- **安全加固（IPC）**：`src/preload/index.js` 将 renderer→main 的 IPC 从「万能透传」改为**白名单式桥接**，并对 args 做可序列化检查（`JSON.stringify`）。仅允许显式列出的 channel，渲染进程被攻破时也无法触达白名单外的任意主进程 handler。
- **安全加固（sandbox）**：`src/main/index.js` 的 `BrowserWindow` 启用 `webPreferences.sandbox = true`，并新增 `process.on('unhandledRejection')` 日志捕获。
- **安全加固（SSRF）**：`src/main/audioProtocol.js` 改进音频代理 URL 校验，改为基于 `URL.hostname` 做主机名匹配，避免用 query/fragment 中的子串绕过（降低 SSRF / 内网探测风险）。

### 为什么要改

- 预防渲染进程被攻破后任意调用主进程 handler（读写文件、执行子进程等）；白名单 + sandbox 是 Electron 推荐的最小权限策略。
- 修补 audio proxy 的 host 校验旁路，减少 SSRF / 内网探测风险。
- 捕获未处理的 Promise 拒绝，便于排查运行时错误。

## 当前允许的 IPC channel（白名单）

### invoke 通道（renderer → main）

- 窗口控制：`win:minimize` `win:toggle-maximize` `win:close` `win:is-maximized`
- API / server：`ncm:api` `ncm:resolve-link` `ncm:server-status` `ncm:server-restart`
- ffmpeg：`ncm:ffmpeg-version` `ncm:ffmpeg-transcode`
- 文件/对话框：`ncm:save-dialog` `ncm:open-folder` `ncm:select-folder`
- 设置/缓存：`ncm:settings-get` `ncm:settings-set` `ncm:cache-stats` `ncm:cache-clear`
- 下载管理：`ncm:download-add` `ncm:download-list` `ncm:download-cancel` `ncm:download-retry` `ncm:download-remove`
- 曲库：`ncm:library-list` `ncm:library-folders` `ncm:library-add-folder` `ncm:library-scan` `ncm:library-edit` `ncm:library-remove` `ncm:library-export` `ncm:library-import`
- 歌单：`ncm:playlist-list` `ncm:playlist-save` `ncm:playlist-remove` `ncm:playlist-export-m3u` `ncm:playlist-import-m3u`
- NCM 转换：`ncm:convert-pick-file` `ncm:convert-pick-dir` `ncm:convert-batch`

### 事件通道（main → renderer，`bridge.on`）

- `win:maximized`
- `ncm:server-status`
- `ncm:library-updated`
- `ncm:convert-progress`
- `ncm:download-progress`（注：`download-done` 亦已登记，见下）

> **注意**：`ncm:download-progress` 与 `ncm:download-done` 是安全加固提交后**遗漏登记**、由后续播放修复补上的（此前曲库页订阅这两个事件会报 `ipc event not allowed`）。若你看到的版本缺这两个事件，请以最新代码为准。

## 可能的影响

- 若开发代码调用了未列入上述白名单的自定义 IPC channel，会收到错误 `ipc channel not allowed: <channel>`（invoke）或 `ipc event not allowed: <channel>`（on），相关功能被阻断。
- `sandbox: true` 会加强渲染侧隔离；若渲染端直接 `require` Node 模块或依赖非 preload 暴露的 Node 能力，这些调用会失败（这类做法本身不安全且不推荐）。
- `audioProtocol` 的 hostname 校验更严格，只有真实 hostname 命中白名单（网易系 CDN + 常见解灰源）才被信任；若测试中使用非常规 host / 重定向 / 内部 CDN，需要把这些 host 加入允许列表。

## 如何验证

1. 在 dev 环境跑一次 smoke / 手动测试：
   - `npm install`
   - `npm run vendor`（如需要）
   - `NCM_SMOKE=1 npm run dev` 或 `npm run smoke`
2. 在 UI 执行典型场景：播放、频繁拖动 seek、切歌、测试封面/图片加载。
3. 观察主进程/渲染进程日志：
   - 被白名单阻断 → `ipc channel not allowed: <channel>` / `ipc event not allowed: <channel>`。
   - audio proxy 拒绝不可信 URL → 返回 403 / 400。
4. 若发生阻断，把被拒绝的 channel 名发来，或提交 PR 把该 channel 加入白名单（见下）。

## 如何临时 / 永久放行新 channel

- **推荐流程（安全且可审计）**：提交一个小 PR 修改 `src/preload/index.js` 的 `INVOKE_ALLOWLIST` / `EVENT_ALLOWLIST`，加入需要的 channel，并在 PR 描述里说明用途与调用参数的约束。CI review 后合并。
- **临时回滚（仅在紧急情况下）**：
  - `git revert c1143c9`
  - 或手动恢复对应文件：`git checkout c1143c9^ -- src/preload/index.js src/main/index.js src/main/audioProtocol.js`
  - 注意：回退会恢复原有的安全风险，务必仅在确有必要时使用。

## 回滚 / 检查命令（复制用）

```bash
# 查看最近提交
git --no-pager log --oneline -5

# 回退本次提交（创建 revert commit）
git revert c1143c9

# 恢复单个文件到变更前版本（不推荐长期用）
git checkout c1143c9^ -- src/preload/index.js
```
