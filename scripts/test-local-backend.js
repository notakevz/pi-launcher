const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createRequire } = require("node:module")
const { test } = require("node:test")
const { backendPath: configuredBackendPath, inspectBackend } = require("../src/local-backend")
const backendPath = (root, env) => configuredBackendPath(root, { PI_AGENT_LAUNCHER_CWD: root, ...env })
const { PiBackend, resolveRuntime, serverEnvironment, backendArguments, commandHasPath } = require("../src/backend")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-unit-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}
const dependencies = ["next", "@earendil-works/pi-coding-agent"]
function dependencyFixture(root, name) {
  const directory = path.join(root, "node_modules", name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0",
    main: "index.js", exports: { ".": "./index.js" } }))
  fs.writeFileSync(path.join(directory, "index.js"), 'throw new Error("dependency code must not execute")')
}
function backendFixture(root, { dependencyRoot = root, manifest = true } = {}) {
  const files = { "package.json": JSON.stringify({ name: "@agegr/pi-web", version: "0.12.1" }),
    "bin/pi-web.js": 'throw new Error("backend code must not execute")', ".next/BUILD_ID": "test" }
  if (manifest) files["source-release.json"] = JSON.stringify({ version: "0.12.1", commit: "a".repeat(40) })
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value, "utf8")
  }
  if (dependencyRoot) for (const name of dependencies) dependencyFixture(dependencyRoot, name)
}

test("missing backend has no personal-path fallback and gives manual configuration instructions", async t => {
  await assert.rejects(backendPath(fixture(t), {}), /未配置 backendPath.*npm 安装目录或本地构建产物.*不会自动下载/)
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
test("private npm dependencies work even when SDK package.json is not exported", async t => {
  const root = fixture(t)
  backendFixture(root, { manifest: false })
  const backendRequire = createRequire(path.join(root, "package.json"))
  assert.throws(() => backendRequire.resolve("@earendil-works/pi-coding-agent/package.json"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  assert.equal((await inspectBackend(root)).label, "0.12.1")
})
test("npm installs can use dependencies hoisted to ancestor node_modules", async t => {
  const prefix = fixture(t)
  const root = path.join(prefix, "node_modules", "@agegr", "pi-web")
  backendFixture(root, { dependencyRoot: prefix, manifest: false })
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false)
  assert.equal((await inspectBackend(root)).version, "0.12.1")
})
test("backend and dependency symlinks or junctions use the real backend module paths", async t => {
  const temporary = fixture(t)
  const root = path.join(temporary, "installation", "node_modules", "@agegr", "pi-web")
  const prefix = path.join(temporary, "installation")
  backendFixture(root, { dependencyRoot: prefix, manifest: false })
  for (const name of dependencies) {
    const dependency = path.join(prefix, "node_modules", name)
    const target = path.join(temporary, "linked-dependencies", name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(dependency, target)
    fs.symlinkSync(target, dependency, "junction")
  }
  const alias = path.join(temporary, "backend-link")
  fs.symlinkSync(root, alias, "junction")
  assert.equal((await inspectBackend(alias)).entry, path.join(alias, "bin", "pi-web.js"))
})
test("each missing dependency is rejected without installation or repair", async t => {
  for (const name of dependencies) await t.test(name, async t => {
    const root = fixture(t)
    backendFixture(root)
    const dependency = path.join(root, "node_modules", name)
    fs.rmSync(dependency, { recursive: true })
    await assert.rejects(inspectBackend(root), error => error.message.includes(`缺少依赖 ${name}`))
    assert.equal(fs.existsSync(dependency), false)
  })
})
test("launcher-only dependencies cannot satisfy an unrelated backend", async t => {
  const temporary = fixture(t)
  const launcher = path.join(temporary, "launcher")
  fs.mkdirSync(path.join(launcher, "src"), { recursive: true })
  fs.mkdirSync(path.join(launcher, "config"))
  fs.copyFileSync(path.join(__dirname, "../src/local-backend.js"), path.join(launcher, "src/local-backend.js"))
  fs.copyFileSync(path.join(__dirname, "../config/launcher-defaults.json"), path.join(launcher, "config/launcher-defaults.json"))
  for (const name of dependencies) dependencyFixture(launcher, name)
  const inspect = require(path.join(launcher, "src/local-backend.js")).inspectBackend
  const root = path.join(temporary, "backend")
  backendFixture(root, { dependencyRoot: null })
  await assert.rejects(inspect(root), /缺少依赖 next/)
  dependencyFixture(root, "next")
  await assert.rejects(inspect(root), /缺少依赖 @earendil-works\/pi-coding-agent/)
})
test("dependencies must have valid metadata and matching package names", async t => {
  for (const name of dependencies) await t.test(name, async t => {
    const root = fixture(t)
    backendFixture(root)
    const metadata = path.join(root, "node_modules", name, "package.json")
    for (const value of ["{}", JSON.stringify({ name: "wrong-package" }), "null"]) {
      fs.writeFileSync(metadata, value)
      await assert.rejects(inspectBackend(root), /package.json 名称不匹配/)
    }
    fs.writeFileSync(metadata, "{bad json")
    await assert.rejects(inspectBackend(root), /npm 安装目录或本地构建产物/)
  })
})
test("source manifest remains optional and only matching valid commits are displayed", async t => {
  const root = fixture(t)
  backendFixture(root, { manifest: false })
  assert.equal((await inspectBackend(root)).label, "0.12.1")
  const file = path.join(root, "source-release.json")
  for (const manifest of [{ version: "different", commit: "a".repeat(40) }, { version: "0.12.1", commit: "invalid" }]) {
    fs.writeFileSync(file, JSON.stringify(manifest))
    assert.equal((await inspectBackend(root)).commit, undefined)
  }
  fs.writeFileSync(file, "{bad json")
  await assert.rejects(inspectBackend(root), /npm 安装目录或本地构建产物/)
})
test("an incomplete backend gives installation/build instructions and is not repaired", async t => {
  for (const relative of ["bin/pi-web.js", ".next/BUILD_ID"]) await t.test(relative, async t => {
    const root = fixture(t)
    backendFixture(root)
    fs.rmSync(path.join(root, relative))
    await assert.rejects(inspectBackend(root), /npm 安装目录或本地构建产物.*启动器不会自动下载或修复/s)
    assert.equal(fs.existsSync(path.join(root, relative)), false)
  })
})
test("backend package identity and version are still required", async t => {
  const root = fixture(t)
  backendFixture(root)
  for (const pkg of [{ name: "other", version: "0.12.1" }, { name: "@agegr/pi-web" }]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg))
    await assert.rejects(inspectBackend(root), /不是 Pi Web 后端目录/)
  }
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
