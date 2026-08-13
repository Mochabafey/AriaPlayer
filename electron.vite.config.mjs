import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * 构建产物统一输出到 dist/out（源码目录保持干净）：
 *   dist/out/main     — 主进程
 *   dist/out/preload  — 预加载脚本
 *   dist/out/renderer — 渲染进程
 * 安装包输出到 dist/release（见 electron-builder.yml）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/out/main',
      emptyOutDir: false,
      rollupOptions: {
        input: { index: 'src/main/index.js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/out/preload',
      emptyOutDir: false,
      rollupOptions: {
        input: { index: 'src/preload/index.js' }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': 'src/renderer/src'
      }
    },
    build: {
      outDir: 'dist/out/renderer',
      emptyOutDir: false
    }
  }
})
