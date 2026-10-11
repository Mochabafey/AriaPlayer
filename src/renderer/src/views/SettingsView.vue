<script setup>
import { ref, onMounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { ncm, qqmusic, win } from '../api'
import { toast } from '../utils/toast'

// QQ 音乐 Cookie（设置页配置，主进程存 SQLite + 注入 qqmusic 子进程）
const qqCookie = ref('')
const savingQqCookie = ref(false)
onMounted(async () => {
  try {
    qqCookie.value = await qqmusic.getCookie()
  } catch { /* qq 服务未就绪忽略 */ }
})
async function saveQqCookie() {
  savingQqCookie.value = true
  try {
    await qqmusic.setCookie(qqCookie.value)
    toast('已保存并重启 QQ 音乐服务')
  } catch (e) {
    toast('保存失败：' + (e.message || '未知错误'), 'error')
  } finally {
    savingQqCookie.value = false
  }
}

const settings = useSettingsStore()
const restarting = ref(false)
const cache = ref({ count: 0, bytes: 0, limitMB: 2048 })
const clearing = ref(false)

/**
 * 托盘 / 开机自启状态。
 *
 * 为什么单独维护而不放 settings store：这几项需要**双向同步系统状态**
 *（自启写注册表、托盘需主进程建/销毁），不是纯前端偏好。
 * 统一走 win:get/set-tray-settings IPC。
 */
const tray = ref({
  minimizeToTray: false,
  autoLaunch: false,
  startMinimized: true,
  systemAutoLaunch: false,
  devMode: false,
  portable: false
})

/**
 * 便携模式状态（数据目录位置、是否真正生效）。
 * 便携版的数据放在 exe 同级的 AriaData/，需要让用户看得见 ——
 * 否则他会以为「便携版怎么还是把歌单存到 C 盘了」。
 */
const portable = ref({ portable: false, active: false, dataDir: null, exeDir: null, userData: '' })

async function loadPortable() {
  try {
    portable.value = await ncm.portableStatus()
  } catch { /* 主进程未就绪时用默认值 */ }
}

async function loadTray() {
  try {
    tray.value = await win.getTraySettings()
  } catch { /* 忽略：主进程未就绪时用默认值 */ }
}

async function setTray(patch) {
  // 乐观更新（开关手感跟手），失败再回滚
  const prev = { ...tray.value }
  tray.value = { ...tray.value, ...patch }
  try {
    await win.setTraySettings(patch)
    // 重新读回系统实际状态（自启是否真的写成功）
    await loadTray()
    const label =
      patch.autoLaunch !== undefined ? (patch.autoLaunch ? '已开启开机自启' : '已关闭开机自启')
      : patch.minimizeToTray !== undefined ? (patch.minimizeToTray ? '关闭窗口将最小化到托盘' : '关闭窗口将直接退出')
      : '设置已保存'
    toast(label)
  } catch (e) {
    tray.value = prev
    toast('设置失败：' + (e.message || '未知错误'), 'error')
  }
}

onMounted(() => {
  settings.load()
  refreshCache()
  loadTray()
  loadPortable()
})

async function refreshCache() {
  cache.value = await ncm.cacheStats()
}

function fmtBytes(b) {
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(b / 1024) + ' KB'
}

async function clearCache() {
  clearing.value = true
  try {
    cache.value = await ncm.cacheClear()
    toast('播放缓存已清空', 'success')
  } finally {
    clearing.value = false
  }
}

async function onLimitChange() {
  await settings.set('audioCacheLimitMB', settings.settings.audioCacheLimitMB)
  await refreshCache()
  toast(settings.settings.audioCacheLimitMB ? '缓存上限已更新' : '持久缓存已关闭', 'success')
}

async function restartServer() {
  restarting.value = true
  try {
    await ncm.serverRestart()
    toast('服务已重启，设置生效', 'success')
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
      <h2>数据存储</h2>
      <div class="row">
        <div class="label">
          <div>
            运行模式
            <span v-if="portable.active" class="tag-ok">便携模式</span>
            <span v-else-if="portable.portable" class="tag-warn">便携版（已回退系统目录）</span>
          </div>
          <div class="hint">
            <template v-if="portable.active">
              所有数据（曲库、歌单、设置、登录态、缓存）都存放在程序同级目录，
              换台电脑插上就能用，不会在宿主机留下数据
            </template>
            <template v-else-if="portable.portable">
              检测到便携版，但数据目录不可写（U 盘写保护 / 权限不足），
              已回退到系统用户目录 —— 数据不会随程序移动
            </template>
            <template v-else>
              安装版：数据存放在系统用户目录，与程序安装位置分离
            </template>
          </div>
        </div>
        <div class="value dir">
          <span class="path">{{ portable.userData || '（未知）' }}</span>
          <button class="btn small ghost" @click="ncm.openFolder(portable.userData)">打开</button>
        </div>
      </div>
      <div v-if="portable.portable" class="row">
        <div class="label">
          <div>程序所在目录</div>
          <div class="hint">便携版的数据目录是它下面的 AriaData 文件夹</div>
        </div>
        <div class="value dir">
          <span class="path">{{ portable.exeDir }}</span>
          <button class="btn small ghost" @click="ncm.openFolder(portable.exeDir)">打开</button>
        </div>
      </div>
    </section>

    <section class="sec">
      <h2>播放缓存</h2>
      <div class="row">
        <div class="label">
          <div>缓存上限</div>
          <div class="hint">播放过的歌曲缓存在本地，再次播放无需联网；超出上限自动清理最久未播的</div>
        </div>
        <div class="value">
          <select
            v-model="settings.settings.audioCacheLimitMB"
            class="input select"
            @change="onLimitChange"
          >
            <option :value="0">不缓存</option>
            <option :value="512">512 MB</option>
            <option :value="1024">1 GB</option>
            <option :value="2048">2 GB</option>
            <option :value="4096">4 GB</option>
            <option :value="8192">8 GB</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>当前占用</div>
          <div class="hint">{{ cache.count }} 首歌曲 · {{ fmtBytes(cache.bytes) }}</div>
        </div>
        <div class="value">
          <button class="btn small ghost" :disabled="clearing || !cache.count" @click="clearCache">
            {{ clearing ? '清理中…' : '清空缓存' }}
          </button>
        </div>
      </div>
    </section>

    <section class="sec">
      <h2>启动与后台</h2>
      <div class="row">
        <div class="label">
          <div>开机自启动</div>
          <div class="hint">
            <template v-if="tray.portable">
              <span class="warn">便携版不支持开机自启</span>
              —— 便携版的程序运行在临时解压目录，写入的自启项在退出后即失效，
              还会污染当前电脑的注册表
            </template>
            <template v-else>
              登录系统后自动启动咏叹调
              <span v-if="tray.devMode" class="warn">（当前为开发模式，自启项指向开发环境而非安装版）</span>
              <span v-else-if="tray.autoLaunch !== tray.systemAutoLaunch" class="warn">（与系统实际状态不一致，重新开关一次可同步）</span>
            </template>
          </div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: tray.autoLaunch }"
            :disabled="tray.portable"
            :title="tray.portable ? '便携版不支持开机自启' : ''"
            @click="setTray({ autoLaunch: !tray.autoLaunch })"
          ></button>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>以最小化的形式启动</div>
          <div class="hint">
            启动时不弹出窗口，直接驻留托盘（手动启动与开机自启都生效）。
            托盘图标单击可唤回窗口
          </div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: tray.startMinimized }"
            @click="setTray({ startMinimized: !tray.startMinimized })"
          ></button>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>最小化到系统托盘</div>
          <div class="hint">点关闭按钮不退出程序，后台继续播放；从托盘菜单可真正退出</div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: tray.minimizeToTray }"
            @click="setTray({ minimizeToTray: !tray.minimizeToTray })"
          ></button>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>启动时预加载 QQ 音乐</div>
          <div class="hint">
            默认关闭：QQ 音乐服务首次使用才启动（它编译较慢，约 4.9 秒）。
            若你常用 QQ 音源，可开启提前加载
          </div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: settings.settings.qqPreload }"
            @click="settings.set('qqPreload', !settings.settings.qqPreload)"
          ></button>
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
          <div>显示歌词翻译</div>
          <div class="hint">在歌词下方同时显示中文翻译（无翻译的歌曲不显示）</div>
        </div>
        <div class="value">
          <button
            class="switch"
            :class="{ on: settings.settings.showTranslation }"
            @click="settings.set('showTranslation', !settings.settings.showTranslation)"
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
          <div>默认音源</div>
          <div class="hint">搜索时优先使用哪个平台的音源</div>
        </div>
        <div class="value">
          <select v-model="settings.settings.musicSource" class="input select" @change="settings.set('musicSource', settings.settings.musicSource)">
            <option value="netease">网易云音乐</option>
            <option value="qq">QQ音乐</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <div>QQ 音乐 Cookie</div>
          <div class="hint">解锁 VIP/版权歌曲播放。从 QQ 音乐网页版（y.qq.com）登录后，F12 → Network 复制 Cookie 头填入。保存后自动重启 QQ 服务</div>
        </div>
        <div class="value">
          <textarea
            v-model="qqCookie"
            class="input qq-cookie"
            rows="3"
            placeholder="粘贴 QQ 音乐 Cookie（可选，留空则不使用）"
          ></textarea>
          <button class="btn small" @click="saveQqCookie" :disabled="savingQqCookie">
            {{ savingQqCookie ? '保存中…' : '保存 Cookie' }}
          </button>
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
        <p><b>咏叹调</b> Aria Player v0.2.1</p>
        <p class="hint">基于 <a href="https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced" target="_blank">api-enhanced</a>（MIT License）</p>
        <p class="hint">仅供学习交流使用，请尊重版权，勿用于商业用途</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.5px;
  margin-bottom: 22px;
}
/* 提示文案里的警告态（如「开发模式下不写入系统启动项」） */
.warn {
  color: #e8a33d;
}
.sec {
  max-width: 640px;
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
.qq-cookie {
  width: 360px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  resize: vertical;
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
  transition: background 0.22s var(--ease);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
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
  transition: all 0.22s var(--ease-spring);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.switch:hover::after {
  transform: scale(1.1);
}
.switch.on {
  background: var(--accent);
}
.switch.on::after {
  left: 23px;
  background: #fff;
  transform: none;
}
.switch:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.switch:disabled:hover::after {
  transform: none;
}
/* 运行模式标签 */
.tag-ok,
.tag-warn {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 8px;
  margin-left: 6px;
  vertical-align: middle;
}
.tag-ok {
  background: rgba(49, 194, 124, 0.15);
  color: var(--green);
}
.tag-warn {
  background: rgba(255, 152, 0, 0.16);
  color: #e08b00;
}
.about p {
  font-size: 13px;
  margin-bottom: 4px;
}
.about a {
  color: var(--accent);
}
.about a:hover {
  color: var(--accent-hover);
  text-decoration: underline;
}
</style>
