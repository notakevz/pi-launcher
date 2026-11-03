// Real Electron/Chromium menu check: the source build's own plan/build/full client.
const { app, BrowserWindow } = require("electron")
const assert = require("node:assert/strict")
const path = require("node:path")

const url = process.argv.find(arg => arg.startsWith("--url="))?.slice(6)
const profile = process.argv.find(arg => arg.startsWith("--profile="))?.slice(10)
if (!url || !profile) throw new Error("--url and --profile are required")

app.setPath("userData", profile)
let window
const timer = setTimeout(() => { console.error("Electron source UI test timed out"); app.exit(1) }, 45_000)

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1280, height: 860,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  await window.webContents.session.setProxy({ mode: "direct" })
  await window.loadURL(url)
  await window.webContents.executeJavaScript("localStorage.setItem('launcher-source-sentinel','kept')")
  let opened = false
  for (let attempt = 0; attempt < 60 && !opened; attempt++) {
    opened = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'build');
      if (!button) return false; button.click(); return true;
    })()`)
    if (!opened) await new Promise(resolve => setTimeout(resolve, 300))
  }
  if (!opened) throw new Error(`Build must be the fresh-composer default: ${await window.webContents.executeJavaScript("document.body.innerText.slice(0,3000)")}`)
  const cwd = new URL(url).searchParams.get("cwd")
  const expectedTitle = cwd ? `${path.basename(cwd)} - Pi Web` : "Pi Web"
  let title
  for (let i = 0; i < 30; i++) {
    title = await window.webContents.executeJavaScript("document.title")
    if (title === expectedTitle) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(title, expectedTitle)
  console.log(`PASS: the browser tab title is ${title}; fresh composer defaults to Build`)
  await new Promise(resolve => setTimeout(resolve, 200))
  const labels = await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')]
    .map(b => b.textContent.trim()).filter(t => /^(plan|build|full)(?![A-Za-z])/.test(t))`)
  const modes = [...new Set(labels.map(text => { const i = text.search(/[^a-z]/); return i < 0 ? text : text.slice(0, i) }))].sort()
  assert.deepEqual(modes, ["build", "full", "plan"], `Menu labels: ${JSON.stringify(labels)}`)
  await window.webContents.executeJavaScript("localStorage.setItem('pi-tool-preset', 'full')")
  await window.reload()
  // `/` renders entirely on the client, and the reload closes the dropdown, so wait for
  // the trigger button first and re-open the menu to re-check the three modes.
  const modeButtonCount = async () => window.webContents.executeJavaScript(`[...document.querySelectorAll('button')]
    .filter(b => /^(plan|build|full)(?![A-Za-z])/.test(b.textContent.trim())).length`)
  let afterReload = 0
  for (let attempt = 0; attempt < 60 && afterReload < 1; attempt++) {
    afterReload = await modeButtonCount()
    if (afterReload < 1) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(afterReload >= 1, "The mode control disappeared after reload")
  assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('launcher-source-sentinel')"), "kept")
  assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('pi-tool-preset')"), "full")
  assert.ok(await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'build')"), "Legacy Full preference must not change the new Build default")
  const reopened = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => /^(plan|build|full)(?![A-Za-z])/.test(b.textContent.trim()));
    if (!button) return false; button.click(); return true })()`)
  assert.ok(reopened, "The mode control could not be opened after reload")
  let afterReopen = 0
  for (let attempt = 0; attempt < 60 && afterReopen < 3; attempt++) {
    afterReopen = await modeButtonCount()
    if (afterReopen < 3) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(afterReopen >= 3, `Modes disappeared after reload (found ${afterReopen})`)
  console.log(`PASS: source UI shows only ${labels.join(' / ')} and keeps browser storage across reload`)
  clearTimeout(timer)
  app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timer); app.exit(1) })
