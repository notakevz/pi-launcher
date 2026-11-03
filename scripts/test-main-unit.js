// Error handling/single-instance regression without loading Electron or a backend.
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { readLauncherConfig } = require("../src/local-backend")

test("configuration errors are caught after the Electron single-instance lock", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-main-unit-"))
  const saved = { ...process.env }
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_AGENT_LAUNCHER_")) delete process.env[key]
  process.env.PI_AGENT_LAUNCHER_DATA_DIR = root
  process.env.PI_AGENT_LAUNCHER_CWD = root
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
