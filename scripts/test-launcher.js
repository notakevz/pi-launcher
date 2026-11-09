const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const os = require("node:os")
const { PiBackend, isPortFree, checkServer, delay } = require("../src/backend")

async function runLauncher(profile, port) {
  let ready, exited
  const loaded = new Promise((resolve) => { ready = resolve })
  const quit = new Promise((resolve) => { exited = resolve })
  const app = new EventEmitter()
  Object.assign(app, {
    getPath: () => profile, setPath: () => {}, setAppUserModelId: () => {},
    setName: name => { app.name = name },
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quit: () => {
      let prevented = false
      app.emit("before-quit", { preventDefault: () => { prevented = true } })
      if (!prevented) exited()
    },
  })
  let window, menu, tray
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      window = this
      this.options = options
      this.title = options.title
      this.webContents = new EventEmitter()
      this.webContents.session = { setProxy: async () => {} }
      this.webContents.setWindowOpenHandler = () => {}
      this.webContents.setZoomFactor = () => {}
      this.startupScripts = []
      this.webContents.executeJavaScript = async script => { this.startupScripts.push(script) }
      this.progress = []
    }
    isDestroyed() { return false }
    isMinimized() { return false }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus() { this.focused = true }
    setTitle(title) { this.title = title }
    setProgressBar(value) { this.progress.push(value) }
    loadFile(file) { this.loadingFile = file; return Promise.resolve() }
    loadURL(url) { if (url.startsWith("http:")) ready({ url, window: this }); return Promise.resolve() }
  }
  class Tray extends EventEmitter {
    constructor(icon) { super(); tray = this; this.icon = icon }
    setToolTip(text) { this.tooltip = text }
    setContextMenu(value) { menu = value }
  }
  const electron = {
    app, BrowserWindow, Tray, nativeTheme: { shouldUseDarkColors: false }, Menu: { buildFromTemplate: (value) => value },
    dialog: { showErrorBox: (_title, message) => ready({ error: message }) },
    shell: { openExternal: async () => {}, openPath: async () => {} }, clipboard: { writeText: () => {} },
  }
  process.env.PI_LAUNCHER_PORT = String(port)
  process.env.PI_LAUNCHER_DATA_DIR = path.join(profile, "Pi Launcher")
  const original = Module._load
  Module._load = function (name, ...args) { return name === "electron" ? electron : original.call(this, name, ...args) }
  try {
    const main = require.resolve("../src/main")
    delete require.cache[main]
    require(main)
  } finally { Module._load = original }
  const result = await Promise.race([loaded, new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Launcher startup timed out")), 60_000).unref()
  })])
  return { ...result, app, tray, quit, menu: () => menu, quitFromTray: () => menu.find((item) => item.label === "退出").click() }
}

async function main() {
  require("./integration-prerequisites").integrationBackend()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-test-"))
  const originalCwd = process.env.PI_LAUNCHER_CWD
  process.env.PI_LAUNCHER_CWD = profile
  const stateDir = path.join(profile, "Pi Launcher")
  const port = 30143
  let launcher, backend, external
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = path.join(profile, "agent")
  try {
    backend = new PiBackend({ cwd: profile, stateDir })
    await backend.ensureAvailable()
    assert.ok(await isPortFree(port), `Refusing to touch occupied port ${port}`)
    launcher = await runLauncher(profile, port)
    assert.equal(launcher.error, undefined)
    assert.equal(launcher.url, `http://127.0.0.1:${port}`)
    await delay(20)
    assert.ok(!launcher.menu().some(item => /更新|缓存/.test(item.label || "")))
    assert.equal(launcher.app.name, "Pi Launcher")
    assert.equal(launcher.window.title, "Pi Launcher")
    assert.equal(launcher.window.options.icon, path.resolve(__dirname, "../assets/icon.ico"))
    assert.equal(launcher.tray.icon, launcher.window.options.icon)
    assert.equal(launcher.tray.tooltip, "Pi Launcher")
    assert.ok(launcher.menu().some(item => item.label === "显示 Pi Launcher"))
    let titlePrevented = false
    launcher.window.webContents.emit("page-title-updated", { preventDefault: () => { titlePrevented = true } }, "project - Pi Web")
    assert.ok(titlePrevented)
    assert.equal(launcher.window.title, "Pi Launcher")
    const pkg = require("../package.json")
    assert.equal(pkg.build.productName, "Pi Launcher")
    assert.equal(pkg.build.nsis.shortcutName, "Pi Launcher")
    for (const icon of [pkg.build.win.icon, pkg.build.nsis.installerIcon, pkg.build.nsis.uninstallerIcon]) {
      assert.equal(icon, "assets/icon.ico")
      assert.ok(fs.existsSync(path.resolve(__dirname, "..", icon)))
    }
    assert.equal(path.basename(launcher.window.loadingFile), "loading.html")
    for (const phase of ["environment", "backend", "workspace"]) assert.ok(launcher.window.startupScripts.some(script => script.includes(`\"phase\":\"${phase}\"`)))
    assert.deepEqual(launcher.window.progress, [2, -1])
    let prevented = false
    launcher.window.emit("close", { preventDefault: () => { prevented = true } })
    assert.ok(prevented)
    assert.equal(launcher.window.visible, false)
    launcher.app.emit("second-instance")
    assert.equal(launcher.window.visible, true)
    assert.equal(launcher.window.focused, true)
    launcher.quitFromTray()
    await launcher.quit
    for (let i = 0; i < 25 && !(await isPortFree(port)); i++) await delay(200)
    assert.ok(await isPortFree(port))

    const externalBackend = new PiBackend({ cwd: backend.cwd, stateDir: path.join(profile, "external") })
    await externalBackend.ensureAvailable()
    external = { backend: externalBackend, server: await externalBackend.start(port) }
    launcher = await runLauncher(profile, port)
    assert.equal(launcher.error, undefined)
    launcher.quitFromTray()
    await launcher.quit
    assert.ok(await checkServer(external.server.url))
    console.log("PASS: Launcher startup, close-to-tray, second-instance focus, owned-server Quit and external-server reuse")
  } finally {
    if (launcher) { launcher.app.quit(); await launcher.quit }
    if (external) await external.backend.stop(port, external.server.info)
    await backend?.close()
    delete process.env.PI_LAUNCHER_DATA_DIR
    delete process.env.PI_LAUNCHER_PORT
    if (originalCwd === undefined) delete process.env.PI_LAUNCHER_CWD
    else process.env.PI_LAUNCHER_CWD = originalCwd
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
