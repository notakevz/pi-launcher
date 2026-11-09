// Pure Node tests: no Electron install, native backend, user profile or live ports.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { EventEmitter } = require("node:events")
const { PassThrough } = require("node:stream")
const { test } = require("node:test")
const { readLauncherConfig } = require("../src/local-backend")
const { PiBackend, serverEnvironment } = require("../src/backend")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-unit-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const home = path.join(root, "isolated-home")
  fs.mkdirSync(home)
  return { root, home, read: env => readLauncherConfig(root, env || {}, { home }),
    write: config => fs.writeFileSync(path.join(root, "launcher-config.json"), JSON.stringify(config)) }
}

test("shipped JSON supplies safe defaults; cwd null resolves to the supplied existing home", async t => {
  const f = fixture(t), config = await f.read()
  assert.deepEqual(config, { ...require("../config/launcher-defaults.json"), cwd: f.home })
  assert.equal(config.backendPath, null)
  assert.equal(config.proxyUrl, null)
  assert.equal(fs.existsSync(path.join(f.root, "launcher-config.json")), false, "reading does not create user configuration")
})
test("all runtime fields use environment > user JSON > shipped JSON", async t => {
  const f = fixture(t)
  const user = { schemaVersion: 1, backendPath: path.join(f.root, "user-backend"), cwd: f.root,
    port: 31111, nodePath: process.execPath, proxyUrl: "http://user-proxy.example:8080", noProxy: ["user.local"], startupTimeoutMs: 1234 }
  f.write(user)
  assert.deepEqual(await f.read(), user)
  const env = { PI_LAUNCHER_BACKEND_PATH: path.join(f.root, "env-backend"), PI_LAUNCHER_CWD: f.home,
    PI_LAUNCHER_PORT: "32222", PI_LAUNCHER_NODE: process.execPath,
    PI_LAUNCHER_PROXY_URL: "", PI_LAUNCHER_NO_PROXY: "env.local, other.local", PI_LAUNCHER_STARTUP_TIMEOUT_MS: "4321" }
  assert.deepEqual(await f.read(env), { schemaVersion: 1, backendPath: env.PI_LAUNCHER_BACKEND_PATH,
    cwd: f.home, port: 32222, nodePath: process.execPath, proxyUrl: "", noProxy: ["env.local", "other.local"], startupTimeoutMs: 4321 })
  f.write({ ...user, port: "invalid", cwd: false, proxyUrl: 42 })
  assert.equal((await f.read(env)).port, 32222, "valid environment overrides invalid lower-priority values")
})
test("null paths are optional and cwd null uses home; explicit empty paths are invalid", async t => {
  const f = fixture(t)
  f.write({ cwd: null, backendPath: null, nodePath: null, proxyUrl: null })
  assert.equal((await f.read()).cwd, f.home)
  for (const key of ["cwd", "backendPath", "nodePath"]) {
    f.write({ [key]: "" })
    await assert.rejects(f.read(), /绝对路径/)
  }
})
test("configuration validates types, ranges, paths, schema and noProxy", async t => {
  const f = fixture(t)
  for (const value of [null, [], 42]) {
    f.write(value)
    await assert.rejects(f.read(), /JSON 对象/)
  }
  for (const value of [0, 65536, 1.5, "30141", null]) {
    f.write({ port: value })
    await assert.rejects(f.read(), /port.*整数/)
  }
  for (const value of [0, -1, 1.5, "60000", null, 2147483648]) {
    f.write({ startupTimeoutMs: value })
    await assert.rejects(f.read(), /startupTimeoutMs/)
  }
  for (const value of ["", "nan", "0", "65536"]) await assert.rejects(f.read({ PI_LAUNCHER_PORT: value }), /port/)
  f.write({ nodePath: path.join(f.root, "missing-node") })
  await assert.rejects(f.read(), /nodePath.*不存在/)
  f.write({ cwd: path.join(f.root, "missing-workspace") })
  await assert.rejects(f.read(), /cwd 不存在/)
  f.write({ nodePath: f.root })
  await assert.rejects(f.read(), /nodePath/)
  f.write({ backendPath: "relative" })
  await assert.rejects(f.read(), /backendPath.*绝对路径/)
  f.write({ schemaVersion: 2 })
  await assert.rejects(f.read(), /schemaVersion/)
  for (const value of [null, "domain", [42], ["a,b"], ["a\nb"]]) {
    f.write({ noProxy: value })
    await assert.rejects(f.read(), /noProxy/)
  }
})
test("invalid JSON and proxy diagnostics never echo credentials", async t => {
  const f = fixture(t), secret = "private-password"
  fs.writeFileSync(path.join(f.root, "launcher-config.json"), `{"proxyUrl":"http://user:${secret}@proxy",broken`)
  await assert.rejects(f.read(), error => /launcher-config/.test(error.message) && !error.message.includes(secret))
  for (const value of [42, false, "socks5://proxy.example:1080", "ftp://user:private-password@proxy", "http://user:private-password@", "http://proxy/path"]) {
    f.write({ proxyUrl: value })
    await assert.rejects(f.read(), error => /proxyUrl/.test(error.message) && !error.message.includes(secret))
  }
  assert.throws(() => serverEnvironment({ HTTPS_PROXY: "bad-private-password" }), error => !error.message.includes(secret))
})
test("proxy policy inherits only existing environment or stays direct; empty override disables all", () => {
  const direct = serverEnvironment({})
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) assert.equal(direct[key], undefined)
  assert.equal(direct.NO_PROXY, "localhost,127.0.0.1,::1")
  const inherited = serverEnvironment({ https_proxy: "http://proxy.example:8080", NO_PROXY: "intranet" })
  assert.equal(inherited.HTTPS_PROXY, "http://proxy.example:8080")
  const socks = serverEnvironment({ ALL_PROXY: "socks5://proxy.example:1080" })
  assert.equal(socks.HTTPS_PROXY, undefined, "SOCKS ALL_PROXY must not be promoted to Node's HTTP(S) transport")
  assert.equal(socks.ALL_PROXY, "socks5://proxy.example:1080", "only components with their own ALL_PROXY support may use it")
  const configured = serverEnvironment({ HTTPS_PROXY: "http://inherited.example:8080", NO_PROXY: "intranet" }, { proxyUrl: "http://configured.example:8080", noProxy: ["private.local"] })
  assert.equal(configured.HTTP_PROXY, "http://configured.example:8080")
  assert.equal(configured.NO_PROXY, "private.local,intranet,localhost,127.0.0.1,::1")
  for (const env of [serverEnvironment({ ALL_PROXY: "socks5://proxy.example:1080" }, { proxyUrl: "" }),
    serverEnvironment({ PI_LAUNCHER_PROXY_URL: "", HTTPS_PROXY: "http://proxy.example", all_proxy: "socks5://proxy.example" }, { proxyUrl: "http://configured.example" })]) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) assert.equal(env[key], undefined)
    assert.ok(env.NO_PROXY.includes("127.0.0.1"))
  }
})
test("corrupt process records warn and never inspect or stop any process", async t => {
  const f = fixture(t), messages = []
  const backend = new PiBackend({ cwd: f.root, stateDir: f.root, log: message => messages.push(message) })
  // If a bad record reaches PowerShell, this test fails on Linux (and no child is intended).
  for (const content of ["{broken", "null", "[]", '{"pid":1}', '{"pid":"1","created":"now","entry":"relative"}']) {
    fs.writeFileSync(backend.recordPath(30141), content)
    assert.equal(await backend.getOwnedProcess(30141), undefined)
    await backend.stop(30141)
    assert.equal(fs.readFileSync(backend.recordPath(30141), "utf8"), content)
  }
  assert.equal(messages.length, 10)
  assert.ok(messages.every(message => /Warning:.*安全忽略/.test(message)))
})
test("build origin normalization accepts HTTPS and git@ forms without cloning or touching a checkout", () => {
  const { normalizeRepository, REPOSITORY } = require("./backend-manifest")
  assert.equal(REPOSITORY, require("../config/backend-build.json").repository)
  assert.equal(normalizeRepository("https://github.com/notakevz/pi-web"), "https://github.com/notakevz/pi-web.git")
  assert.equal(normalizeRepository("git@github.com:notakevz/pi-web.git"), normalizeRepository(REPOSITORY))
  assert.equal(normalizeRepository("git@example.org:team/custom.git"), "https://example.org/team/custom.git")
  for (const origin of ["local/path", "file:///tmp/repo", "http://example.org/repo", "https://user:private-password@example.org/repo", "https://example.org/repo?token=secret"]) {
    assert.throws(() => normalizeRepository(origin), error => /HTTPS URL or git@/.test(error.message) && !error.message.includes("private-password"))
  }
})
test("manual manifest checks accept explicitly configured alternative repositories", t => {
  const f = fixture(t)
  const { readRelease, sha256 } = require("./backend-manifest")
  const files = Object.fromEntries(["package.json", "package-lock.json", ".next/BUILD_ID", "bin/pi-web.js", "next.config.mjs",
    "node_modules/next/package.json", "node_modules/@earendil-works/pi-coding-agent/package.json"].map(name => [name, sha256("fixture")]))
  const commit = "b".repeat(40)
  const manifest = { schema: 1, repository: "git@example.org:team/custom.git", commit, version: "1.0.0", platform: process.platform,
    arch: process.arch, files, id: `${commit}-${sha256(JSON.stringify(files)).slice(0, 16)}` }
  fs.writeFileSync(path.join(f.root, "source-release.json"), JSON.stringify(manifest))
  assert.equal(readRelease(f.root, "none", "https://example.org/team/custom").commit, commit)
  assert.throws(() => readRelease(f.root, "none", "https://example.org/team/other"), /Invalid source release/)
})
test("healthy external service is reused without any configured local backend or runtime", async t => {
  const f = fixture(t), logs = []
  const backend = new PiBackend({ cwd: f.home, stateDir: f.root, log: message => logs.push(message) })
  backend.env = { PI_LAUNCHER_NODE: path.join(f.root, "missing-node") }
  fs.writeFileSync(backend.recordPath(30141), "{damaged")
  // Stub HTTP responses: do not bind a port or start a service.
  t.mock.method(http, "get", (url, callback) => {
    const request = new EventEmitter()
    request.setTimeout = () => {}
    process.nextTick(() => {
      const response = new PassThrough()
      response.statusCode = 200
      callback(response)
      response.end(JSON.stringify(url.endsWith("manifest.webmanifest") ? { name: "Pi Web" } : { home: "C:\\isolated-test-home" }))
    })
    return request
  })
  const server = await backend.start(30141)
  assert.equal(server.owned, false)
  assert.equal(server.child, undefined)
  assert.equal(backend.node, undefined)
  await backend.close()
  await backend.stop(30141)
  assert.ok(logs.some(message => /Reusing external/.test(message)))
})

function deliveryFixture(t) {
  const f = fixture(t)
  const artifact = path.join(f.root, "work", "artifact"), output = path.join(f.root, "destination", "backend")
  fs.mkdirSync(path.join(artifact, "bin"), { recursive: true })
  fs.writeFileSync(path.join(artifact, "bin", "entry.js"), "completed artifact")
  return { ...f, artifact, output }
}

test("artifact delivery succeeds on one volume without replacing existing data", t => {
  const f = deliveryFixture(t)
  require("./build-source").deliverArtifact(f.artifact, f.output)
  assert.equal(fs.readFileSync(path.join(f.output, "bin", "entry.js"), "utf8"), "completed artifact")
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ["backend"])
})
test("artifact delivery handles EXDEV with a destination-volume staging copy", t => {
  const f = deliveryFixture(t)
  const io = { ...fs, renameSync() { throw Object.assign(new Error("simulated cross-volume rename"), { code: "EXDEV" }) } }
  require("./build-source").deliverArtifact(f.artifact, f.output, io)
  assert.equal(fs.readFileSync(path.join(f.output, "bin", "entry.js"), "utf8"), "completed artifact")
  assert.equal(fs.readFileSync(path.join(f.artifact, "bin", "entry.js"), "utf8"), "completed artifact")
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ["backend"])
})
test("artifact delivery refuses existing empty directories, populated directories and files", t => {
  const f = deliveryFixture(t)
  fs.mkdirSync(path.dirname(f.output), { recursive: true })
  for (const kind of ["empty", "populated", "file"]) {
    if (kind === "file") fs.writeFileSync(f.output, "important data")
    else {
      fs.mkdirSync(f.output)
      if (kind === "populated") fs.writeFileSync(path.join(f.output, "keep"), "important data")
    }
    assert.throws(() => require("./build-source").deliverArtifact(f.artifact, f.output), /Output already exists/)
    if (kind === "file") assert.equal(fs.readFileSync(f.output, "utf8"), "important data")
    else assert.deepEqual(fs.readdirSync(f.output), kind === "empty" ? [] : ["keep"])
    assert.equal(fs.readFileSync(path.join(f.artifact, "bin", "entry.js"), "utf8"), "completed artifact")
    fs.rmSync(f.output, { recursive: true })
  }
})
test("artifact delivery does not replace an output appearing after its first check", t => {
  const f = deliveryFixture(t)
  const io = { ...fs, mkdtempSync(prefix) {
    const staging = fs.mkdtempSync(prefix)
    fs.mkdirSync(f.output) // Simulate another owner winning the output-directory race.
    return staging
  } }
  assert.throws(() => require("./build-source").deliverArtifact(f.artifact, f.output, io), /completed artifact preserved/)
  assert.deepEqual(fs.readdirSync(f.output), [], "an existing empty output must not be replaced")
  const staging = fs.readdirSync(path.dirname(f.output)).find(name => name.startsWith(".pi-backend-delivery-"))
  assert.equal(fs.readFileSync(path.join(path.dirname(f.output), staging, "artifact", "bin", "entry.js"), "utf8"), "completed artifact")
})
test("failed delivery retains the complete staged artifact and leaves partial output untouched", t => {
  const f = deliveryFixture(t)
  const io = { ...fs, cpSync(source, destination) {
    fs.writeFileSync(path.join(f.output, "partial"), "partial output")
    throw Object.assign(new Error("simulated copy failure"), { code: "EIO" })
  } }
  assert.throws(() => require("./build-source").deliverArtifact(f.artifact, f.output, io), /completed artifact preserved/)
  const staging = fs.readdirSync(path.dirname(f.output)).find(name => name.startsWith(".pi-backend-delivery-"))
  assert.equal(fs.readFileSync(path.join(path.dirname(f.output), staging, "artifact", "bin", "entry.js"), "utf8"), "completed artifact")
  assert.equal(fs.readFileSync(path.join(f.output, "partial"), "utf8"), "partial output")
})
test("failed startup cleanup retains ownership when stopping fails and preserves the primary error", async t => {
  const f = fixture(t), recordFile = path.join(f.root, "owned.json"), logs = []
  const info = { pid: 123, created: "fixture", entry: path.join(f.root, "bin", "pi-web.js") }
  const record = JSON.stringify(info), primary = new Error("startup timed out"), cleanupError = new Error("simulated stop failure")
  fs.writeFileSync(recordFile, record)
  const { cleanupFailedStart } = require("../src/backend")
  await assert.rejects(async () => {
    try { throw primary }
    catch (error) {
      await cleanupFailedStart(info, recordFile, { stop: async actual => { assert.equal(actual, info); throw cleanupError }, log: (...args) => logs.push(args) })
      throw error
    }
  }, error => error === primary)
  assert.equal(fs.readFileSync(recordFile, "utf8"), record)
  assert.equal(logs.length, 1)
  assert.match(logs[0][0], /retaining ownership record/)
  assert.equal(logs[0][1], cleanupError)
})
test("successful startup cleanup deletes ownership only after stopping completes", async t => {
  const f = fixture(t), recordFile = path.join(f.root, "owned.json")
  fs.writeFileSync(recordFile, "valid owned record")
  let stopped = false
  await require("../src/backend").cleanupFailedStart({}, recordFile, { stop: async () => {
    assert.equal(fs.readFileSync(recordFile, "utf8"), "valid owned record")
    stopped = true
  }, log: () => assert.fail("successful cleanup must not log an error") })
  assert.equal(stopped, true)
  assert.equal(fs.existsSync(recordFile), false)
})
