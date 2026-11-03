// Manual build/deployment integrity checks. Never imported by the Electron runtime.
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const REPOSITORY = require("../config/backend-build.json").repository

function normalizeRepository(value) {
  try {
    if (typeof value !== "string") throw new Error()
    const ssh = value.match(/^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/)
    const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : value)
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error()
    const repository = url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "")
    if (!repository || repository.split("/").some(part => !part || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+$/.test(repository)) throw new Error()
    return `https://${url.host.toLowerCase()}/${repository}.git`
  } catch { throw new Error("repository / source origin must be an HTTPS URL or git@host:owner/repo.git (no embedded HTTPS credentials)") }
}
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex")

function releaseFileHash(relative, content) {
  if (relative === ".next/prerender-manifest.json") {
    const data = JSON.parse(content.toString("utf8"))
    if (data.preview) for (const key of ["previewModeId", "previewModeSigningKey", "previewModeEncryptionKey"]) delete data.preview[key]
    return sha256(JSON.stringify(data))
  }
  return sha256(content)
}

function readRelease(root, scope = "full", expectedRepository) {
  const m = JSON.parse(fs.readFileSync(path.join(root, "source-release.json"), "utf8"))
  if (m.schema !== 1 || !m.repository || (expectedRepository && normalizeRepository(m.repository) !== normalizeRepository(expectedRepository)) || !/^[a-f0-9]{40}$/.test(m.commit)
    || !/^\d+\.\d+\.\d+$/.test(m.version) || m.platform !== process.platform || m.arch !== process.arch
    || !m.files || typeof m.files !== "object" || Array.isArray(m.files)
    || !["full", "app", "none"].includes(scope)) throw new Error(`Invalid source release: ${root}`)
  normalizeRepository(m.repository)
  for (const required of ["package.json", "package-lock.json", ".next/BUILD_ID", "bin/pi-web.js", "next.config.mjs",
    "node_modules/next/package.json", "node_modules/@earendil-works/pi-coding-agent/package.json"]) {
    if (!m.files[required]) throw new Error(`Missing manifest entry: ${required}`)
  }
  for (const [relative, expected] of Object.entries(m.files)) {
    if (!relative || relative.includes("\\") || relative.includes(":") || path.isAbsolute(relative)
      || relative.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Unsafe manifest entry: ${relative}`)
    }
    if ((scope === "full" || scope === "app" && !relative.startsWith("node_modules/"))
      && releaseFileHash(relative, fs.readFileSync(path.join(root, relative))) !== expected) throw new Error(`Hash mismatch: ${relative}`)
  }
  if (m.id !== `${m.commit}-${sha256(JSON.stringify(m.files)).slice(0, 16)}`) throw new Error("Invalid source release fingerprint")
  if (scope !== "none" && JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== m.version) throw new Error("Source release version mismatch")
  return m
}

module.exports = { REPOSITORY, normalizeRepository, sha256, releaseFileHash, readRelease }
