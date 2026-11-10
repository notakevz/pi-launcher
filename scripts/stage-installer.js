// Default: checksum the native Tauri installer in place, no duplicate EXE/dist.
// Only CI explicitly requests ASCII release attachments in runner temp storage.
const fs = require("node:fs")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { checkVersion } = require("./check-version")

function installerName(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || /[\r\n]/.test(version)) throw new Error("Unsafe installer version")
  return `pi-launcher-${version}-x64-setup.exe`
}

function inspectInstaller(source, version) {
  installerName(version) // Validate before constructing any path.
  if (!fs.lstatSync(source).isDirectory()) throw new Error("NSIS source must be a regular directory")
  const executables = fs.readdirSync(source).filter(file => /\.exe$/i.test(file))
  if (executables.length !== 1) throw new Error("Expected exactly one NSIS installer")
  const name = `Pi Launcher_${version}_x64-setup.exe`
  if (executables[0] !== name) throw new Error(`Expected current-version x64 NSIS installer: ${name}`)
  const input = path.join(source, name)
  if (!fs.lstatSync(input).isFile()) throw new Error("NSIS installer must be a regular file, not a symlink")
  const bytes = fs.readFileSync(input)
  if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("NSIS installer is missing the MZ executable signature")
  return { name, bytes, checksum: createHash("sha256").update(bytes).digest("hex") }
}

function checksumInstaller({ source, version }) {
  const { name, checksum } = inspectInstaller(source, version)
  const file = path.join(source, "SHA256SUMS.txt")
  const existing = fs.lstatSync(file, { throwIfNoEntry: false })
  if (existing && !existing.isFile()) throw new Error("Checksum must be a regular file, not a symlink")
  fs.writeFileSync(file, `${checksum}  ${name}\n`)
  return name
}

function stageInstaller({ source, destination, version }) {
  const { bytes, checksum } = inspectInstaller(source, version)
  const name = installerName(version)
  // CI only: refuse to replace an existing temporary attachment directory.
  fs.mkdirSync(destination)
  fs.writeFileSync(path.join(destination, name), bytes, { flag: "wx" })
  fs.writeFileSync(path.join(destination, "SHA256SUMS.txt"), `${checksum}  ${name}\n`, { flag: "wx" })
  return name
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, ".."), args = process.argv.slice(2)
    const options = { source: path.join(root, "src-tauri/target/release/bundle/nsis"), version: checkVersion(root) }
    if (args.length === 0) console.log(checksumInstaller(options))
    else if (args.length === 2 && args[0] === "--release-output") console.log(stageInstaller({ ...options, destination: path.resolve(args[1]) }))
    else throw new Error("Usage: stage-installer.js [--release-output <CI temporary directory>]")
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { installerName, stageInstaller, checksumInstaller }
