// Error handling/single-instance regression without loading Electron or a backend.
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const vm = require("node:vm")
const { readLauncherConfig } = require("../src/local-backend")
const { resolveRuntime, serverEnvironment } = require("../src/backend")

const previousPrefix = ["PI", "WEB", "LAUNCHER", ""].join("_")

test("Pi Launcher identity and data paths match packaging and the loading page", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-identity-"))
  const saved = { ...process.env }
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_LAUNCHER_") || key.startsWith(previousPrefix)) delete process.env[key]
  const mockAppData = path.join(root, "app-data"), customData = path.join(root, "custom-data")
  const previousData = path.join(root, "previous-data")
  fs.mkdirSync(previousData)
  fs.writeFileSync(path.join(previousData, "keep"), "existing data")
  process.env[`${previousPrefix}DATA_DIR`] = previousData
  for (const override of [undefined, customData]) {
    if (override) process.env.PI_LAUNCHER_DATA_DIR = override
    else delete process.env.PI_LAUNCHER_DATA_DIR
    const paths = {}, app = {
      getPath(name) { assert.equal(name, "appData"); return mockAppData },
      setName(name) { this.name = name }, setPath(name, value) { paths[name] = value },
      setAppUserModelId(id) { this.id = id }, requestSingleInstanceLock: () => false, quit() {},
    }
    let backendState
    class Backend { constructor({ stateDir }) { backendState = stateDir } }
    const original = Module._load, main = require.resolve("../src/main")
    Module._load = function(name, ...args) {
      if (name === "electron") return { app }
      if (name === "./backend") return { PiBackend: Backend }
      return original.call(this, name, ...args)
    }
    try { delete require.cache[main]; require(main) }
    finally { Module._load = original; delete require.cache[main] }
    const expectedData = override || path.join(mockAppData, "Pi Launcher")
    assert.equal(app.name, "Pi Launcher")
    assert.equal(app.id, "local.pi.launcher")
    assert.deepEqual(paths, { userData: expectedData, sessionData: path.join(expectedData, "session") })
    assert.equal(backendState, expectedData)
  }
  assert.equal(fs.readFileSync(path.join(previousData, "keep"), "utf8"), "existing data")
  assert.deepEqual(fs.readdirSync(root).sort(), ["previous-data"], "identity setup never creates or migrates data")
  const pkg = require("../package.json")
  assert.equal(pkg.name, "pi-launcher")
  assert.equal(pkg.build.appId, "local.pi.launcher")
  assert.equal(pkg.build.productName, "Pi Launcher")
  assert.equal(pkg.build.nsis.shortcutName, "Pi Launcher")
  const loading = fs.readFileSync(path.join(__dirname, "../assets/loading.html"), "utf8")
  assert.match(loading, /<title>Pi Launcher<\/title>/)
  assert.match(loading, /class="brand-name">Pi Launcher<\/span>/)
})

test("tray opens the active configuration directory for default and custom data paths", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-tray-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8")
  const appData = path.join(root, "app-data")
  for (const override of [undefined, path.join(root, "custom data")]) {
    let menu, backendState
    const opened = []
    const app = {
      getPath: () => appData, setName() {}, setPath() {}, setAppUserModelId() {},
      requestSingleInstanceLock: () => false, quit() {},
    }
    class Tray extends EventEmitter {
      setToolTip() {}
      setContextMenu(value) { menu = value }
    }
    class Backend { constructor({ stateDir }) { backendState = stateDir } }
    const electron = {
      app, Tray, Menu: { buildFromTemplate: value => value },
      shell: { openPath: async directory => { opened.push(directory); return "" } },
    }
    vm.runInNewContext(`${source}\ncreateTray()`, {
      require(name) {
        if (name === "electron") return electron
        if (name === "./backend") return { PiBackend: Backend }
        return require(name)
      },
      __dirname: path.join(__dirname, "../src"),
      process: { env: override ? { PI_LAUNCHER_DATA_DIR: override } : {} },
    })
    const expected = override || path.join(appData, "Pi Launcher")
    assert.equal(backendState, expected)
    const item = menu.find(item => item.label === "打开配置文件目录")
    assert.ok(item, "configuration directory action is present in the tray menu")
    await item.click()
    assert.deepEqual(opened, [expected])
    await menu.find(item => item.label === "打开日志目录").click()
    assert.deepEqual(opened, [expected, expected], "existing log directory action is preserved")
    assert.deepEqual(fs.readdirSync(root), [], "opening directories does not create or overwrite configuration")
  }
})

test("only the new launcher environment prefix configures runtime fields, Node, npm and proxies", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-env-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const suffixes = ["BACKEND_PATH", "CWD", "PORT", "NODE", "PROXY_URL", "NO_PROXY", "STARTUP_TIMEOUT_MS", "NPX"]
  const previous = Object.fromEntries(suffixes.map(suffix => [`${previousPrefix}${suffix}`, "invalid-previous-value"]))
  const defaults = await readLauncherConfig(root, {}, { home: root })
  assert.deepEqual(await readLauncherConfig(root, previous, { home: root }), defaults, "previous prefix is not a fallback")
  const env = { ...previous, PI_LAUNCHER_BACKEND_PATH: path.join(root, "backend"), PI_LAUNCHER_CWD: root,
    PI_LAUNCHER_PORT: "32222", PI_LAUNCHER_NODE: process.execPath, PI_LAUNCHER_PROXY_URL: "http://proxy.example:8080",
    PI_LAUNCHER_NO_PROXY: "private.local", PI_LAUNCHER_STARTUP_TIMEOUT_MS: "4321" }
  const config = await readLauncherConfig(root, env, { home: root })
  assert.deepEqual(config, { ...defaults, backendPath: path.join(root, "backend"), cwd: root, port: 32222,
    nodePath: process.execPath, proxyUrl: "http://proxy.example:8080", noProxy: ["private.local"], startupTimeoutMs: 4321 })
  assert.equal(resolveRuntime(env).node, fs.realpathSync(process.execPath))
  assert.equal(serverEnvironment(previous).HTTP_PROXY, undefined)
  assert.equal(serverEnvironment(previous).NO_PROXY, "localhost,127.0.0.1,::1")
  assert.equal(serverEnvironment(env).HTTP_PROXY, config.proxyUrl)
  assert.equal(serverEnvironment(env).NO_PROXY, "private.local,localhost,127.0.0.1,::1")
  const node = path.join(root, "node.exe"), npx = path.join(root, "npx-cli.js")
  fs.writeFileSync(node, "not executed"); fs.writeFileSync(npx, "not executed")
  const runtime = { ...previous, PATH: root, ProgramFiles: root, APPDATA: root, PI_LAUNCHER_NODE: node, PI_LAUNCHER_NPX: npx }
  assert.deepEqual(resolveRuntime(runtime, true), { node: fs.realpathSync(node), npx: fs.realpathSync(npx) })
  delete runtime.PI_LAUNCHER_NPX
  runtime[`${previousPrefix}NPX`] = npx
  assert.throws(() => resolveRuntime(runtime, true), /手动构建需要 npm/)
  delete runtime.PI_LAUNCHER_NODE
  runtime.PATH = path.join(root, "missing")
  runtime[`${previousPrefix}NODE`] = node
  assert.throws(() => resolveRuntime(runtime), /找不到 Windows Node/)
})

test("configuration errors are caught after the Electron single-instance lock", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-main-unit-"))
  const saved = { ...process.env }
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_LAUNCHER_")) delete process.env[key]
  process.env.PI_LAUNCHER_DATA_DIR = root
  process.env.PI_LAUNCHER_CWD = root
  for (const [content, lock, expected] of [["{broken", false, undefined], ["{broken", true, /JSON 格式/],
    [JSON.stringify({ port: 0 }), true, /port/], [JSON.stringify({ nodePath: path.join(root, "missing") }), true, /nodePath/],
    [JSON.stringify({ proxyUrl: "private-secret-invalid" }), true, /proxyUrl/]]) {
    fs.writeFileSync(path.join(root, "launcher-config.json"), content)
    let finish, message, reads = 0
    const done = new Promise(resolve => { finish = resolve })
    const app = new EventEmitter()
    Object.assign(app, { getPath: () => root, setName() {}, setPath() {}, setAppUserModelId() {},
      requestSingleInstanceLock: () => lock, whenReady: () => Promise.resolve(),
      quit() {
        let prevented = false
        app.emit("before-quit", { preventDefault() { prevented = true } })
        if (!prevented) finish()
      } })
    class Backend {
      async ensureAvailable() { reads++; this.config = await readLauncherConfig(root, process.env, { home: root }) }
      async close() {}
    }
    const electron = { app, dialog: { showErrorBox(_title, value) { message = value } } }
    const original = Module._load
    Module._load = function(name, ...args) {
      if (name === "electron") return electron
      if (name === "./backend") return { PiBackend: Backend }
      return original.call(this, name, ...args)
    }
    const main = require.resolve("../src/main")
    try { delete require.cache[main]; require(main) }
    finally { Module._load = original; delete require.cache[main] }
    await done
    assert.equal(reads, lock ? 1 : 0)
    if (expected) assert.match(message, expected)
    else assert.equal(message, undefined)
    assert.ok(!message?.includes("private-secret-invalid"))
  }
})
