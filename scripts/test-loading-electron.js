// Offline visual/accessibility smoke test. No backend or real user data involved.
const { app, BrowserWindow, nativeTheme } = require("electron")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loading-ui-"))
app.setPath("userData", profile)
app.disableHardwareAcceleration()
let win
const timer = setTimeout(() => { console.error("FAIL: loading UI test timed out"); app.exit(1) }, 30_000)

async function main() {
  await app.whenReady()
  win = new BrowserWindow({ show: false, width: 1280, height: 860,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const externalRequests = []
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) { externalRequests.push(details.url); callback({ cancel: true }) }
    else callback({})
  })
  const output = path.resolve(__dirname, "../.build")
  fs.mkdirSync(output, { recursive: true })
  const screenshots = []
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme
    await win.loadFile(path.resolve(__dirname, "../assets/loading.html"))
    await new Promise(resolve => setTimeout(resolve, 650)) // Let the entrance animation finish for the snapshot.
    const info = await win.webContents.executeJavaScript(`({
      title: document.title, phase: document.body.dataset.phase,
      overflow: document.documentElement.scrollWidth > innerWidth,
      icons: [...document.images].every(i => i.complete && i.naturalWidth > 0),
      status: document.querySelector('[role="status"]').textContent.trim(),
      scripts: document.scripts.length, background: getComputedStyle(document.body).backgroundColor,
      fakePercentage: document.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'),
    })`)
    assert.equal(info.title, "Pi Web Launcher")
    assert.equal(info.phase, "environment")
    assert.equal(info.overflow, false)
    assert.equal(info.icons, true)
    assert.equal(info.scripts, 0)
    assert.equal(info.fakePercentage, false)
    assert.match(info.status, /运行环境/)
    assert.equal(info.background, theme === "light" ? "rgb(245, 245, 243)" : "rgb(20, 21, 24)")
    try {
      const screenshot = await win.webContents.capturePage()
      assert.ok(!screenshot.isEmpty())
      const file = path.join(output, `loading-${theme}.png`)
      fs.writeFileSync(file, screenshot.toPNG())
      screenshots.push(file)
    } catch (error) { console.warn(`SKIP: optional ${theme} screenshot (${error.message})`) }
  }
  win.webContents.debugger.attach("1.3")
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('.spinner')).animationName"), "none")
  assert.deepEqual(externalRequests, [])
  console.log(JSON.stringify({ result: "PASS", themes: ["light", "dark"], offline: true, reducedMotion: true, screenshots }))
}
main().then(() => finish(0)).catch(error => { console.error(error); finish(1) })
function finish(code) {
  clearTimeout(timer)
  win?.destroy()
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  app.exit(code)
}
