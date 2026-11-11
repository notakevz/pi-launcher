// The bundled tray has no Tauri IPC privileges. Rust intercepts these popups;
// a null return value is expected and does not mean the request failed.
export function createActionSender(host = window) {
  return (action) => {
    try {
      host.open(`https://pi-launcher.tray/${action}`, '_blank');
      return true;
    } catch {
      return false;
    }
  };
}

// Keep this clock independent of native replies / pending state. The reply can
// arrive between mouse clicks, and PrimeVue's input change has detail === 0.
// Call ONLY from the actual captured click, never from update:modelValue/change.
export function createToggleGate(now = () => performance.now()) {
  let lastAccepted = -Infinity;
  return (event) => {
    const time = now();
    if (event.detail > 1 || time - lastAccepted < 500) return false;
    lastAccepted = time;
    return true;
  };
}

function verticalInsets(node, host) {
  const css = host.getComputedStyle(node);
  return ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
    .reduce((sum, key) => sum + (parseFloat(css[key]) || 0), 0);
}

// The wrapper's actual border box includes its shadow gutters. When maxHeight
// clips the card, its unconstrained content still expresses the natural request.
// No innerHeight, vh, documentElement height or window-size feedback is used.
export function measureTray(wrapper, card, content, host = window) {
  if (!wrapper || !card || !content) return null;
  const box = wrapper.getBoundingClientRect();
  const natural = Math.max(content.getBoundingClientRect().height, content.scrollHeight)
    + verticalInsets(card, host) + verticalInsets(wrapper, host);
  return {
    width: Math.ceil(box.width),
    height: Math.ceil(Math.max(box.height, wrapper.scrollHeight, natural)),
  };
}

export function createTrayBridge({
  host = window,
  onState,
  getSize,
  afterRender = () => Promise.resolve(),
}) {
  const send = createActionSender(host);
  let active = true;
  let lastSize = '';
  let observer;
  const measure = async () => {
    await afterRender();
    if (!active) return;
    const size = getSize();
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return;
    // Match the native allow-list; oversize fonts still get a bounded viewport
    // with an accessible scrolling fallback, rather than a rejected first show.
    const width = Math.min(480, Math.max(280, Math.ceil(size.width)));
    const height = Math.min(900, Math.max(160, Math.ceil(size.height)));
    const key = `${width}-${height}`;
    if (key === lastSize) return;
    if (send(`resize-${key}`)) lastSize = key;
  };
  const setState = (state) => {
    if (!active || !state || typeof state !== 'object') return;
    onState(state);
    void measure();
  };
  const keydown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    send('dismiss');
  };
  const contextmenu = (event) => event.preventDefault();

  // Install during setup, before mount; ready below asks Rust to replay anything
  // it tried to push before the Vite module was evaluated.
  host.__setTrayState = setState;
  host.__measureTray = measure;

  return {
    send,
    measure,
    async mounted(nodes) {
      host.document.addEventListener('keydown', keydown);
      host.document.addEventListener('contextmenu', contextmenu);
      if (host.ResizeObserver) {
        observer = new host.ResizeObserver(() => void measure());
        nodes.filter(Boolean).forEach((node) => observer.observe(node));
      }
      // Do not rely on rAF: a hidden native webview may not run animation frames.
      await measure();
      if (!active) return;
      send('ready');
      host.document.fonts?.ready?.then(() => { if (active) void measure(); });
    },
    dispose() {
      active = false;
      observer?.disconnect();
      host.document.removeEventListener('keydown', keydown);
      host.document.removeEventListener('contextmenu', contextmenu);
      if (host.__setTrayState === setState) delete host.__setTrayState;
      if (host.__measureTray === measure) delete host.__measureTray;
    },
  };
}
