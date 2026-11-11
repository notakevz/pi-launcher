const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const root = path.resolve(__dirname, "..")
const files = fs.readdirSync(__dirname).filter(name => /\.(?:js|mjs)$/.test(name)).map(name => path.join(__dirname, name))
files.push(...fs.readdirSync(root).filter(name => name.endsWith(".config.mjs")).map(name => path.join(root, name)))
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" })
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message)
    process.exitCode = 1
  }
}
