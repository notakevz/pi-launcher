// Runtime configuration only. No downloads, staging, hashing or version switching.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const defaults = require("../config/launcher-defaults.json")

function validateProxyUrl(value) {
  if (value === null || value === "") return value
  try {
    const url = new URL(value)
    if (typeof value !== "string" || !["http:", "https:"].includes(url.protocol) || !url.hostname
      || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) throw new Error()
  } catch { throw new Error("proxyUrl / 代理环境变量必须是有效的 HTTP(S) 代理 URL（或空字符串禁用）。") }
  return value
}

async function readLauncherConfig(stateDir, env = process.env, { home = os.homedir() } = {}) {
  let user = {}
  try { user = JSON.parse(await fs.promises.readFile(path.join(stateDir, "launcher-config.json"), "utf8")) }
  catch (error) {
    // JSON parse errors may contain credentials from the input: never echo them.
    if (error.code !== "ENOENT") throw new Error("无法读取 launcher-config.json：请检查文件权限和 JSON 格式。")
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("launcher-config.json 必须是 JSON 对象。")
  const config = { ...defaults, ...user }
  const variables = { backendPath: "BACKEND_PATH", cwd: "CWD", port: "PORT", nodePath: "NODE",
    proxyUrl: "PROXY_URL", noProxy: "NO_PROXY", startupTimeoutMs: "STARTUP_TIMEOUT_MS" }
  for (const [key, suffix] of Object.entries(variables)) {
    const value = env[`PI_AGENT_LAUNCHER_${suffix}`]
    if (value !== undefined) config[key] = key === "noProxy" ? value.split(",").map(s => s.trim()).filter(Boolean)
      : ["port", "startupTimeoutMs"].includes(key) ? (value.trim() ? Number(value) : NaN) : value
  }
  if (config.schemaVersion !== 1) throw new Error("launcher-config.json schemaVersion 必须为 1。")
  config.cwd ??= home
  for (const key of ["backendPath", "cwd", "nodePath"]) {
    const value = config[key]
    if (value === null && key !== "cwd") continue
    if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value) || value.includes("\0")) throw new Error(`${key} 必须是绝对路径（可选路径可为 null）。`)
    config[key] = path.resolve(value)
  }
  if (!fs.statSync(config.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`工作目录 cwd 不存在：${config.cwd}`)
  if (config.nodePath !== null && !fs.statSync(config.nodePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`nodePath / PI_AGENT_LAUNCHER_NODE 不存在或不是文件：${config.nodePath}`)
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("port / PI_AGENT_LAUNCHER_PORT 必须是 1–65535 的整数。")
  if (!Number.isInteger(config.startupTimeoutMs) || config.startupTimeoutMs < 1 || config.startupTimeoutMs > 2147483647) throw new Error("startupTimeoutMs 必须是 1–2147483647 的整数毫秒。")
  validateProxyUrl(config.proxyUrl)
  if (!Array.isArray(config.noProxy) || config.noProxy.some(value => typeof value !== "string" || /[\r\n,]/.test(value))) throw new Error("noProxy 必须是字符串数组，每项为单个地址或域名。")
  return config
}

function requireBackendPath(root) {
  if (!root) throw new Error("未配置 backendPath。请先手动构建后端，再设置 launcher-config.json 的 backendPath 或 PI_AGENT_LAUNCHER_BACKEND_PATH。启动器不会自动下载。")
  return root
}

async function backendPath(stateDir, env = process.env) {
  return requireBackendPath((await readLauncherConfig(stateDir, env)).backendPath)
}

async function inspectBackend(root) {
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(root, "package.json"), "utf8"))
    if (pkg.name !== "@agegr/pi-web" || typeof pkg.version !== "string") throw new Error("不是 Pi Web 后端目录")
    for (const relative of ["bin/pi-web.js", ".next/BUILD_ID", "node_modules/next/package.json", "node_modules/@earendil-works/pi-coding-agent/package.json"]) {
      if (!(await fs.promises.stat(path.join(root, relative))).isFile()) throw new Error(`缺少文件 ${relative}`)
    }
    let commit
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(root, "source-release.json"), "utf8"))
      if (manifest.version === pkg.version && /^[a-f0-9]{40}$/.test(manifest.commit)) commit = manifest.commit
    } catch (error) { if (error.code !== "ENOENT") throw error }
    return { root, entry: path.join(root, "bin", "pi-web.js"), version: pkg.version, commit,
      label: `${pkg.version}${commit ? ` @ ${commit.slice(0, 12)}` : ""}` }
  } catch (error) {
    throw new Error(`本地 Pi Web 后端未构建完整：${root}\n${error.message}\n请手动构建后端，或设置 PI_AGENT_LAUNCHER_BACKEND_PATH / launcher-config.json 的 backendPath。启动器不会自动下载或修复。`)
  }
}

module.exports = { readLauncherConfig, validateProxyUrl, requireBackendPath, backendPath, inspectBackend }
