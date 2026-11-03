const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { backendPath: configuredBackendPath, inspectBackend } = require("../src/local-backend")
const backendPath = (root, env) => configuredBackendPath(root, { PI_AGENT_LAUNCHER_CWD: root, ...env })
const { PiBackend, resolveRuntime, serverEnvironment, backendArguments, commandHasPath } = require("../src/backend")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-unit-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}
function backendFixture(root) {
  const files = { "package.json": JSON.stringify({ name: "@agegr/pi-web", version: "0.12.1" }),
    "bin/pi-web.js": "// entry", ".next/BUILD_ID": "test", "node_modules/next/package.json": "{}",
    "node_modules/@earendil-works/pi-coding-agent/package.json": "{}",
    "source-release.json": JSON.stringify({ version: "0.12.1", commit: "a".repeat(40) }) }
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value, "utf8")
  }
}

test("missing backend has no personal-path fallback and gives manual configuration instructions", async t => {
  await assert.rejects(backendPath(fixture(t), {}), /未配置 backendPath.*手动构建.*不会自动下载/)
})
test("explicit environment path overrides user config", async t => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, "launcher-config.json"), JSON.stringify({ backendPath: path.join(root, "config") }), "utf8")
  assert.equal(await backendPath(root, {}), path.join(root, "config"))
  assert.equal(await backendPath(root, { PI_AGENT_LAUNCHER_BACKEND_PATH: path.join(root, "env") }), path.join(root, "env"))
})
test("bad configuration fails clearly instead of downloading or selecting a fallback", async t => {
  const root = fixture(t)
  await assert.rejects(backendPath(root, { PI_AGENT_LAUNCHER_BACKEND_PATH: "relative" }), /绝对路径/)
  await assert.rejects(backendPath(root, { PI_AGENT_LAUNCHER_BACKEND_PATH: "" }), /绝对路径/)
  fs.writeFileSync(path.join(root, "launcher-config.json"), "{bad json", "utf8")
  await assert.rejects(backendPath(root, {}), /launcher-config/)
})
test("old automatic-update environment settings are ignored", async t => {
  const root = fixture(t)
  await assert.rejects(backendPath(root, { PI_AGENT_LAUNCHER_SOURCE_BACKEND: "missing", PI_AGENT_LAUNCHER_BACKEND: "npm",
    PI_AGENT_LAUNCHER_BACKEND_DIR: "missing", PI_AGENT_LAUNCHER_OFFLINE: "0" }), /未配置 backendPath/)
})
test("backend metadata is read in place without copying, hashing or writing version state", async t => {
  const root = fixture(t)
  backendFixture(root)
  const before = fs.readdirSync(root).sort()
  const spec = await inspectBackend(root)
  assert.equal(spec.version, "0.12.1")
  assert.equal(spec.entry, path.join(root, "bin/pi-web.js"))
  assert.match(spec.label, /0\.12\.1 @ a{12}/)
  assert.deepEqual(fs.readdirSync(root).sort(), before)
})
test("a source manifest is optional for a manually built backend", async t => {
  const root = fixture(t)
  backendFixture(root)
  fs.rmSync(path.join(root, "source-release.json"))
  assert.equal((await inspectBackend(root)).label, "0.12.1")
})
test("an incomplete backend gives manual-build instructions and is not repaired", async t => {
  const root = fixture(t)
  backendFixture(root)
  fs.rmSync(path.join(root, ".next/BUILD_ID"))
  await assert.rejects(inspectBackend(root), /请手动构建.*启动器不会自动下载或修复/s)
  assert.equal(fs.existsSync(path.join(root, ".next/BUILD_ID")), false)
})
test("application startup requires only Node, not npm/npx", () => {
  const env = { PI_AGENT_LAUNCHER_NODE: process.execPath, PI_AGENT_LAUNCHER_NPX: "Z:\\missing-npx-cli.js" }
  assert.equal(resolveRuntime(env).node, fs.realpathSync(process.execPath))
  assert.equal(resolveRuntime(env).npx, undefined)
  assert.throws(() => resolveRuntime(env, true), /手动构建需要 npm/)
})
test("backend arguments invoke the configured CLI directly, with no launcher bootstrap", () => {
  const entry = "D:\\backend with spaces\\bin\\pi-web.js"
  assert.deepEqual(backendArguments(30141, entry), [entry, "--hostname", "127.0.0.1", "--port", "30141", "--no-open"])
  assert.ok(commandHasPath(`node "${entry}" --port 30141`, entry))
  assert.ok(!commandHasPath(`node "${entry}.evil" --port 30141`, entry))
})
test("proxy policy and npm context are sanitized without changing user configuration", () => {
  const env = serverEnvironment({ HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "intranet", npm_package_name: "parent",
    npm_config_cache: "keep-cache", ELECTRON_RUN_AS_NODE: "1", PI_AGENT_LAUNCHER_BACKEND_DIR: "old-staging" })
  assert.ok(env.NO_PROXY.includes("intranet") && env.NO_PROXY.includes("127.0.0.1"))
  assert.equal(env.PI_WEB_SKIP_VERSION_CHECK, "1")
  assert.equal(env.npm_package_name, undefined)
  assert.equal(env.npm_config_cache, "keep-cache")
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.PI_AGENT_LAUNCHER_BACKEND_DIR, undefined)
  const disabled = serverEnvironment({ PI_AGENT_LAUNCHER_PROXY_URL: "", ALL_PROXY: "socks5://elsewhere" })
  assert.equal(disabled.HTTP_PROXY, undefined)
  assert.equal(disabled.ALL_PROXY, undefined)
})
test("ownership requires exact executable, entry token and port", t => {
  const root = fixture(t), backend = new PiBackend({ cwd: root, stateDir: root })
  backend.node = process.execPath
  const entry = path.join(root, "bin/pi-web.js")
  const info = { executable: process.execPath, commandLine: `"${process.execPath}" "${entry}" --port 30141` }
  assert.ok(backend.isServerProcess(info, 30141, entry))
  assert.ok(!backend.isServerProcess(info, 30142, entry))
  assert.ok(!backend.isServerProcess(info, 30141, entry + "-other"))
})
test("packaging includes no backend, updater, patcher or private cache", () => {
  const pkg = require("../package.json")
  assert.equal(pkg.build.extraResources, undefined)
  assert.equal(pkg.build.afterPack, undefined)
  assert.equal(pkg.scripts.predist, undefined)
  for (const file of ["src/main.js", "src/backend.js", "src/local-backend.js", "src/process-tools.js"]) assert.ok(pkg.build.files.includes(file) || pkg.build.files.includes("src/**/*"))
  assert.ok(!("rollback:source" in pkg.scripts))
})
