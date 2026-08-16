<script setup>
import { toasts, dismiss } from '../utils/toast'
</script>

<template>
  <div class="toast-stack">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast glass" :class="t.type" @click="dismiss(t.id)">
        <span class="toast-dot"></span>
        <span class="toast-msg">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 300;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 400px;
  padding: 10px 16px;
  border-radius: 10px;
  font-size: 13px;
  box-shadow: var(--shadow);
  cursor: pointer;
  border: 1px solid var(--hairline);
}
.toast-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-dim);
}
.toast.success .toast-dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
.toast.error .toast-dot { background: var(--accent); box-shadow: 0 0 8px var(--accent-glow); }
.toast-msg { line-height: 1.5; word-break: break-all; }

.toast-enter-active,
.toast-leave-active { transition: opacity 0.25s var(--ease), transform 0.25s var(--ease); }
.toast-enter-from { opacity: 0; transform: translateX(24px); }
.toast-leave-to { opacity: 0; transform: translateY(-8px) scale(0.96); }
</style>
