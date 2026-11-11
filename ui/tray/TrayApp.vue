<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import Button from 'primevue/button';
import Divider from 'primevue/divider';
import ToggleSwitch from 'primevue/toggleswitch';
import TrayIcon from './TrayIcon.vue';
import iconUrl from '../icon.svg';
import { createToggleGate, createTrayBridge, measureTray } from './bridge.js';

const state = shallowRef({ ready: false, autostart: {} });
const pending = ref(false);
const localError = ref('');
const wrapper = ref(null);
const card = ref(null);
const content = ref(null);
const startup = computed(() => state.value.autostart || {});
const known = computed(() => typeof startup.value.enabled === 'boolean' && !startup.value.conflict);
const enabled = computed(() => known.value && startup.value.enabled === true);
const disabled = computed(() => !known.value || pending.value);
const error = computed(() => localError.value || startup.value.error ||
  (!known.value ? '无法确认开机自启状态，请重新打开菜单。' : ''));
const startupTitle = computed(() => error.value || (pending.value ? '正在确认开机自启状态…' :
  (enabled.value ? '关闭开机自启' : '开启开机自启')));
const maxHeightStyle = computed(() => {
  const height = state.value.maxHeight;
  return typeof height === 'number' && Number.isFinite(height) && height > 24
    ? { '--tray-card-max-height': `${height - 24}px` } : {};
});
const groups = [
  [{ action: 'show', label: '显示主窗口' },
    { action: 'browser', label: '在浏览器中打开', needsReady: true },
    { action: 'copy', label: '复制 Web 地址', needsReady: true }],
  [{ action: 'config-dir', label: '打开配置目录' },
    { action: 'log-dir', label: '打开日志目录' }],
];
const bridge = createTrayBridge({
  onState(value) {
    state.value = { ...state.value, ...value };
    // Resize-only payloads must not release an outstanding startup request.
    if (Object.hasOwn(value, 'autostart')) {
      pending.value = false;
      localError.value = '';
    }
  },
  getSize: () => measureTray(wrapper.value, card.value, content.value),
  afterRender: nextTick,
});
const acceptClick = createToggleGate();
let toggleTimer;

function startupClick(event) {
  // Cancel the browser's checkbox default BEFORE PrimeVue can receive change.
  // PrimeVue change/update:modelValue events have no useful mouse click count.
  // We deliberately never write its model: only the verified native reply does.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (disabled.value || !acceptClick(event)) return;
  pending.value = true;
  // A canceled checkbox click rolls its DOM value back AFTER event listeners.
  // Send in the next task so even an immediate native reply cannot be undone
  // by that browser default-action rollback (real Edge/WebView2 behavior).
  toggleTimer = setTimeout(() => {
    toggleTimer = undefined;
    if (!bridge.send('autostart-toggle')) {
      pending.value = false;
      localError.value = '无法发送自启设置请求，请重新打开菜单。';
    }
  }, 0);
}

function startupEnter(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (!event.repeat && !disabled.value) event.target.click();
}

onMounted(() => void bridge.mounted([wrapper.value, card.value, content.value]));
onBeforeUnmount(() => {
  clearTimeout(toggleTimer);
  bridge.dispose();
});
</script>

<template>
  <main ref="wrapper" class="tray-wrapper" :style="maxHeightStyle" aria-label="Pi Launcher 菜单">
    <section ref="card" class="tray-card">
      <div ref="content" class="tray-content">
        <header class="tray-head">
          <img :src="iconUrl" alt="" width="26" height="26">
          <div class="head-text">
            <h1>Pi Launcher</h1>
            <p id="subtitle" :title="state.label || ''">{{ state.ready ? '本地服务已就绪' : '正在启动本地服务…' }}</p>
          </div>
          <span id="badge" class="status-tag" :data-ready="!!state.ready">
            <span class="status-dot" aria-hidden="true" />
            <span id="badge-text">{{ state.ready ? '运行中' : '启动中' }}</span>
          </span>
        </header>

        <div class="tray-endpoint">
          <TrayIcon name="endpoint" />
          <span id="endpoint" class="endpoint-url" :title="state.endpoint || ''">{{ state.endpoint || '等待连接' }}</span>
          <span v-if="state.version" id="version" class="endpoint-version" :title="`后端版本 ${state.version}`">{{ state.version }}</span>
        </div>

        <template v-for="(group, index) in groups" :key="index">
          <Divider />
          <Button v-for="item in group" :id="`action-${item.action}`" :key="item.action"
            class="tray-action" :data-action="item.action" text
            :disabled="item.needsReady && !state.ready" @click="bridge.send(item.action)">
            <TrayIcon :name="item.action" /><span class="action-label">{{ item.label }}</span>
          </Button>
        </template>

        <Divider />
        <div class="startup-row" :class="{ 'startup-unknown': !known, 'startup-pending': pending }"
          :title="startupTitle" @click.capture="startupClick" @keydown="startupEnter">
          <TrayIcon name="autostart" />
          <label id="autostart-label" for="action-autostart" class="action-label">开机自启</label>
          <ToggleSwitch input-id="action-autostart" :model-value="enabled" :disabled="disabled"
            aria-labelledby="autostart-label"
            :pt="{ input: { role: known ? 'switch' : 'checkbox', 'aria-checked': known ? String(enabled) : 'mixed', 'aria-describedby': 'autostart-status', 'aria-busy': pending, title: startupTitle } }">
            <template #handle><span v-if="!known" class="unknown-mark" aria-hidden="true">?</span></template>
          </ToggleSwitch>
        </div>
        <span id="autostart-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ error }}</span>
        <Button id="action-quit" class="tray-action tray-quit" data-action="quit" text @click="bridge.send('quit')">
          <TrayIcon name="quit" /><span class="action-label">退出</span>
        </Button>
      </div>
    </section>
  </main>
</template>
