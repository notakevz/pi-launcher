const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { test } = require("node:test")
const { installerName, stageInstaller, checksumInstaller } = require("./stage-installer")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stage-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, "nsis"), destination = path.join(root, "dist")
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, "Pi Launcher_0.1.0_x64-setup.exe"), Buffer.from([0x4d, 0x5a, 0, 255]))
  fs.writeFileSync(path.join(source, "debug.txt"), "must not be staged")
  return { source, destination, version: "0.1.0" }
}

test("local checksum stays beside the native installer and updates in place without copying it", t => {
  const f = fixture(t)
  const name = checksumInstaller(f)
  assert.equal(name, "Pi Launcher_0.1.0_x64-setup.exe")
  assert.equal(fs.existsSync(f.destination), false)
  assert.equal(fs.readdirSync(f.source).filter(file => file.endsWith(".exe")).length, 1)
  const bytes = Buffer.from("MZnewer-local-build")
  fs.writeFileSync(path.join(f.source, name), bytes)
  checksumInstaller(f)
  assert.equal(fs.readFileSync(path.join(f.source, "SHA256SUMS.txt"), "utf8"), `${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)
  assert.equal(fs.existsSync(f.destination), false)
})

test("stages only one renamed ASCII installer and its matching SHA256SUMS", t => {
  const f = fixture(t), name = stageInstaller(f)
  assert.equal(name, "pi-launcher-0.1.0-x64-setup.exe")
  assert.deepEqual(fs.readdirSync(f.destination).sort(), ["SHA256SUMS.txt", name])
  const bytes = fs.readFileSync(path.join(f.destination, name))
  const hash = crypto.createHash("sha256").update(bytes).digest("hex")
  assert.equal(fs.readFileSync(path.join(f.destination, "SHA256SUMS.txt"), "utf8"), `${hash}  ${name}\n`)
  assert.ok(fs.existsSync(path.join(f.source, "Pi Launcher_0.1.0_x64-setup.exe")))
})
test("existing dist is never replaced, even when empty", t => {
  const f = fixture(t)
  fs.mkdirSync(f.destination)
  assert.throws(() => stageInstaller(f), /EEXIST/)
  assert.deepEqual(fs.readdirSync(f.destination), [])
})
test("ambiguous or non-executable NSIS outputs fail without creating dist", t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.source, "second.exe"), "MZfake")
  assert.throws(() => stageInstaller(f), /exactly one/)
  fs.unlinkSync(path.join(f.source, "second.exe"))
  fs.writeFileSync(path.join(f.source, "Pi Launcher_0.1.0_x64-setup.exe"), "not an exe")
  assert.throws(() => stageInstaller(f), /MZ/)
  fs.unlinkSync(path.join(f.source, "Pi Launcher_0.1.0_x64-setup.exe"))
  assert.throws(() => stageInstaller(f), /exactly one/)
  assert.equal(fs.existsSync(f.destination), false)
})
test("rejects a lone stale version or wrong architecture instead of relabeling it", async t => {
  for (const name of ["Pi Launcher_0.0.1_x64-setup.exe", "Pi Launcher_0.1.0_arm64-setup.exe", "Pi Launcher_0.1.0_x86-setup.exe", "Other_0.1.0_x64-setup.exe"]) await t.test(name, t => {
    const f = fixture(t)
    fs.renameSync(path.join(f.source, "Pi Launcher_0.1.0_x64-setup.exe"), path.join(f.source, name))
    assert.throws(() => stageInstaller(f), /current-version x64/)
    assert.equal(fs.existsSync(f.destination), false)
  })
})
test("rejects installer versions that could escape or destabilize asset names", () => {
  for (const version of [undefined, "../bad", "0.1.0/evil", "0.1.0+build", "0.1.0\n"]) assert.throws(() => installerName(version), /Unsafe/)
})

test("NSIS uses the pinned ownership-safe template, never the default unconditional Run cleanup", () => {
  const root = path.resolve(__dirname, "..")
  const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  assert.equal(config.bundle.windows.nsis.template, "./nsis/installer.nsi")
  assert.equal(config.bundle.windows.nsis.installerHooks, "./nsis/hooks.nsh")
  const template = fs.readFileSync(path.join(root, "src-tauri/nsis/installer.nsi"), "utf8")
  assert.doesNotMatch(template, /DeleteRegValue\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/)
  assert.match(template, /!insertmacro NSIS_HOOK_PREUNINSTALL/)
  const hooks = fs.readFileSync(path.join(root, "src-tauri/nsis/hooks.nsh"), "utf8")
  assert.match(hooks, /\$UpdateMode <> 1/)
  assert.ok(hooks.includes('${If} $R0 == \'$\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\"\''))
  assert.equal((hooks.match(/DeleteRegValue/g) || []).length, 1)
  const cli = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies["@tauri-apps/cli"]
  assert.equal(cli, "2.12.4", "audit the vendored template when upgrading CLI")
})
