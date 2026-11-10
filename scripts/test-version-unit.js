const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { checkVersion } = require("./check-version")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-version-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "src-tauri"))
  const write = (file, value) => fs.writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value))
  write("package.json", { name: "pi-launcher-tauri", version: "0.1.0" })
  write("package-lock.json", { name: "pi-launcher-tauri", version: "0.1.0", packages: { "": { name: "pi-launcher-tauri", version: "0.1.0" } } })
  write("src-tauri/Cargo.toml", '[package]\nname = "pi-launcher-tauri"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n')
  write("src-tauri/Cargo.lock", 'version = 4\n\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "pi-launcher-tauri"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n')
  write("src-tauri/tauri.conf.json", { version: "0.1.0" })
  return { root, write }
}

test("checks only the application's Cargo.lock entry and never rewrites files", t => {
  const f = fixture(t)
  const before = fs.readFileSync(path.join(f.root, "src-tauri/Cargo.lock"), "utf8")
  assert.equal(checkVersion(f.root), "0.1.0")
  assert.equal(fs.readFileSync(path.join(f.root, "src-tauri/Cargo.lock"), "utf8"), before)
})

test("every package, lock and explicit Tauri version must agree", async t => {
  const changes = {
    "npm lock top level": f => f.write("package-lock.json", { name: "pi-launcher-tauri", version: "0.0.1", packages: { "": { name: "pi-launcher-tauri", version: "0.1.0" } } }),
    "npm lock package": f => f.write("package-lock.json", { name: "pi-launcher-tauri", version: "0.1.0", packages: { "": { name: "pi-launcher-tauri", version: "0.0.1" } } }),
    "Cargo package": f => f.write("src-tauri/Cargo.toml", '[package]\nname = "pi-launcher-tauri"\nversion = "0.0.1"\n'),
    "Cargo lock package": f => f.write("src-tauri/Cargo.lock", '[[package]]\nname = "pi-launcher-tauri"\nversion = "0.0.1"\n'),
    "Tauri version": f => f.write("src-tauri/tauri.conf.json", { version: "0.0.1" }),
    "missing Tauri version": f => f.write("src-tauri/tauri.conf.json", {}),
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, t => {
    const f = fixture(t)
    change(f)
    assert.throws(() => checkVersion(f.root), /Version mismatch/)
  })
})

test("missing application Cargo.lock entry and wrong npm root names fail closed", t => {
  const f = fixture(t)
  f.write("src-tauri/Cargo.lock", '[[package]]\nname = "other"\nversion = "0.1.0"\n')
  assert.throws(() => checkVersion(f.root), /Cargo.lock is missing/)
  const g = fixture(t)
  g.write("package-lock.json", { name: "wrong", version: "0.1.0", packages: { "": { name: "wrong", version: "0.1.0" } } })
  assert.throws(() => checkVersion(g.root), /names disagree/)
})
