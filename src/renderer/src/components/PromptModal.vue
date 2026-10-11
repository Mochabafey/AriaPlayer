<script setup>
/**
 * 通用模态框（替代 window.prompt / confirm）。
 *
 * 为什么不用原生 prompt/confirm：
 *   - Electron 渲染进程里它们会**阻塞整个渲染线程**（包括正在播放的音频进度更新）
 *   - 样式与暗色主题不一致，且无法自定义
 *   - prompt 在部分平台返回 null 与「取消」无法区分
 *
 * 支持两种用途：
 *   mode="prompt"  一个输入框（可带 hint 与校验）
 *   mode="confirm" 纯确认（可标 danger 让确认按钮变红）
 */
import { ref, watch, nextTick } from 'vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'prompt' }, // prompt | confirm
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  /** 输入框初始值 / 占位符 */
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  hint: { type: String, default: '' },
  /** 确认按钮文案与危险样式 */
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  danger: { type: Boolean, default: false },
  /** 输入框最大长度 */
  maxlength: { type: Number, default: 60 },
  /** 校验函数：返回错误字符串则阻止提交 */
  validate: { type: Function, default: null }
})

const emit = defineEmits(['update:show', 'update:modelValue', 'confirm', 'cancel'])

const text = ref(props.modelValue)
const error = ref('')
const inputEl = ref(null)

watch(
  () => props.show,
  async (s) => {
    if (!s) return
    text.value = props.modelValue
    error.value = ''
    if (props.mode === 'prompt') {
      await nextTick()
      inputEl.value?.focus()
      inputEl.value?.select()
    }
  }
)

function close() {
  emit('update:show', false)
}

function cancel() {
  emit('cancel')
  close()
}

function confirm() {
  if (props.mode === 'prompt') {
    const v = text.value.trim()
    if (!v) {
      error.value = '名称不能为空'
      return
    }
    const e = props.validate?.(v)
    if (e) {
      error.value = e
      return
    }
    emit('update:modelValue', v)
    emit('confirm', v)
  } else {
    emit('confirm')
  }
  close()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="pm-mask" @click.self="cancel" @keydown.esc="cancel">
      <div class="pm-box" @click.stop>
        <h3 v-if="title" class="pm-title">{{ title }}</h3>
        <p v-if="message" class="pm-msg">{{ message }}</p>

        <input
          v-if="mode === 'prompt'"
          ref="inputEl"
          v-model="text"
          class="input pm-input"
          :placeholder="placeholder"
          :maxlength="maxlength"
          @keydown.enter.prevent="confirm"
          @keydown.esc.prevent="cancel"
        />
        <p v-if="error" class="pm-err">{{ error }}</p>
        <p v-else-if="hint" class="pm-hint">{{ hint }}</p>

        <div class="pm-actions">
          <button class="btn ghost" @click="cancel">{{ cancelText }}</button>
          <button class="btn" :class="{ danger }" @click="confirm">{{ confirmText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pm-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2500;
  animation: pm-fade 0.14s var(--ease);
}
@keyframes pm-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.pm-box {
  width: 400px;
  max-width: calc(100vw - 48px);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px 24px 18px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
  animation: pm-pop 0.16s var(--ease);
}
@keyframes pm-pop {
  from { opacity: 0; transform: scale(0.96) translateY(6px); }
  to { opacity: 1; transform: none; }
}
.pm-title {
  font-size: 17px;
  font-weight: 700;
  margin-bottom: 8px;
}
.pm-msg {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-bottom: 14px;
  word-break: break-word;
}
.pm-input {
  width: 100%;
}
.pm-err {
  font-size: 12px;
  color: var(--accent);
  margin-top: 7px;
}
.pm-hint {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 7px;
  line-height: 1.5;
}
.pm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.btn.danger {
  background: var(--accent);
}
.btn.danger:hover {
  background: var(--accent-hover);
}
</style>
