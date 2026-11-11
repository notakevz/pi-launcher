import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import TrayApp from './TrayApp.vue';

let app;
let root;
let open;
let clock;
const actions = () => open.mock.calls.map(([url]) => url.replace('https://pi-launcher.tray/', ''));
const toggles = () => actions().filter((action) => action === 'autostart-toggle');
function q(selector) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Missing tray element: ${selector}`);
  return element;
}
const input = () => q('input#action-autostart');
async function flush() {
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 0));
  await nextTick();
}
async function state(autostart, extra = {}) {
  window.__setTrayState({ ready: true, endpoint: 'http://127.0.0.1:30141', version: '1.2.3', autostart, ...extra });
  await flush();
}
function click(detail = 1) {
  input().dispatchEvent(new MouseEvent('click', { detail, bubbles: true, cancelable: true }));
}
function key(element, value, options = {}) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, cancelable: true, bubbles: true, ...options }));
}

beforeEach(async () => {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  open = vi.spyOn(window, 'open').mockReturnValue(null);
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(TrayApp);
  app.use(PrimeVue, { ripple: false, theme: { preset: Aura, options: { darkModeSelector: 'system' } } });
  app.mount(root);
  await flush();
});
afterEach(() => {
  app?.unmount();
  root.remove();
  vi.restoreAllMocks();
});

describe('real PrimeVue tray mounted with Vue createApp', () => {
  it('mounts real components, requests replay, and does not mutate a missing/default-false startup registration', async () => {
    expect(root.querySelectorAll('.p-toggleswitch')).toHaveLength(1);
    expect(root.querySelectorAll('button.p-button')).toHaveLength(6);
    expect(root.querySelectorAll('.p-divider')).toHaveLength(3);
    expect(actions()).toContain('ready');
    expect(toggles()).toEqual([]);
    await state({ enabled: false, error: null });
    expect(input().tagName).toBe('INPUT');
    expect(input().getAttribute('role')).toBe('switch');
    expect(input().getAttribute('aria-labelledby')).toBe('autostart-label');
    expect(q('#autostart-label').textContent).toBe('开机自启');
    expect(input().getAttribute('aria-describedby')).toBe('autostart-status');
    expect(input().disabled).toBe(false);
    expect(input().checked).toBe(false);
    expect(input().getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector('.startup-unknown')).toBeNull();
    expect(toggles()).toEqual([]);
    await state({ enabled: true, error: null });
    expect(input().checked).toBe(true);
    expect(input().getAttribute('aria-checked')).toBe('true');
    expect(q('#endpoint').textContent).toBe('http://127.0.0.1:30141');
    expect(q('#version').textContent).toBe('1.2.3');
    expect(q('#badge-text').textContent).toBe('运行中');
  });

  it('shows an explicitly unknown disabled switch with tooltip and live error, not an off state or visible footnote', async () => {
    expect(input().disabled).toBe(true);
    expect(input().getAttribute('role')).toBe('checkbox'); // ARIA switch does not support mixed
    expect(input().getAttribute('aria-checked')).toBe('mixed');
    expect(q('.unknown-mark').textContent).toBe('?');
    await state({ enabled: null, error: '同名启动项冲突，未作修改。' });
    expect(input().disabled).toBe(true);
    expect(input().title).toContain('冲突');
    const live = q('#autostart-status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.classList.contains('sr-only')).toBe(true);
    expect(live.textContent).toContain('冲突');
    click();
    expect(toggles()).toEqual([]);
    await state({ enabled: true, conflict: true, error: '启动项冲突' });
    expect(input().disabled).toBe(true);
    expect(input().getAttribute('aria-checked')).toBe('mixed');
  });

  it('does not optimistically change checked/modelValue or emit native change before a verified reply', async () => {
    await state({ enabled: false });
    const changed = vi.fn();
    input().addEventListener('change', changed);
    click();
    await flush();
    expect(toggles()).toHaveLength(1);
    expect(input().checked).toBe(false);
    expect(input().disabled).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(q('.p-toggleswitch').classList.contains('p-toggleswitch-checked')).toBe(false);
    // A resize-only state push must not unlock an outstanding request.
    window.__setTrayState({ maxHeight: 250 });
    await flush();
    expect(input().disabled).toBe(true);
    await state({ enabled: true });
    expect(input().checked).toBe(true);
    expect(input().disabled).toBe(false);
  });

  it('blocks a second mouse click after a fast native reply, before PrimeVue can receive its detail=0 input change', async () => {
    await state({ enabled: false });
    const changed = vi.fn();
    input().addEventListener('change', changed);
    click(1);
    await state({ enabled: true }); // reply BETWEEN mouse clicks
    clock += 100;
    click(2);
    await flush();
    expect(toggles()).toHaveLength(1);
    expect(input().checked).toBe(true);
    expect(changed).not.toHaveBeenCalled();

    // Forwarded / automated clicks can have detail=0. This cannot bypass the
    // independent time gate by masquerading as PrimeVue input change events.
    click(0);
    await flush();
    expect(toggles()).toHaveLength(1);
    expect(input().checked).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    clock += 401;
    click(1);
    await flush();
    expect(toggles()).toHaveLength(2);
    expect(input().checked).toBe(true); // still awaits verified false
    await state({ enabled: false });
    clock += 600;
    click(2); // click count protects even outside the time gate
    expect(toggles()).toHaveLength(2);
  });

  it('keeps verified state on transport errors, with errors only in tooltip/live region', async () => {
    await state({ enabled: true });
    open.mockImplementation(() => { throw new Error('denied'); });
    click();
    await flush();
    expect(input().checked).toBe(true);
    expect(input().disabled).toBe(false);
    expect(input().title).toContain('无法发送');
    expect(q('#autostart-status').textContent).toContain('无法发送');
  });

  it('retains native tabbable buttons, all original actions, readiness guards and Escape', async () => {
    expect(q('#action-browser').disabled).toBe(true);
    expect(q('#action-copy').disabled).toBe(true);
    await state({ enabled: false });
    for (const action of ['show', 'browser', 'copy', 'config-dir', 'log-dir', 'quit']) {
      const button = q(`[data-action="${action}"]`);
      expect(button.tagName).toBe('BUTTON');
      expect(button.tabIndex).toBe(0);
      button.click();
    }
    expect(actions()).toEqual(expect.arrayContaining(['show', 'browser', 'copy', 'config-dir', 'log-dir', 'quit']));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(actions().at(-1)).toBe('dismiss');
    expect(open.mock.calls.every(([, target]) => target === '_blank')).toBe(true);
  });

  it('handles keyboard Enter and the native Space-generated detail=0 click without a second toggle', async () => {
    await state({ enabled: false });
    input().focus();
    expect(document.activeElement).toBe(input());
    key(input(), 'Enter');
    await flush();
    expect(toggles()).toHaveLength(1);
    await state({ enabled: true });
    clock += 501;
    // jsdom does not synthesize a checkbox click from Space: dispatch the exact
    // click the browser produces, rather than pretending keydown changes it.
    click(0);
    await flush();
    expect(toggles()).toHaveLength(2);
    expect(input().checked).toBe(true);
    await state({ enabled: false });
    clock += 501;
    key(input(), 'Enter', { repeat: true });
    expect(toggles()).toHaveLength(2);
  });

  it('uses only Rust maxHeight for clipping and releases globals/listeners on unmount', async () => {
    await state({ enabled: false }, { maxHeight: 180 });
    expect(q('.tray-wrapper').style.getPropertyValue('--tray-card-max-height')).toBe('156px');
    expect(q('.tray-wrapper').style.height).toBe('');
    expect(typeof window.__measureTray).toBe('function');
    app.unmount();
    app = null;
    expect(window.__setTrayState).toBeUndefined();
    expect(window.__measureTray).toBeUndefined();
    open.mockClear();
    key(document, 'Escape');
    expect(open).not.toHaveBeenCalled();
  });
});
