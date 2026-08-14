// 可靠构建入口：走 electron-vite API 层，绕开 CLI 在部分 shell（Git Bash）下静默失败的问题。
delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.NODE_OPTIONS
const { build } = await import('electron-vite')
await build()
console.log('BUILD_OK')
