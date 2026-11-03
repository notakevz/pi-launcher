// No real credentials, sessions, extension changes or model calls.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { PiBackend, isPortFree, delay } = require("../src/backend")
const { readRelease } = require("./backend-manifest")

async function main() {
  const backendRoot = require("./integration-prerequisites").integrationBackend()
  assert.ok(fs.existsSync(path.join(__dirname, "../node_modules/electron/cli.js")), "Integration prerequisite: npm ci is required for the Electron UI checks")
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-source-web-"))
  const workspace = path.join(temp, "workspace"), agent = path.join(temp, "agent")
  fs.mkdirSync(workspace)
  fs.mkdirSync(path.join(agent, "extensions"), { recursive: true })
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "source-smoke", defaultModel: "smoke", cacheWarming: "off" }), "utf8")
  fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "source-smoke": {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "not-a-real-key",
    models: [{ id: "smoke", name: "Offline smoke", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), "utf8")
  fs.writeFileSync(path.join(agent, "extensions", "source-smoke.ts"), `export default function(pi) {
    for (const [name, description, annotations] of [
      ['webfetch', 'Read-only webfetch: smoke tool', {readOnlyHint:true}],
      ['subagent', 'In plan/build, children cannot load extensions or MCP', {}],
      ['unvetted_extra', 'An extension tool outside the limited-mode allowlist', {readOnlyHint:true}],
    ]) pi.registerTool({name,label:name,description,annotations,parameters:{type:'object',properties:{}},
      async execute(){throw new Error('This smoke test must not execute tools or call a model')}});
  }`, "utf8")
  const backend = new PiBackend({ cwd: workspace, stateDir: path.join(temp, "launcher"), timeout: 90_000, log: console.log })
  backend.env.PI_AGENT_LAUNCHER_BACKEND_PATH = backendRoot
  backend.env.PI_CODING_AGENT_DIR = agent
  backend.env.PI_OFFLINE = "1"
  backend.env.PI_AGENT_LAUNCHER_PROXY_URL = "http://127.0.0.1:9"
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) backend.env[key] = "http://127.0.0.1:9"
  const release = readRelease(backend.env.PI_AGENT_LAUNCHER_BACKEND_PATH, "none")
  const port = 30147
  let server
  try {
    assert.ok(await isPortFree(port), "Refusing to reuse an occupied test port")
    await backend.ensureAvailable()
    const started = Date.now()
    server = await backend.start(port)
    assert.equal(server.version, release.version)
    console.log(`PASS: source release starts with blocked network and no npm (${Date.now() - started} ms)`)
    const api = async (endpoint, data) => {
      const response = await fetch(server.url + endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: server.url }, body: JSON.stringify(data) })
      const result = await response.json()
      assert.ok(response.ok && result.success !== false && !result.error, JSON.stringify(result))
      return result
    }
    const plan = ["read", "grep", "find", "ls"], build = ["read", "bash", "edit", "write"], full = ["bash", "read", "edit", "write", "grep", "find", "ls"]
    const created = await api("/api/agent/new", { cwd: workspace, type: "ensure_session" })
    let id = created.sessionId
    const tools = async () => (await api(`/api/agent/${id}`, { type: "get_tools" })).data.filter(tool => tool.active).map(tool => tool.name).sort()
    const select = async list => {
      const changed = await api(`/api/agent/${id}`, { type: "set_tools", toolNames: list })
      id = changed.data.sessionId
      return tools()
    }
    const extras = ["subagent", "webfetch"]
    assert.deepEqual(await tools(), [...build, ...extras].sort(), "Legacy API default remains Build")
    assert.deepEqual(await select(plan), [...plan, ...extras].sort())
    await api(`/api/agent/${id}`, { type: "reload" })
    assert.deepEqual(await tools(), [...plan, ...extras].sort())
    const all = await select(full)
    for (const name of [...full, ...extras, "unvetted_extra"]) assert.ok(all.includes(name), name)
    assert.deepEqual(await select(build), [...build, ...extras].sort())
    assert.deepEqual(await select(plan), [...plan, ...extras].sort())
    console.log("PASS: Plan/Build/Full tool exposure, vetted extensions, Full -> Plan isolation and reload")

    const ui = spawn(backend.node, [path.join(__dirname, "../node_modules/electron/cli.js"), path.join(__dirname, "smoke-source-electron.js"),
      `--url=${server.url}/?cwd=${encodeURIComponent(workspace)}`, `--profile=${path.join(temp, "electron")}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: "inherit", windowsHide: true,
    })
    const uiCode = await new Promise((resolve, reject) => { ui.once("error", reject); ui.once("close", resolve) })
    assert.equal(uiCode, 0, "Source UI smoke failed")

    const adopted = new PiBackend({ cwd: workspace, stateDir: backend.stateDir })
    adopted.env = { ...backend.env }
    await adopted.ensureAvailable()
    const reused = await adopted.start(port)
    assert.equal(reused.info.pid, server.info.pid)
    assert.ok(reused.owned)
    const external = new PiBackend({ cwd: workspace, stateDir: path.join(temp, "external") })
    external.env = { ...backend.env }
    await external.ensureAvailable()
    const notOwned = await external.start(port)
    assert.equal(notOwned.owned, false)
    await external.stop(port)
    await backend.stop(port, server.info)
    server = undefined
    for (let i = 0; i < 30 && !(await isPortFree(port)); i++) await delay(200)
    assert.ok(await isPortFree(port))
    const missing = new PiBackend({ cwd: workspace, stateDir: backend.stateDir })
    missing.env = { ...backend.env, PI_AGENT_LAUNCHER_BACKEND_PATH: path.join(temp, "not-built") }
    await missing.ensureAvailable()
    await assert.rejects(missing.start(port), /请手动构建后端/)
    assert.ok(!fs.existsSync(path.join(backend.stateDir, "source-backend-version.json")))
    server = await backend.start(port)
    assert.equal(server.version, release.version)
    console.log("PASS: adoption, external reuse, process-tree cleanup, direct second start and explicit missing-backend error (no fallback)")
    const report = { schema: 1, id: release.id, passed: true, testedAt: new Date().toISOString(),
      backendPath: backend.root, commit: release.commit, version: release.version, newSessionDefault: "build",
      checks: ["offline-start", "mode-api", "reload", "electron-menu", "legacy-browser-preference", "storage-retention", "adoption", "external-reuse", "cleanup", "second-start", "missing-backend-no-fallback"],
      fullSuiteCertified: release.validation.fullSuiteCertified }
    const reportPath = path.join(__dirname, "../.build/source-web-validation.json")
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")
  } finally {
    if (server) await backend.stop(port, server.info)
    await backend.close()
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
