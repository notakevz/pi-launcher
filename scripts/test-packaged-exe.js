// Actual packaged EXE, explicitly supplied backend, isolated profile/port. No models called.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { inspectBackend } = require("../src/local-backend")
const { PiBackend, isPortFree, checkServer, delay } = require("../src/backend")
const { inspectProcess, stopProcessTree } = require("../src/process-tools")

async function main() {
  const backendRoot = require("./integration-prerequisites").integrationBackend()
  const exe = path.resolve(__dirname, "../dist/win-unpacked/Pi Launcher.exe")
  assert.ok(fs.existsSync(exe), "Integration prerequisite: build dist/win-unpacked/Pi Launcher.exe first")
  const resources = path.join(path.dirname(exe), "resources")
  assert.ok(!fs.existsSync(path.join(resources, "source-backend")), "No backend may be bundled")
  const archiveFiles = require("@electron/asar").listPackage(path.join(resources, "app.asar"))
  assert.ok(!archiveFiles.some(file => /source-backends|updates\.js|bootstrap|tool-modes/.test(file)), "No legacy update/patch code may ship")
  assert.ok(archiveFiles.some(file => file.endsWith("loading.html")), "The offline loading page must ship")
  const spec = await inspectBackend(backendRoot)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-entry-exe-"))
  const workspace = path.join(temp, "workspace"), state = path.join(temp, "Pi Launcher")
  fs.mkdirSync(workspace)
  const env = { ...process.env, PI_LAUNCHER_DATA_DIR: state, PI_LAUNCHER_CWD: workspace,
    PI_LAUNCHER_PORT: "30148", PI_CODING_AGENT_DIR: path.join(temp, "agent"),
    PI_LAUNCHER_PROXY_URL: "http://127.0.0.1:9", PI_OFFLINE: "1" }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, "launcher-config.json"), JSON.stringify({ backendPath: spec.root }), "utf8")
  delete env.PI_LAUNCHER_BACKEND_PATH // Verify the isolated persistent JSON path, not a machine default.
  let child, identity
  try {
    assert.ok(await isPortFree(30148), "Refusing to touch occupied port 30148")
    const started = Date.now()
    child = spawn(exe, ["--disable-gpu"], { cwd: workspace, env, stdio: "ignore", windowsHide: true })
    let spawnError
    child.once("error", error => { spawnError = error })
    identity = await inspectProcess(child.pid)
    let ready = false
    while (Date.now() - started < 60_000) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null) throw new Error(`Packaged EXE exited early: ${child.exitCode}`)
      if (await checkServer("http://127.0.0.1:30148")) {
        const logFile = path.join(state, "launcher.log")
        if (fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("Pi Launcher ready at")) { ready = true; break }
      }
      await delay(250)
    }
    if (!ready) throw new Error(`Packaged EXE timeout: ${fs.readFileSync(path.join(state, "launcher.log"), "utf8").slice(-3000)}`)
    assert.doesNotMatch(fs.readFileSync(path.join(state, "launcher.log"), "utf8"), /Cannot update startup indicator/)
    const record = JSON.parse(fs.readFileSync(path.join(state, "pi-web-30148.json"), "utf8"))
    assert.equal(record.version, spec.version)
    assert.equal(record.entry, spec.entry)
    assert.ok(record.commandLine.includes(spec.entry))
    assert.ok(!/bootstrap|--source-release|--backend-version|npx-cli/.test(record.commandLine))
    for (const name of ["source-backends", "custom-backends", "source-backend-version.json", "backend-version.json"]) assert.ok(!fs.existsSync(path.join(state, name)), name)
    const report = { schema: 2, passed: true, launcherVersion: require("../package.json").version,
      backendVersion: spec.version, backendPath: spec.root, commit: spec.commit, configBackendPath: true, noBundledBackend: true,
      noUpdateOrStaging: true, offline: true, startupMs: Date.now() - started, testedAt: new Date().toISOString() }
    console.log(JSON.stringify({ result: "PASS", ...report }))
    const reportPath = path.join(__dirname, "../.build/packaged-validation.json")
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")
  } finally {
    if (child?.pid) {
      const info = await inspectProcess(child.pid)
      if (info && identity?.created === info.created && path.resolve(info.executable || "").toLowerCase() === exe.toLowerCase()) await stopProcessTree(info)
      // In case the EXE exited independently, clean only the identity-checked test backend.
      const cleanup = new PiBackend({ cwd: workspace, stateDir: state })
      await cleanup.ensureAvailable()
      await cleanup.stop(30148)
    }
    for (let i = 0; i < 30 && !(await isPortFree(30148)); i++) await delay(200)
    assert.ok(await isPortFree(30148), "Test backend port must be released")
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
