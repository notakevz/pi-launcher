const { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeTheme, shell } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const { PiBackend } = require("./backend")

const APP_NAME = "Pi Launcher"
const USER_DATA_DIR = process.env.PI_AGENT_LAUNCHER_DATA_DIR
  ? path.resolve(process.env.PI_AGENT_LAUNCHER_DATA_DIR) : path.join(app.getPath("appData"), "Pi Agent Launcher")
let PORT
const ICON = path.join(__dirname, "..", "assets", "icon.ico")
const backend = new PiBackend({ stateDir: USER_DATA_DIR, log })
let mainWindow, tray, server, quitting = false, cleaning = false, startup
let zoomFactor = 1

app.setName(APP_NAME)
app.setPath("userData", USER_DATA_DIR)
app.setPath("sessionData", path.join(USER_DATA_DIR, "session"))
app.setAppUserModelId("local.pi.agent.launcher")

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", showWindow)
  app.on("activate", showWindow)
  app.on("before-quit", (event) => {
    quitting = true
    if (cleaning) return
    event.preventDefault()
    cleaning = true
    // Cancel an in-flight startup, then stop only the backend this launcher owns.
    Promise.resolve(backend.close()).then(() => startup).catch(() => {}).then(async () => {
      if (server?.owned) await backend.stop(PORT, server.info)
    }).catch((error) => log("Failed to stop backend", error)).finally(() => app.quit())
  })
  app.on("window-all-closed", () => { if (quitting) app.quit() })
  app.whenReady().then(() => {
    startup = start()
    return startup
  }).catch(showFatalError)
}

async function start() {
  // Parse only after the single-instance lock; errors flow through showFatalError.
  await backend.ensureAvailable()
  PORT = backend.config.port
  createTray()
  createWindow()
  await mainWindow.webContents.session.setProxy({ mode: "direct" })
  await mainWindow.loadFile(path.join(__dirname, "..", "assets", "loading.html"))
  mainWindow.setProgressBar(2) // Indeterminate: never invent a completion percentage.
  await setStartupPhase("environment")
  if (quitting) { await backend.close(); return }
  await setStartupPhase("backend")
  server = await backend.start(PORT)
  if (quitting) return
  await setStartupPhase("workspace")
  server.child?.on("exit", (code, signal) => {
    if (!quitting) showFatalError(new Error(`Pi Web 意外退出：code=${code}, signal=${signal}`))
  })
  await mainWindow.loadURL(server.url)
  mainWindow.setProgressBar(-1)
  log(`${APP_NAME} ready at ${server.url}; version=${server.version || "external"}`)
  createTrayMenu()
}

async function setStartupPhase(phase) {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return
  const statuses = { environment: "正在检查运行环境", backend: "正在连接本地服务", workspace: "正在打开工作空间" }
  const state = { phase, status: statuses[phase], endpoint: `127.0.0.1:${PORT}` }
  try {
    await mainWindow.webContents.executeJavaScript(`(() => {
      const state = ${JSON.stringify(state)};
      document.body.dataset.phase = state.phase;
      document.getElementById('status-text').textContent = state.status;
      document.getElementById('endpoint').textContent = state.endpoint;
      for (const step of document.querySelectorAll('[data-step]')) {
        if (step.dataset.step === state.phase) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    })()`)
  } catch (error) { if (!quitting) log("Cannot update startup indicator", error) }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: APP_NAME, icon: ICON, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141518" : "#f5f5f3",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  mainWindow.on("close", (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on("closed", () => { mainWindow = undefined })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (server && new URL(url).origin !== new URL(server.url).origin) {
      event.preventDefault()
      openExternal(url)
    }
  })
  mainWindow.webContents.on("page-title-updated", (event) => { event.preventDefault(); mainWindow.setTitle(APP_NAME) })
  mainWindow.webContents.on("did-finish-load", () => mainWindow.webContents.setZoomFactor(zoomFactor))
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control) return
    if (["+", "="].includes(input.key)) { event.preventDefault(); setZoom(zoomFactor + 0.05) }
    if (input.key === "-") { event.preventDefault(); setZoom(zoomFactor - 0.05) }
    if (input.key === "0") { event.preventDefault(); setZoom(1) }
  })
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const items = []
    if (params.isEditable) items.push({ label: "剪切", role: "cut" }, { label: "复制", role: "copy" }, { label: "粘贴", role: "paste" }, { label: "全选", role: "selectAll" })
    else if (params.selectionText) items.push({ label: "复制", role: "copy" })
    if (params.linkURL) items.push({ label: "复制链接", click: () => clipboard.writeText(params.linkURL) }, { label: "在浏览器中打开", click: () => openExternal(params.linkURL) })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow })
  })
}

function createTray() {
  tray = new Tray(ICON)
  tray.setToolTip(APP_NAME)
  createTrayMenu()
  tray.on("click", showWindow)
}

function createTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: server?.version ? `后端 ${server.label || server.version}` : server ? "复用外部 Pi Web 服务" : APP_NAME, enabled: false },
    { label: `显示 ${APP_NAME}`, click: showWindow },
    { label: "在浏览器中打开", click: () => server && openExternal(server.url) },
    { label: "复制 Web 地址", click: () => server && clipboard.writeText(server.url) },
    { type: "separator" },
    { label: "缩放", submenu: [
      { label: "放大", accelerator: "Ctrl+=", click: () => setZoom(zoomFactor + 0.05) },
      { label: "缩小", accelerator: "Ctrl+-", click: () => setZoom(zoomFactor - 0.05) },
      { label: "100%", accelerator: "Ctrl+0", click: () => setZoom(1) },
      { label: "125%", click: () => setZoom(1.25) },
    ] },
    { label: "打开日志目录", click: () => shell.openPath(USER_DATA_DIR) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]))
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function setZoom(value) {
  zoomFactor = Math.min(2, Math.max(0.75, Number(value.toFixed(2))))
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(zoomFactor)
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch((error) => log("Cannot open browser", error))
}

function showFatalError(error) {
  log("Fatal error", error)
  if (!quitting) dialog.showErrorBox(APP_NAME, `${error.message || error}\n\n日志：${path.join(USER_DATA_DIR, "launcher.log")}`)
  app.quit()
}

function log(message, error) {
  const line = `[${new Date().toISOString()}] ${message}${error ? ` ${error.stack || error}` : ""}\n`
  console.log(line.trimEnd())
  try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); fs.appendFileSync(path.join(USER_DATA_DIR, "launcher.log"), line, "utf8") } catch {}
}
