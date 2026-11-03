// Exercise the packaged application using real Electron/Chromium, then quit.
const assert = require("node:assert/strict")
const { app, dialog } = require("electron")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const resources = path.join(__dirname, "..", "dist", "win-unpacked", "resources")
const backendRoot = require("./integration-prerequisites").integrationBackend()
const release = JSON.parse(fs.readFileSync(path.join(backendRoot, "source-release.json"), "utf8"))
if (fs.existsSync(path.join(resources, "source-backend"))) throw new Error("The entry-only package must not bundle a backend")

// Never adopt/stop the user's current server or write to their Electron profile.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-packaged-smoke-"))
const stateDir = path.join(profile, "Pi Agent Launcher")
fs.mkdirSync(stateDir)
fs.mkdirSync(path.join(profile, "workspace"))
// The application must launch this external artifact directly, without staging it.
process.env.PI_AGENT_LAUNCHER_BACKEND_PATH = backendRoot
app.setPath("appData", profile)
process.env.PI_AGENT_LAUNCHER_DATA_DIR = stateDir
process.env.PI_AGENT_LAUNCHER_PORT = "30145"
process.env.PI_AGENT_LAUNCHER_CWD = path.join(profile, "workspace")
process.env.PI_AGENT_LAUNCHER_OFFLINE = "1"
process.env.PI_CODING_AGENT_DIR = path.join(profile, "agent")
// A synthetic model keeps the composer visible without copying credentials or calling a provider.
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR)
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "source-smoke", defaultModel: "smoke", cacheWarming: "off" }), "utf8")
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { "source-smoke": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-a-real-key",
  models: [{ id: "smoke", name: "Offline smoke", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }), "utf8")

app.disableHardwareAcceleration()
let tested = false
let resultCode = 1 // Fail closed: early exits and startup dialogs must never count as success.
dialog.showErrorBox = (title, message) => { console.error(`${title}: ${message}`); resultCode = 1 }
app.on("will-quit", () => {
  clearTimeout(timeout)
  if (!tested) console.error("FAIL: the packaged Web UI never became ready")
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
  if (resultCode) app.exit(resultCode)
})
const timeout = setTimeout(() => { resultCode = 1; console.error("Desktop smoke test timed out"); app.quit() }, 240_000)
app.on("browser-window-created", (_event, win) => {
  win.webContents.on("did-finish-load", async () => {
    if (tested || !win.webContents.getURL().startsWith("http://127.0.0.1:")) return
    // A fresh profile has no selected project. Select our temporary workspace before
    // expecting a composer, just as a user would; the home screen has no mode control.
    if (!new URL(win.webContents.getURL()).searchParams.has("cwd")) {
      // Let main.js finish awaiting its initial navigation before starting another.
      setTimeout(() => {
        win.loadURL(`http://127.0.0.1:30145/?cwd=${encodeURIComponent(path.join(profile, "workspace"))}`)
          .catch(error => { console.error(error); resultCode = 1; app.quit() })
      }, 100)
      return
    }
    tested = true
    try {
      let summary
      for (let i = 0; i < 50; i++) {
        summary = await win.webContents.executeJavaScript("({title:document.title, text:document.body.innerText.slice(0,1500), buttons:document.querySelectorAll('button').length})")
        if (summary.buttons >= 3) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      assert.ok(summary.buttons >= 3, "The real Web UI must render its controls")
      assert.equal(win.getTitle(), "Pi Launcher")
      assert.equal(app.getName(), "Pi Launcher")
      const record = JSON.parse(fs.readFileSync(path.join(stateDir, "pi-web-30145.json"), "utf8"))
      assert.equal(record.version, release.version)
      assert.equal(record.entry, path.join(backendRoot, "bin", "pi-web.js"))
      assert.ok(!fs.existsSync(path.join(stateDir, "source-backends")))
      assert.ok(!fs.existsSync(path.join(stateDir, "source-backend-version.json")))
      let menu = false
      for (let i = 0; i < 60 && !menu; i++) {
        menu = await win.webContents.executeJavaScript(`(() => {
          const control = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'build');
          if (!control) return false; control.click(); return true;
        })()`)
        if (!menu) await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.ok(menu, `Fresh composer must default to Build: ${await win.webContents.executeJavaScript("document.body.innerText.slice(0,1800)")}`)
      await new Promise(resolve => setTimeout(resolve, 200))
      const modes = await win.webContents.executeJavaScript(`[...new Set([...document.querySelectorAll('button')]
        .map(b => b.textContent.trim().match(/^(plan|build|full)(?![A-Za-z])/))
        .filter(Boolean).map(m => m[1]))].sort()`)
      assert.deepEqual(modes, ["build", "full", "plan"])
      await new Promise((resolve) => setTimeout(resolve, 500))
      let output
      try {
        const screenshot = await win.webContents.capturePage()
        output = path.join(__dirname, "../.build/pi-agent-launcher-smoke.png")
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, screenshot.toPNG())
      } catch (error) {
        // Screen capture can be unavailable under RDP/software rendering; DOM/lifecycle
        // assertions remain mandatory and the missing screenshot is explicitly reported.
        console.warn(`SKIP: optional screenshot (${error.message || error})`)
      }
      win.close()
      assert.equal(win.isVisible(), false)
      app.emit("second-instance")
      assert.equal(win.isVisible(), true)
      resultCode = 0
      console.log(JSON.stringify({ result: "PASS", release: release.id, title: win.getTitle(), modes, buttons: summary.buttons, screenshot: output }))
    } catch (error) {
      console.error(error)
      resultCode = 1
    } finally {
      clearTimeout(timeout)
      app.quit()
    }
  })
})

require("../src/backend").isPortFree(30145).then(free => {
  if (!free) throw new Error("Integration prerequisite: port 30145 must be free; no existing process was stopped")
  require(path.join(resources, "app.asar", "src", "main.js"))
}).catch(error => { console.error(error.message); app.quit() })
