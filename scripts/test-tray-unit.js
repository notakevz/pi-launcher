// Browser-free tray behavior tests; no Tauri, Windows registry or real clipboard.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")

function fixture({ throwOnOpen = false } = {}) {
  const elements = new Map(), handlers = {}, opened = []
  let now = 1000
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, attributes: {}, textContent: "", disabled: false,
      setAttribute(key, value) { this.attributes[key] = value },
    })
    return elements.get(id)
  }
  const window = { open(url, target) {
    if (throwOnOpen) throw new Error("synthetic popup failure")
    opened.push({ url, target })
    return null // Native handler denies the new popup; this is not a failure.
  } }
  const document = {
    getElementById: element,
    addEventListener(event, handler) { handlers[event] = handler },
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../ui/tray.js"), "utf8"), { window, document, performance: { now: () => now } })
  const click = (target, detail = 1) => handlers.click({ detail, target: { closest() { return target } } })
  return { element, window, handlers, opened, click, advance(ms) { now += ms } }
}

for (const enabled of [false, true]) test(`autostart renders the actual ${enabled ? "enabled" : "disabled"} registration`, () => {
  const f = fixture()
  f.window.__setTrayState({ ready: true, autostart: { enabled, error: null } })
  assert.equal(f.element("action-autostart").disabled, false)
  assert.equal(f.element("action-autostart").attributes["aria-checked"], String(enabled))
  assert.equal(f.element("action-autostart").title, enabled ? "关闭开机自启" : "开启开机自启")
  assert.equal(f.element("autostart-status").textContent, "", "no explanatory footnote")
  assert.equal(f.opened.length, 0, "state rendering must never register startup")
})

test("unknown or absent autostart state is not presented as disabled or clickable", () => {
  const f = fixture()
  for (const state of [{}, { autostart: { enabled: null, error: "读取失败" } }]) {
    f.window.__setTrayState(state)
    assert.equal(f.element("action-autostart").disabled, true)
    assert.equal(f.element("action-autostart").attributes["aria-checked"], "mixed")
    assert.ok(f.element("action-autostart").title)
    assert.notEqual(f.element("action-autostart").title, "开启开机自启")
  }
  assert.equal(f.element("autostart-status").textContent, "读取失败")
  const button = f.element("action-autostart")
  button.dataset.action = "autostart-toggle"
  f.click(button)
  assert.equal(f.opened.length, 0)
})

test("tray markup has no zoom controls or visible autostart footnote", () => {
  const html = fs.readFileSync(path.join(__dirname, "../ui/tray.html"), "utf8")
  assert.doesNotMatch(html, /data-action="zoom-|id="zoom-value"|class="zoom"/)
  const button = html.match(/<button[^>]*id="action-autostart"[^>]*>[\s\S]*?<\/button>/)[0]
  assert.match(button, /role="menuitemcheckbox"/)
  assert.match(button, /<span class="label">开机自启<\/span>\s*<span class="switch" aria-hidden="true"><\/span>/)
  assert.doesNotMatch(button, /autostart-value|已开启|已关闭|状态未知/)
  assert.match(html, /class="sr-only" id="autostart-status"/)
  assert.match(html, /aria-checked="true"\] \.switch::after/)
  assert.match(html, /\.card\s*\{\s*max-height: 100%;/)
})

test("autostart is single-flight and waits for the native verified result", () => {
  const f = fixture()
  f.window.__setTrayState({ autostart: { enabled: false } })
  const button = f.element("action-autostart")
  button.dataset.action = "autostart-toggle"
  f.click(button)
  f.click(button)
  assert.deepEqual(f.opened, [{ url: "https://pi-launcher.tray/autostart-toggle", target: "_blank" }])
  assert.equal(button.disabled, true)
  assert.equal(button.attributes["aria-checked"], "false", "no optimistic success")
  f.window.__setTrayState({ autostart: { enabled: false, error: "写入失败" } })
  assert.equal(button.disabled, false)
  assert.equal(button.attributes["aria-checked"], "false")
  assert.equal(f.element("autostart-status").textContent, "写入失败")
})

test("fast native replies do not turn a double click into two toggles", () => {
  const f = fixture()
  const button = f.element("action-autostart")
  button.dataset.action = "autostart-toggle"
  f.window.__setTrayState({ autostart: { enabled: false } })
  f.click(button)
  f.window.__setTrayState({ autostart: { enabled: true } })
  assert.equal(button.disabled, false, "simulate the native reply before click two")
  f.advance(100)
  f.click(button, 2)
  f.click(button, 1) // also guard a reset click count after native disable/re-enable
  assert.equal(f.opened.length, 1)
  assert.equal(button.attributes["aria-checked"], "true")
  f.advance(600)
  f.click(button, 1)
  assert.equal(f.opened.length, 2, "a later deliberate click is still accepted")
})

test("a failed signal restores the switch and shows an error", () => {
  const f = fixture({ throwOnOpen: true })
  f.window.__setTrayState({ autostart: { enabled: false } })
  const button = f.element("action-autostart")
  button.dataset.action = "autostart-toggle"
  f.click(button)
  assert.equal(button.disabled, false)
  assert.equal(button.attributes["aria-checked"], "false")
  assert.match(f.element("autostart-status").textContent, /无法发送/)
})

test("backend readiness only disables backend actions, not a readable startup switch", () => {
  const f = fixture()
  f.window.__setTrayState({ ready: false, autostart: { enabled: false } })
  assert.equal(f.element("action-browser").disabled, true)
  assert.equal(f.element("action-copy").disabled, true)
  assert.equal(f.element("action-autostart").disabled, false)
  let prevented = false
  f.handlers.keydown({ key: "Escape", preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(f.opened[0].url, "https://pi-launcher.tray/dismiss")
})
