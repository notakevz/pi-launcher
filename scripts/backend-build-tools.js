// Explicit fork build helpers only; not an application runtime or installer.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

function validateProxyUrl(value) {
  if (value === null || value === "") return value
  try {
    const url = new URL(value)
    if (typeof value !== "string" || !["http:", "https:"].includes(url.protocol) || !url.hostname
      || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) throw new Error()
  } catch { throw new Error("proxyUrl / proxy environment must be a valid HTTP(S) proxy URL (or empty to disable).") }
  return value
}

function resolveRuntime(source = process.env) {
  const directories = (source.PATH || source.Path || "").split(path.delimiter).map(dir => dir.replace(/^"|"$/g, ""))
  const candidates = source.PI_LAUNCHER_NODE ? [source.PI_LAUNCHER_NODE] : [
    ...directories.map(dir => path.join(dir, "node.exe")),
    path.join(source.ProgramFiles || source.PROGRAMFILES || "C:\\Program Files", "nodejs", "node.exe"),
  ]
  const node = candidates.find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
  if (!node) throw new Error("The manual backend build requires Windows Node.js >=22.19.")
  const appData = source.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
  const npx = (source.PI_LAUNCHER_NPX ? [source.PI_LAUNCHER_NPX] : [
    path.join(path.dirname(node), "node_modules/npm/bin/npx-cli.js"),
    path.join(appData, "npm/node_modules/npm/bin/npx-cli.js"),
  ]).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
  if (!npx || !fs.statSync(path.join(path.dirname(npx), "npm-cli.js"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("The manual backend build requires npm/npx-cli.js and npm-cli.js; repair Node.js/npm.")
  }
  return { node: fs.realpathSync(node), npx: fs.realpathSync(npx) }
}

function serverEnvironment(source = process.env) {
  const env = { ...source }
  const proxy = validateProxyUrl(source.PI_LAUNCHER_PROXY_URL ?? source.HTTPS_PROXY ?? source.https_proxy ?? source.HTTP_PROXY ?? source.http_proxy ?? "")
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    if (proxy) env[key] = proxy
    else delete env[key]
  }
  if (source.PI_LAUNCHER_PROXY_URL === "") { delete env.ALL_PROXY; delete env.all_proxy }
  const bypass = source.PI_LAUNCHER_NO_PROXY ?? source.NO_PROXY ?? source.no_proxy ?? ""
  env.NO_PROXY = env.no_proxy = [...new Set([...bypass.split(",").map(s => s.trim()).filter(Boolean), "localhost", "127.0.0.1", "::1"])].join(",")
  env.NODE_USE_ENV_PROXY = "1"
  env.PI_WEB_NO_OPEN = "1"
  env.PI_WEB_APP_NAME = "Pi Agent"
  env.PI_WEB_SKIP_VERSION_CHECK = "1"
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.PI_LAUNCHER_BACKEND_DIR
  for (const key of Object.keys(env)) {
    if (/^npm_(?:package_|lifecycle_|command$|execpath$|node_execpath$|config_(?:package|local_prefix|offline)$)/i.test(key) || key === "INIT_CWD") delete env[key]
  }
  return env
}

module.exports = { validateProxyUrl, resolveRuntime, serverEnvironment }
