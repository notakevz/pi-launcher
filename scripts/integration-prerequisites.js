// Explicit integration inputs only: never discover artifacts or extensions in a real home.
const fs = require("node:fs")
const path = require("node:path")

function requireDirectory(variable) {
  const value = process.env[variable]
  if (!value || !path.isAbsolute(value) || !fs.statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Integration prerequisite: set ${variable} to an existing absolute directory. No user-home fallback is used.`)
  }
  return path.resolve(value)
}

function integrationBackend() {
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (process.platform !== "win32" || major < 22 || major === 22 && minor < 19) {
    throw new Error("Integration prerequisite: Windows-native Node.js >=22.19 and an externally built Pi Web backend. Set PI_WEB_LAUNCHER_BACKEND_PATH to its absolute directory; use test:unit for backend-free Linux tests.")
  }
  const root = requireDirectory("PI_WEB_LAUNCHER_BACKEND_PATH")
  for (const relative of ["package.json", "bin/pi-web.js", ".next/BUILD_ID", "node_modules/next/package.json", "node_modules/@earendil-works/pi-coding-agent/package.json"]) {
    if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile()) throw new Error(`Integration prerequisite: incomplete externally built backend (${relative} missing). Build it manually first.`)
  }
  return root
}

module.exports = { integrationBackend, requireDirectory }
