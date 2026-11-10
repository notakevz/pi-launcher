// Portable tooling tests, not Windows runtime/backend acceptance.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { normalizeRepository, REPOSITORY, readRelease, sha256, releaseFileHash } = require("./backend-manifest")
const { deliverArtifact, listFiles } = require("./build-source")
const { resolveRuntime, serverEnvironment } = require("./backend-build-tools")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-build-tools-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}
function deliveryFixture(t) {
  const root = fixture(t)
  const artifact = path.join(root, "work", "artifact"), output = path.join(root, "destination", "backend")
  fs.mkdirSync(path.join(artifact, "bin"), { recursive: true })
  fs.writeFileSync(path.join(artifact, "bin", "entry.js"), "completed artifact")
  return { root, artifact, output }
}

test("build origin normalization accepts explicit HTTPS/git@ repositories without echoing secrets", () => {
  assert.equal(REPOSITORY, require("../config/backend-build.json").repository)
  assert.equal(normalizeRepository("https://github.com/notakevz/pi-web"), "https://github.com/notakevz/pi-web.git")
  assert.equal(normalizeRepository("git@github.com:notakevz/pi-web.git"), normalizeRepository(REPOSITORY))
  assert.equal(normalizeRepository("git@example.org:team/custom.git"), "https://example.org/team/custom.git")
  for (const origin of ["local/path", "file:///tmp/repo", "http://example.org/repo", "https://user:private-password@example.org/repo", "https://example.org/repo?token=secret"]) {
    assert.throws(() => normalizeRepository(origin), error => /HTTPS URL or git@/.test(error.message) && !error.message.includes("private-password"))
  }
})

test("manifest checks verify bytes, repository, fingerprint, safe paths and required entries", t => {
  const root = fixture(t), commit = "b".repeat(40), files = {}
  for (const relative of ["package.json", "package-lock.json", ".next/BUILD_ID", "bin/pi-web.js", "next.config.mjs",
    "node_modules/next/package.json", "node_modules/@earendil-works/pi-coding-agent/package.json"]) {
    const data = relative === "package.json" ? JSON.stringify({ version: "1.0.0" }) : "fixture"
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), data)
    files[relative] = sha256(data)
  }
  const manifest = { schema: 1, repository: "git@example.org:team/custom.git", commit, version: "1.0.0", platform: process.platform,
    arch: process.arch, files, id: `${commit}-${sha256(JSON.stringify(files)).slice(0, 16)}` }
  const save = value => fs.writeFileSync(path.join(root, "source-release.json"), JSON.stringify(value))
  save(manifest)
  assert.equal(readRelease(root, "full", "https://example.org/team/custom").commit, commit)
  assert.throws(() => readRelease(root, "none", "https://example.org/team/other"), /Invalid source release/)
  fs.writeFileSync(path.join(root, "bin/pi-web.js"), "tampered")
  assert.throws(() => readRelease(root, "full"), /Hash mismatch/)
  assert.equal(readRelease(root, "none").commit, commit)
  save({ ...manifest, id: "wrong" })
  assert.throws(() => readRelease(root, "none"), /fingerprint/)
  save({ ...manifest, files: { ...files, "../escape": sha256("fixture") } })
  assert.throws(() => readRelease(root, "none"), /Unsafe manifest entry/)
  const missing = { ...files }; delete missing["bin/pi-web.js"]
  save({ ...manifest, files: missing })
  assert.throws(() => readRelease(root, "none"), /Missing manifest entry/)
})

test("manifest normalizes only Next preview secrets, not other runtime content", () => {
  const data = { preview: { previewModeId: "first", previewModeSigningKey: "secret", previewModeEncryptionKey: "secret" }, routes: {} }
  const hash = releaseFileHash(".next/prerender-manifest.json", Buffer.from(JSON.stringify(data)))
  data.preview.previewModeId = "second"
  assert.equal(releaseFileHash(".next/prerender-manifest.json", Buffer.from(JSON.stringify(data))), hash)
  data.routes.changed = true
  assert.notEqual(releaseFileHash(".next/prerender-manifest.json", Buffer.from(JSON.stringify(data))), hash)
})

test("manual builder locates Node/npm from explicit temporary fixtures, not an Electron runtime", t => {
  const root = fixture(t), node = path.join(root, "node.exe"), npx = path.join(root, "npx-cli.js")
  for (const file of [node, npx, path.join(root, "npm-cli.js")]) fs.writeFileSync(file, "fixture, never executed")
  assert.deepEqual(resolveRuntime({ PI_LAUNCHER_NODE: node, PI_LAUNCHER_NPX: npx }), { node: fs.realpathSync(node), npx: fs.realpathSync(npx) })
  fs.unlinkSync(path.join(root, "npm-cli.js"))
  assert.throws(() => resolveRuntime({ PI_LAUNCHER_NODE: node, PI_LAUNCHER_NPX: npx }), /requires npm/)
})

test("build environment sanitizes npm context, supports explicit disable and never echoes proxy secrets", () => {
  const source = { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "intranet", npm_package_name: "parent",
    npm_config_cache: "keep-cache", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", PI_LAUNCHER_BACKEND_DIR: "old-staging" }
  const env = serverEnvironment(source)
  assert.equal(source.npm_package_name, "parent")
  assert.equal(env.HTTPS_PROXY, source.HTTPS_PROXY)
  assert.ok(env.NO_PROXY.includes("intranet") && env.NO_PROXY.includes("127.0.0.1"))
  assert.equal(env.npm_config_cache, "keep-cache")
  for (const key of ["npm_package_name", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "PI_LAUNCHER_BACKEND_DIR"]) assert.equal(env[key], undefined)
  const disabled = serverEnvironment({ PI_LAUNCHER_PROXY_URL: "", HTTPS_PROXY: "http://proxy.example", ALL_PROXY: "socks5://elsewhere" })
  assert.equal(disabled.HTTP_PROXY, undefined)
  assert.equal(disabled.ALL_PROXY, undefined)
  const socks = serverEnvironment({ ALL_PROXY: "socks5://elsewhere" })
  assert.equal(socks.ALL_PROXY, "socks5://elsewhere")
  assert.equal(socks.HTTPS_PROXY, undefined)
  assert.throws(() => serverEnvironment({ HTTPS_PROXY: "socks5://user:private-password@proxy" }), error => !error.message.includes("private-password"))
})

test("artifact delivery succeeds on one volume without replacing existing data", t => {
  const f = deliveryFixture(t)
  assert.deepEqual(listFiles(f.artifact), ["bin/entry.js"])
  deliverArtifact(f.artifact, f.output)
  assert.equal(fs.readFileSync(path.join(f.output, "bin", "entry.js"), "utf8"), "completed artifact")
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ["backend"])
})
test("artifact delivery handles EXDEV with a destination-volume staging copy", t => {
  const f = deliveryFixture(t)
  const io = { ...fs, renameSync() { throw Object.assign(new Error("simulated cross-volume rename"), { code: "EXDEV" }) } }
  deliverArtifact(f.artifact, f.output, io)
  assert.equal(fs.readFileSync(path.join(f.output, "bin", "entry.js"), "utf8"), "completed artifact")
  assert.equal(fs.readFileSync(path.join(f.artifact, "bin", "entry.js"), "utf8"), "completed artifact")
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ["backend"])
})
test("artifact delivery refuses existing empty directories, populated directories and files", t => {
  const f = deliveryFixture(t)
  fs.mkdirSync(path.dirname(f.output), { recursive: true })
  for (const kind of ["empty", "populated", "file"]) {
    if (kind === "file") fs.writeFileSync(f.output, "important data")
    else {
      fs.mkdirSync(f.output)
      if (kind === "populated") fs.writeFileSync(path.join(f.output, "keep"), "important data")
    }
    assert.throws(() => deliverArtifact(f.artifact, f.output), /Output already exists/)
    if (kind === "file") assert.equal(fs.readFileSync(f.output, "utf8"), "important data")
    else assert.deepEqual(fs.readdirSync(f.output), kind === "empty" ? [] : ["keep"])
    assert.equal(fs.readFileSync(path.join(f.artifact, "bin", "entry.js"), "utf8"), "completed artifact")
    fs.rmSync(f.output, { recursive: true })
  }
})
test("artifact delivery does not replace an output appearing after its first check", t => {
  const f = deliveryFixture(t)
  const io = { ...fs, mkdtempSync(prefix) {
    const staging = fs.mkdtempSync(prefix)
    fs.mkdirSync(f.output)
    return staging
  } }
  assert.throws(() => deliverArtifact(f.artifact, f.output, io), /completed artifact preserved/)
  assert.deepEqual(fs.readdirSync(f.output), [])
  const staging = fs.readdirSync(path.dirname(f.output)).find(name => name.startsWith(".pi-backend-delivery-"))
  assert.equal(fs.readFileSync(path.join(path.dirname(f.output), staging, "artifact", "bin", "entry.js"), "utf8"), "completed artifact")
})
test("failed delivery retains the complete staged artifact and leaves partial output untouched", t => {
  const f = deliveryFixture(t)
  const io = { ...fs, cpSync() {
    fs.writeFileSync(path.join(f.output, "partial"), "partial output")
    throw Object.assign(new Error("simulated copy failure"), { code: "EIO" })
  } }
  assert.throws(() => deliverArtifact(f.artifact, f.output, io), /completed artifact preserved/)
  const staging = fs.readdirSync(path.dirname(f.output)).find(name => name.startsWith(".pi-backend-delivery-"))
  assert.equal(fs.readFileSync(path.join(path.dirname(f.output), staging, "artifact", "bin", "entry.js"), "utf8"), "completed artifact")
  assert.equal(fs.readFileSync(path.join(f.output, "partial"), "utf8"), "partial output")
})
