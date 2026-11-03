// Windows/external-backend integration is deliberately separate from Node-only units.
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const { integrationBackend } = require("./integration-prerequisites")

try {
  integrationBackend()
  for (const file of ["test-backend.js", "test-launcher.js"]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit", env: process.env, windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${file} failed (${result.status ?? result.signal})`)
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
