// Offline version synchronization. No dependency install or Cargo.lock rewrite.
const fs = require("node:fs")
const path = require("node:path")

function tomlValue(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]+)"\\s*(?:#.*)?$`, "m"))
  if (!match) throw new Error(`Missing TOML ${key}`)
  return match[1]
}

function checkVersion(root = path.resolve(__dirname, "..")) {
  const read = file => fs.readFileSync(path.join(root, file), "utf8")
  const pkg = JSON.parse(read("package.json"))
  const lock = JSON.parse(read("package-lock.json"))
  const cargo = read("src-tauri/Cargo.toml").split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
  if (!cargo) throw new Error("Cargo.toml is missing [package]")
  const crate = tomlValue(cargo, "name")
  const crateLock = read("src-tauri/Cargo.lock").split(/^\[\[package\]\]\s*$/m).slice(1)
    .find(section => tomlValue(section, "name") === crate)
  if (!crateLock) throw new Error(`Cargo.lock is missing ${crate}`)
  const versions = {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    "package-lock.json packages[root]": lock.packages?.[""]?.version,
    "Cargo.toml package": tomlValue(cargo, "version"),
    "Cargo.lock package": tomlValue(crateLock, "version"),
  }
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"))
  versions["tauri.conf.json"] = tauri.version
  if (lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name) throw new Error("Package/lock root names disagree")
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid package version")
  for (const [file, version] of Object.entries(versions)) {
    if (version !== pkg.version) throw new Error(`Version mismatch: ${file}=${version}; package.json=${pkg.version}`)
  }
  return pkg.version
}

if (require.main === module) {
  try { console.log(`Version synchronized: ${checkVersion()}`) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { checkVersion }
