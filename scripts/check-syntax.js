const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

for (const file of fs.readdirSync(__dirname).filter(name => /\.(?:js|mjs)$/.test(name)).sort()) {
  const result = spawnSync(process.execPath, ["--check", path.join(__dirname, file)], { stdio: "inherit" })
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message)
    process.exitCode = 1
  }
}
