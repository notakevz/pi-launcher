// Explicit manual check only. It never downloads, copies, installs or selects versions.
const path = require("node:path")
const os = require("node:os")
const { requireBackendPath } = require("../src/local-backend")
const { PiBackend } = require("../src/backend")
const { inspectBackend } = require("../src/local-backend")

async function main() {
  const backend = new PiBackend({
    stateDir: process.env.PI_WEB_LAUNCHER_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Pi Web Launcher"),
    log: console.log,
  })
  await backend.ensureAvailable()
  const spec = await inspectBackend(requireBackendPath(backend.root))
  await backend.ensureRuntime()
  if (process.argv.includes("--verify")) require("./backend-manifest").readRelease(spec.root, "full")
  console.log(`Ready: Pi Web ${spec.label}\nEntry: ${spec.entry}\nNo backend files or version state were changed.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
