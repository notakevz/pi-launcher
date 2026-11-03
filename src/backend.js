const { spawn } = require("node:child_process")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const { StringDecoder } = require("node:string_decoder")
const { execute, inspectProcess, stopProcessTree } = require("./process-tools")
const { readLauncherConfig, validateProxyUrl, requireBackendPath, inspectBackend } = require("./local-backend")

const HOST = "127.0.0.1"
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// npm is located only for the explicit manual build command, never for application startup.
function resolveRuntime(source = process.env, requireNpx = false) {
  const directories = (source.PATH || source.Path || "").split(path.delimiter).map(dir => dir.replace(/^"|"$/g, ""))
  const candidates = source.PI_WEB_LAUNCHER_NODE ? [source.PI_WEB_LAUNCHER_NODE] : [
    ...directories.map(dir => path.join(dir, "node.exe")),
    path.join(source.ProgramFiles || source.PROGRAMFILES || "C:\\Program Files", "nodejs", "node.exe"),
  ]
  const node = candidates.find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
  if (!node) throw new Error("找不到 Windows Node.js。请安装 Node.js 22.19 或更新版本。")
  if (!requireNpx) return { node: fs.realpathSync(node) }
  const appData = source.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
  const npx = (source.PI_WEB_LAUNCHER_NPX ? [source.PI_WEB_LAUNCHER_NPX] : [
    path.join(path.dirname(node), "node_modules/npm/bin/npx-cli.js"),
    path.join(appData, "npm/node_modules/npm/bin/npx-cli.js"),
  ]).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
  if (!npx) throw new Error("手动构建需要 npm/npx-cli.js；请修复 Node.js/npm 安装。")
  return { node: fs.realpathSync(node), npx: fs.realpathSync(npx) }
}

function serverEnvironment(source = process.env, config = {}) {
  const env = { ...source }
  const proxy = validateProxyUrl(source.PI_WEB_LAUNCHER_PROXY_URL ?? config.proxyUrl ?? source.HTTPS_PROXY ?? source.https_proxy ?? source.HTTP_PROXY ?? source.http_proxy ?? "")
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    if (proxy) env[key] = proxy
    else delete env[key]
  }
  // Node's environment proxy transport supports HTTP(S), not SOCKS. Preserve
  // ALL_PROXY only for components that already understand it; never promote it.
  if ((source.PI_WEB_LAUNCHER_PROXY_URL ?? config.proxyUrl) === "") { delete env.ALL_PROXY; delete env.all_proxy }
  const bypass = source.PI_WEB_LAUNCHER_NO_PROXY ?? [...(config.noProxy || []), source.NO_PROXY ?? source.no_proxy ?? ""].join(",")
  env.NO_PROXY = env.no_proxy = [...new Set([...bypass.split(",").map(s => s.trim()).filter(Boolean), "localhost", "127.0.0.1", "::1"])].join(",")
  env.NODE_USE_ENV_PROXY = "1"
  env.PI_WEB_NO_OPEN = "1"
  env.PI_WEB_APP_NAME = "Pi Agent"
  env.PI_WEB_SKIP_VERSION_CHECK = "1"
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  // Do not inherit the old launcher's staging directory or npm lifecycle context.
  delete env.PI_WEB_LAUNCHER_BACKEND_DIR
  for (const key of Object.keys(env)) {
    if (/^npm_(?:package_|lifecycle_|command$|execpath$|node_execpath$|config_(?:package|local_prefix|offline)$)/i.test(key) || key === "INIT_CWD") delete env[key]
  }
  return env
}

function backendArguments(port, entry) {
  return [entry, "--hostname", HOST, "--port", String(port), "--no-open"]
}

function localJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", chunk => { body += chunk; if (body.length > 100_000) req.destroy(new Error("Response too large")) })
      res.on("end", () => {
        try { if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`); resolve(JSON.parse(body)) }
        catch (error) { reject(error) }
      })
      res.on("error", reject)
    })
    req.setTimeout(2000, () => req.destroy(new Error("Request timeout")))
    req.on("error", reject)
  })
}

async function checkServer(url) {
  try {
    const manifest = await localJson(`${url}/manifest.webmanifest`)
    if (!["Pi Web", "Pi Agent"].includes(manifest.name)) return false
    const data = await localJson(`${url}/api/home`)
    return typeof data.home === "string" && /^[A-Za-z]:[\\/]/.test(data.home)
  } catch { return false }
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, HOST, () => server.close(() => resolve(true)))
  })
}

function commandHasPath(command, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\s)"?${escaped}"?(?=\\s|$)`, "i").test(command || "")
}

// Cleanup must not replace the primary startup error or discard ownership when
// stopping fails. The injected stop is used by backend-free regression tests.
async function cleanupFailedStart(info, recordFile, { stop = stopProcessTree, log = () => {} } = {}) {
  try {
    await stop(info)
    await fs.promises.rm(recordFile, { force: true })
  } catch (error) { log("Cleanup failed; retaining ownership record", error) }
}

class PiBackend {
  constructor({ cwd, stateDir, log = () => {}, timeout }) {
    Object.assign(this, { cwd, stateDir, log, timeout })
    this.env = { ...process.env }
    this.closed = false
  }

  async ensureAvailable() {
    if (process.platform !== "win32") throw new Error("此启动器需要 Windows。")
    this.config = await readLauncherConfig(this.stateDir, { ...this.env, ...(this.cwd ? { PI_WEB_LAUNCHER_CWD: this.cwd } : {}) })
    this.cwd = this.config.cwd
    this.timeout ??= this.config.startupTimeoutMs
    this.root = this.config.backendPath
    this.env = serverEnvironment(this.env, this.config)
    if (this.config.nodePath) this.env.PI_WEB_LAUNCHER_NODE = this.config.nodePath
  }

  async ensureRuntime() {
    Object.assign(this, resolveRuntime(this.env))
    const version = await execute(this.node, ["--version"])
    const [major, minor] = version.slice(1).split(".").map(Number)
    if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 19)) throw new Error(`Node.js ${version} 过旧，需要 22.19 或更新版本。`)
    this.log(`Native Node ${version}; local backend=${this.root}; no downloads or updates`)
  }

  recordPath(port) { return path.join(this.stateDir, `pi-web-${port}.json`) }

  isServerProcess(info, port, entry) {
    return Boolean(info?.executable && path.resolve(info.executable).toLowerCase() === this.node.toLowerCase()
      && typeof entry === "string" && path.isAbsolute(entry) && path.basename(entry) === "pi-web.js"
      && path.basename(path.dirname(entry)) === "bin" && commandHasPath(info.commandLine, entry)
      && new RegExp(`--port\\s+"?${port}"?(?:\\s|$)`).test(info.commandLine))
  }

  async getOwnedProcess(port) {
    let record
    try { record = JSON.parse(await fs.promises.readFile(this.recordPath(port), "utf8")) }
    catch (error) {
      if (error.code !== "ENOENT") this.log(`Warning: 无法读取进程记录 ${this.recordPath(port)}；安全忽略，不会据此停止进程。`)
      return undefined
    }
    if (!record || typeof record !== "object" || Array.isArray(record) || !Number.isInteger(record.pid) || record.pid <= 0
      || typeof record.created !== "string" || !record.created || typeof record.entry !== "string" || !path.isAbsolute(record.entry)) {
      this.log(`Warning: 进程记录损坏 ${this.recordPath(port)}；安全忽略，不会据此停止进程。`)
      return undefined
    }
    if (!this.node) {
      try { this.node = resolveRuntime(this.env).node }
      catch { this.log("Warning: 无法验证记录的 Node 身份；按外部服务处理。 "); return undefined }
    }
    const info = await inspectProcess(record.pid)
    if (info && info.created === record.created && this.isServerProcess(info, port, record.entry)) return { ...info, version: record.version, label: record.label, entry: record.entry }
    // Old v0.3.x bootstrap processes are treated as external, never killed by guessing.
    await fs.promises.rm(this.recordPath(port), { force: true })
    return undefined
  }

  async stop(port, expected) {
    const info = await this.getOwnedProcess(port)
    if (!info || (expected && (info.pid !== expected.pid || info.created !== expected.created))) return
    await stopProcessTree(info)
    await fs.promises.rm(this.recordPath(port), { force: true })
    this.log(`Stopped launcher-owned Pi Web process tree pid=${info.pid}`)
  }

  async start(port) {
    if (this.closed) throw new Error("应用正在退出")
    this.port = port
    const url = `http://${HOST}:${port}`
    const existing = await this.getOwnedProcess(port)
    if (await checkServer(url)) {
      this.log(existing ? `Adopted Pi Web pid=${existing.pid}` : "Reusing external Pi Web; no version replacement or process ownership")
      return { url, owned: Boolean(existing), info: existing, version: existing?.version, label: existing?.label }
    }
    if (existing) await this.stop(port, existing)
    if (!(await isPortFree(port))) throw new Error(`端口 ${port} 已被其他程序占用；不会停止该程序。`)
    const spec = await inspectBackend(requireBackendPath(this.root))
    await this.ensureRuntime()
    if (this.closed) throw new Error("应用正在退出")
    this.log(`Starting local Pi Web ${spec.label} directly from ${spec.root}`)
    const child = spawn(this.node, backendArguments(port, spec.entry), {
      cwd: this.cwd, env: this.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = child
    let failure, output = "", info
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8")
      stream.on("data", chunk => {
        const text = decoder.write(chunk).trimEnd()
        output = (output + "\n" + text).slice(-6000)
        if (text) this.log(`[pi-web] ${text}`)
      })
    }
    child.on("error", error => { failure = error })
    try {
      info = await inspectProcess(child.pid)
      if (!this.isServerProcess(info, port, spec.entry)) throw new Error(`本地 Pi Web 未能启动：${failure?.message || output}`)
      Object.assign(info, { version: spec.version, label: spec.label, entry: spec.entry })
      await fs.promises.mkdir(this.stateDir, { recursive: true })
      const temporary = `${this.recordPath(port)}.${process.pid}.${Date.now()}.tmp`
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(info), { encoding: "utf8", flag: "wx" })
        await fs.promises.rename(temporary, this.recordPath(port))
      } finally { await fs.promises.rm(temporary, { force: true }) }
      const started = Date.now()
      while (Date.now() - started < this.timeout) {
        if (this.closed) throw new Error("应用正在退出")
        if (failure) throw failure
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Pi Web exited (${child.exitCode}): ${output}`)
        if (await checkServer(url)) return { url, owned: true, info, child, version: spec.version, label: spec.label }
        await delay(250)
      }
      throw new Error(`等待 Pi Web 启动超时：${url}\n${output}`)
    } catch (error) {
      if (info && this.isServerProcess(info, port, spec.entry)) {
        await cleanupFailedStart(info, this.recordPath(port), { log: this.log })
      } else if (child.exitCode === null && child.signalCode === null) child.kill()
      throw error
    }
  }

  async close() { this.closed = true }
}

module.exports = { PiBackend, resolveRuntime, serverEnvironment, backendArguments, checkServer, isPortFree, localJson, delay, commandHasPath, cleanupFailedStart }
