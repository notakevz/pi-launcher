import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionSender, createToggleGate, createTrayBridge, measureTray } from './bridge.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeHost(open = vi.fn(() => null)) {
  const observers = [];
  const host = {
    open,
    document: document.implementation.createHTMLDocument(),
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        this.disconnect = vi.fn();
        observers.push(this);
      }
    },
  };
  return { host, observers };
}
const requests = (host) => host.open.mock.calls.map(([url]) => url.replace('https://pi-launcher.tray/', ''));

function geometry() {
  const wrapper = document.createElement('main');
  const card = document.createElement('section');
  const content = document.createElement('div');
  wrapper.style.padding = '12px';
  card.style.padding = '8px';
  card.style.border = '1px solid black';
  wrapper.append(card);
  card.append(content);
  vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ width: 328.2, height: 382.4 });
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ width: 286.2, height: 340.4 });
  Object.defineProperty(wrapper, 'scrollHeight', { configurable: true, value: 382 });
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 340 });
  return { wrapper, card, content };
}

describe('tray native bridge (no Registry or app processes)', () => {
  it('uses only intercepted window.open actions and accepts null replies', () => {
    const { host } = fakeHost();
    expect(createActionSender(host)('show')).toBe(true);
    expect(host.open).toHaveBeenCalledExactlyOnceWith('https://pi-launcher.tray/show', '_blank');
    host.open.mockImplementation(() => { throw new Error('unavailable'); });
    expect(createActionSender(host)('quit')).toBe(false);
  });

  it('protects real click counts and detail=0 clicks with an independent 500ms gate', () => {
    let now = 0;
    const gate = createToggleGate(() => now);
    expect(gate({ detail: 1 })).toBe(true);
    now = 100;
    expect(gate({ detail: 2 })).toBe(false);
    expect(gate({ detail: 0 })).toBe(false);
    now = 500;
    expect(gate({ detail: 0 })).toBe(true);
    now = 1100;
    expect(gate({ detail: 2 })).toBe(false);
    expect(gate({ detail: 1 })).toBe(true);
  });

  it('ceil-measures the real wrapper border box including padding', () => {
    const { wrapper, card, content } = geometry();
    expect(measureTray(wrapper, card, content)).toEqual({ width: 329, height: 383 });
    Object.defineProperty(wrapper, 'scrollHeight', { value: 400 });
    expect(measureTray(wrapper, card, content).height).toBe(400);
    expect(measureTray(null, card, content)).toBeNull();
  });

  it('keeps natural-height intent when maxHeight clips the card, independent of viewport size', () => {
    const { wrapper, card, content } = geometry();
    const box = wrapper.getBoundingClientRect;
    content.getBoundingClientRect.mockReturnValue({ width: 286.2, height: 480.2 });
    Object.defineProperty(content, 'scrollHeight', { value: 480 });
    card.style.maxHeight = '156px';
    box.mockReturnValue({ width: 328.2, height: 180 });
    Object.defineProperty(wrapper, 'scrollHeight', { value: 180 });
    // 480.2 content + 16 card padding + 2 card border + 24 shadow gutters.
    expect(measureTray(wrapper, card, content)).toEqual({ width: 329, height: 523 });
    vi.stubGlobal('innerHeight', 72);
    card.style.maxHeight = '136px';
    box.mockReturnValue({ width: 328.2, height: 160 });
    Object.defineProperty(wrapper, 'scrollHeight', { value: 160 });
    expect(measureTray(wrapper, card, content)).toEqual({ width: 329, height: 523 });
  });

  it('measures after render in a hidden webview without rAF, dedupes ceil sizes, and replays ready state', async () => {
    const { host, observers } = fakeHost();
    let size = { width: 328.01, height: 381.01 };
    const afterRender = vi.fn(async () => {});
    const onState = vi.fn();
    const bridge = createTrayBridge({ host, afterRender, onState, getSize: () => size });
    const node = document.createElement('main');
    host.open.mockImplementation((url) => {
      if (url.endsWith('/ready')) host.__setTrayState({ ready: true, autostart: { enabled: false } });
      return null;
    });
    expect(typeof host.__setTrayState).toBe('function');
    expect(typeof host.__measureTray).toBe('function');
    await bridge.mounted([node]);
    await host.__measureTray();
    expect(requests(host)).toEqual(['resize-329-382', 'ready']);
    expect(onState).toHaveBeenCalledWith({ ready: true, autostart: { enabled: false } });
    expect(afterRender).toHaveBeenCalled();
    expect(observers[0].observe).toHaveBeenCalledWith(node);
    size = { width: 328.99, height: 381.99 };
    await host.__measureTray();
    expect(requests(host)).toEqual(['resize-329-382', 'ready']);
    size = { width: 328, height: 390.1 };
    observers[0].callback();
    await host.__measureTray();
    expect(requests(host).at(-1)).toBe('resize-328-391');
    expect(requests(host).filter((action) => action === 'resize-328-391')).toHaveLength(1);
    bridge.dispose();
  });

  it('bounds large-font size requests and ignores non-finite measurements', async () => {
    const { host } = fakeHost();
    let size = { width: Infinity, height: 400 };
    const bridge = createTrayBridge({ host, onState: vi.fn(), getSize: () => size });
    await bridge.measure();
    expect(requests(host)).toEqual([]);
    size = { width: 328, height: 1400 };
    await bridge.measure();
    expect(requests(host)).toEqual(['resize-328-900']);
    size = { width: 328, height: 1500 };
    await bridge.measure();
    expect(requests(host)).toHaveLength(1);
    bridge.dispose();
  });

  it('waits for state rendering and fonts; cleans observers, listeners and global callbacks', async () => {
    const { host, observers } = fakeHost();
    let finishFonts;
    host.document.fonts = { ready: new Promise((resolve) => { finishFonts = resolve; }) };
    let height = 300;
    let renderedHeight = height;
    const bridge = createTrayBridge({
      host,
      onState(value) { height = value.height; },
      afterRender: async () => { renderedHeight = height; },
      getSize: () => ({ width: 328, height: renderedHeight }),
    });
    await bridge.mounted([host.document.body]);
    host.__setTrayState({ height: 400 });
    await host.__measureTray();
    expect(requests(host).at(-1)).toBe('resize-328-400');
    height = 410;
    finishFonts();
    await Promise.resolve();
    await host.__measureTray();
    expect(requests(host).at(-1)).toBe('resize-328-410');
    const oldMeasure = host.__measureTray;
    const oldState = host.__setTrayState;
    bridge.dispose();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(host.__setTrayState).toBeUndefined();
    expect(host.__measureTray).toBeUndefined();
    host.open.mockClear();
    oldState({ height: 500 });
    await oldMeasure();
    host.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(host.open).not.toHaveBeenCalled();
  });

  it('suppresses native context menus and does not remove callbacks owned by a newer mount', async () => {
    const { host } = fakeHost();
    const options = { host, onState: vi.fn(), getSize: () => null };
    const first = createTrayBridge(options);
    await first.mounted([]);
    const context = new Event('contextmenu', { cancelable: true });
    host.document.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    const second = createTrayBridge(options);
    const callback = host.__setTrayState;
    first.dispose();
    expect(host.__setTrayState).toBe(callback);
    second.dispose();
  });
});
