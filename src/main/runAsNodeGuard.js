/**
 * ELECTRON_RUN_AS_NODE 自愈守卫（**开发模式专用**）。
 *
 * ## 先说结论：打包版修不了，也不需要修
 *
 * 实测确认：**打包版带着 `ELECTRON_RUN_AS_NODE=1` 启动时，app.asar 里的
 * 任何 JS 都不会被执行**。原因是 Electron 退化为纯 node，argv[1] 为空
 * → 进入 REPL → 无 TTY → 立即退出（实测退出码 0、零输出）。
 *
 * 也就是说：**要修的代码本身跑不起来**，把守卫写在主进程里没有执行机会。
 * 唯一的修法是在 NSIS 包装器层清除变量，但那需要自定义 NSIS 脚本。
 *
 * 不过——**这个变量不是持久化的系统环境变量**（实测 User/Machine 级
 * 注册表均为空），它只由「以 Electron 为宿主的父进程」注入给子进程。
 * 普通用户从资源管理器双击 exe **不会**遇到它。
 *
 * 因此本守卫的定位是：**改善开发/自动化场景的体验** ——
 * 当从 DSH、VS Code 终端这类环境启动时自动恢复正常，不必依赖每个
 * 启动脚本各自记得 `delete process.env.ELECTRON_RUN_AS_NODE`
 *（dev-server.mjs / build-app.mjs / smoke-server.mjs 此前都在各自处理）。
 *
 * ## 为什么必须是独立模块且第一个 import
 *
 * ESM 的 import 会被提升，但**求值顺序仍按出现顺序**（深度优先）。
 * 若写成 index.js 顶部的普通语句，会晚于 `import ... from './db/index.js'`
 * 的求值 —— 而那条链路里的 settings.js 在**模块作用域**就调用了
 * `app.getPath('music')`，此时 Electron 已退化，会先崩。
 *
 * ## 为什么用 spawnSync 而不是 spawn
 *
 * 便携包装器用 `ExecWait` 启动我们，**等父进程退出后**才 `RMDir /r` 删除
 * `%TEMP%` 里的解压目录。若父进程 spawn 完就退出，包装器会把仍在运行的
 * 程序文件删掉。故必须同步等待子进程结束，再透传退出码。
 *
 * 死循环防护：子进程里该变量已删除，不会再进本分支；另有 NTR_RESPAWNED
 * 标记兜底。
 */
import { spawnSync } from 'child_process'

if (process.env.ELECTRON_RUN_AS_NODE && !process.env.NTR_RESPAWNED) {
  console.log('[guard] 检测到 ELECTRON_RUN_AS_NODE（Electron 会退化为纯 Node 模式）')
  console.log('[guard] 以干净环境重新拉起自身…')

  const env = { ...process.env, NTR_RESPAWNED: '1' }
  delete env.ELECTRON_RUN_AS_NODE

  // spawnSync：必须等子进程结束再返回（便携包装器依赖父进程存活）
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    env,
    stdio: 'inherit'
  })

  if (r.error) {
    console.error('[guard] 重新拉起失败:', r.error.message)
    console.error('[guard] 请手动清除 ELECTRON_RUN_AS_NODE 后重试')
    process.exit(1)
  }
  // 透传子进程退出码，让调用方看到真实结果
  process.exit(r.status ?? 0)
}
