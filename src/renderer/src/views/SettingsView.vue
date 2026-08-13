<script setup>
import { ref, onMounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { ncm } from '../api'

const settings = useSettingsStore()
const restarting = ref(false)

onMounted(() => settings.load())

async function restartServer() {
  restarting.value = true
  try {
    await ncm.serverRestart()
    alert('服务已重启，设置生效')
  } finally {
    restarting.value = false
  }
}
</script>

<template>
  <div class="settings">
    <h1 class="page-title">设置</h1>

    <section class="sec">
      <h2>下载</h2>
      <div class="row">
        <div class="label">
          <div>默认音质</div>
          <div class="hint">下载与播放的默认音质</div>
        </div>
        <div class="value">
          <select v-model="settings.settings.quality" class="input select" @change="settings.set('quality', settings.settings.quality)">
            <option value="128000">128k 标准</option>
            <option value="320000">320k 高品</option>
            <option value="lossless">FLAC 无损（需会员权限）</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>下载目录</div>
          <div class="hint">下载文件的保存位置</div>
        </div>
        <div class="value dir">
          <span class="path">{{ settings.settings.downloadDir || '（未设置）' }}</span>
          <button class="btn small ghost" @click="settings.pickDownloadDir()">选择</button>
        </div>
      </div>
    </section>

    <section class="sec">
      <h2>服务（api-enhanced）</h2>
      <div class="row">
        <div class="label">
          <div>全局解灰</div>
          <div class="hint">自动解锁无版权/灰色歌曲（依赖第三方解锁服务）</div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: settings.settings.enableUnblock }"
            @click="settings.set('enableUnblock', !settings.settings.enableUnblock)"
          ></button>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>允许无损 FLAC</div>
          <div class="hint">开启后请求无损音质（需登录会员）</div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: settings.settings.enableFlac }"
            @click="settings.set('enableFlac', !settings.settings.enableFlac)"
          ></button>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>播放模式</div>
          <div class="hint">列表循环 / 单曲循环 / 随机播放</div>
        </div>
        <div class="value">
          <select v-model="settings.settings.playMode" class="input select" @change="settings.set('playMode', settings.settings.playMode)">
            <option value="list">列表循环</option>
            <option value="loop">单曲循环</option>
            <option value="shuffle">随机播放</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>重启服务</div>
          <div class="hint">解灰 / FLAC 开关需重启内置服务后生效</div>
        </div>
        <div class="value">
          <button class="btn small ghost" :disabled="restarting" @click="restartServer">
            {{ restarting ? '重启中…' : '立即重启' }}
          </button>
        </div>
      </div>
    </section>

    <section class="sec">
      <h2>关于</h2>
      <div class="about">
        <p><b>网易牛具</b> Netease Track Resolver v0.1.0</p>
        <p class="hint">基于 <a href="https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced" target="_blank">api-enhanced</a>（MIT License）</p>
        <p class="hint">仅供学习交流使用，请尊重版权，勿用于商业用途</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 22px;
  margin-bottom: 22px;
}
.sec {
  margin-bottom: 32px;
}
.sec h2 {
  font-size: 16px;
  color: var(--text-dim);
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid #222;
}
.label .hint {
  font-size: 12px;
  color: var(--text-faint);
  margin-top: 3px;
}
.value {
  display: flex;
  align-items: center;
  gap: 10px;
}
.select {
  width: 180px;
}
.dir .path {
  font-size: 13px;
  color: var(--text-dim);
  max-width: 360px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.switch {
  width: 46px;
  height: 26px;
  border-radius: 13px;
  background: #3a3a3a;
  position: relative;
  transition: background 0.2s;
}
.switch::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #888;
  transition: all 0.2s;
}
.switch.on {
  background: var(--accent);
}
.switch.on::after {
  left: 23px;
  background: #fff;
}
.about p {
  font-size: 13px;
  margin-bottom: 4px;
}
.about a {
  color: var(--accent);
}
</style>
