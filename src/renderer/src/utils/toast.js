import { reactive } from 'vue'

/** 全局轻提示队列（替代阻塞式 alert） */
export const toasts = reactive([])
let seed = 0

/** toast(message, type)：type = info | success | error */
export function toast(message, type = 'info') {
  const id = ++seed
  toasts.push({ id, message, type })
  // 最多同时 5 条，避免刷屏
  if (toasts.length > 5) toasts.shift()
  setTimeout(() => dismiss(id), type === 'error' ? 4200 : 2800)
}

export function dismiss(id) {
  const i = toasts.findIndex((t) => t.id === id)
  if (i > -1) toasts.splice(i, 1)
}
