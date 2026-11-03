const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { PiBackend, checkServer, isPortFree } = require("../src/backend")

async function main() {
  const backendRoot = require("./integration-prerequisites").integrationBackend()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-direct-backend-"))
  const backendVersion = JSON.parse(fs.readFileSync(path.join(backendRoot, "package.json"), "utf8")).version
  const port = 30146 // Never use the live 30141 service.
  const url = `http://127.0.0.1:${port}`
  if (!(await isPortFree(port))) throw new Error(`Test port ${port} is occupied; no process was stopped`)
  const stateDir = path.join(root, "state"), agentDir = path.join(root, "agent")
  fs.mkdirSync(stateDir); fs.mkdirSync(agentDir)
  fs.writeFileSync(path.join(stateDir, "source-backend-version.json"), "intentionally invalid old update state", "utf8")
  const instances = []
  function instance(options = {}) {
    const backend = new PiBackend({ cwd: root, stateDir, log: console.log, ...options })
    Object.assign(backend.env, { PI_WEB_LAUNCHER_BACKEND_PATH: backendRoot,
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_WEB_LAUNCHER_NPX: "Z:\\missing-npx.js",
      PI_WEB_LAUNCHER_SOURCE_BACKEND: "Z:\\missing-old-bundle", PI_WEB_LAUNCHER_BACKEND: "npm" })
    instances.push(backend)
    return backend
  }
  let occupied
  try {
    const backend = instance()
    await backend.ensureAvailable()
    assert.equal(backend.updates, undefined)
    const startedAt = Date.now()
    const started = await backend.start(port)
    assert.equal(started.owned, true)
    assert.equal(started.version, backendVersion)
    assert.equal(started.info.entry, path.join(backendRoot, "bin/pi-web.js"))
    assert.ok(!/bootstrap|--source-release|--backend-version|npx-cli/.test(started.info.commandLine))
    console.log(`Direct local startup: ${Date.now() - startedAt} ms`)
    assert.ok(await checkServer(url))

    const adopted = instance()
    await adopted.ensureAvailable()
    const reused = await adopted.start(port)
    assert.equal(reused.info.pid, started.info.pid)
    assert.equal(reused.owned, true)

    const externalState = path.join(root, "external")
    const external = instance({ stateDir: externalState })
    delete external.env.PI_WEB_LAUNCHER_BACKEND_PATH
    await external.ensureAvailable()
    const externalServer = await external.start(port)
    assert.equal(externalServer.owned, false)
    await external.close(); await external.stop(port)
    assert.ok(await checkServer(url), "external reuse must never stop the server")

    // PID reuse / tampered creation time must not grant ownership or kill a process.
    const recordFile = backend.recordPath(port)
    const record = fs.readFileSync(recordFile, "utf8")
    fs.writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(record), created: "wrong-created" }), "utf8")
    await adopted.stop(port)
    assert.ok(await checkServer(url))
    fs.writeFileSync(recordFile, record, "utf8")
    await backend.stop(port, started.info)
    assert.ok(await isPortFree(port))

    const cancelled = instance()
    await cancelled.ensureAvailable()
    const pending = cancelled.start(port)
    const timer = setTimeout(() => cancelled.close(), 50)
    try { await assert.rejects(pending, /应用正在退出/) } finally { clearTimeout(timer) }
    assert.ok(await isPortFree(port), "quit during startup must clean up its own process tree")

    occupied = http.createServer((_req, res) => { res.writeHead(200); res.end("not Pi Web") })
    await new Promise(resolve => occupied.listen(port, "127.0.0.1", resolve))
    const blocked = instance()
    await blocked.ensureAvailable()
    await assert.rejects(blocked.start(port), /已被其他程序占用/)
    assert.ok(occupied.listening)
    await new Promise(resolve => occupied.close(resolve)); occupied = undefined

    assert.equal(fs.readFileSync(path.join(stateDir, "source-backend-version.json"), "utf8"), "intentionally invalid old update state")
    assert.ok(!fs.existsSync(path.join(stateDir, "source-backends")))
    assert.ok(!fs.existsSync(path.join(stateDir, "custom-backends")))
    console.log("PASS: direct backend, no updates/copy/npx, adoption, external reuse, identity guards, quit cancellation and occupied-port safety")
  } finally {
    if (occupied) await new Promise(resolve => occupied.close(resolve))
    for (const backend of instances) { await backend.close(); await backend.stop(port).catch(console.error) }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
