// Offline release regression: only temporary files and injected REST/core mocks.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")
const { test } = require("node:test")
const { publishRelease } = require("./publish-release")

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex")
const apiError = status => Object.assign(new Error(status ? `HTTP ${status}` : "Network unavailable"), status ? { status } : {})
const methods = ["listReleases", "getRef", "createRef", "createRelease", "uploadReleaseAsset", "updateRelease"]

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-unit-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const files = {
    "pi-web-launcher-0.0.1-x64-setup.exe": Buffer.from([0x4d, 0x5a, 0x00, 0xff]),
    "portable.exe": Buffer.from("second mock EXE, never executed"),
  }
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), data)
  const checksum = Object.entries(files).map(([name, data]) => `${sha256(data)}  ${name}`).join("\r\n") + "\r\n"
  fs.writeFileSync(path.join(directory, "SHA256SUMS.txt"), checksum)
  const calls = [], warnings = [], outputs = []
  const state = { tag: false, draft: false, published: false }
  const result = { id: 123, draft: false, html_url: "https://github.com/example/launcher/releases/tag/v0.0.1" }
  const handlers = {
    listReleases() { return { data: [] } },
    getRef() { throw apiError(404) },
    createRef() { state.tag = true; return { data: {} } },
    createRelease() { state.draft = true; return { data: { id: 123, draft: true } } },
    uploadReleaseAsset({ name }) { return { data: { name } } },
    updateRelease() { state.draft = false; state.published = true; return { data: result } },
  }
  const rest = { repos: {}, git: {} }
  for (const method of [...methods, "deleteRef", "updateRef", "deleteRelease", "deleteReleaseAsset"]) {
    const group = ["getRef", "createRef", "deleteRef", "updateRef"].includes(method) ? rest.git : rest.repos
    group[method] = async args => {
      calls.push({ method, args })
      assert.ok(handlers[method], `Forbidden API: ${method}`)
      return handlers[method](args)
    }
  }
  const options = {
    github: { rest }, directory, version: "0.0.1",
    context: { repo: { owner: "example", repo: "launcher" }, sha: "0123456789abcdef0123456789abcdef01234567", runId: 456, serverUrl: "https://github.com" },
    core: { warning: message => warnings.push(message), setOutput: (...args) => outputs.push(args) },
  }
  return { options, files, checksum, calls, handlers, warnings, outputs, state, result }
}

const called = f => f.calls.map(call => call.method)

test("module import is inert, uses built-ins only and never constructs a real API client", () => {
  const script = require.resolve("./publish-release")
  const child = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const original = Module._load
    Module._load = function(name, ...args) {
      assert.ok(name.startsWith('node:') || name === ${JSON.stringify(script)}, 'Unexpected dependency: ' + name)
      return original.call(this, name, ...args)
    }
    global.fetch = () => { throw new Error('Network forbidden') }
    for (const name of ['node:http', 'node:https']) {
      const transport = require(name)
      transport.request = transport.get = () => { throw new Error('Network forbidden') }
    }
    assert.equal(typeof require(${JSON.stringify(script)}).publishRelease, 'function')
  `], { encoding: "utf8", env: {} })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, "")
})

test("NSIS uses a stable no-space installer name so source artifacts and release checksums keep identical names", () => {
  const pkg = require("../package.json")
  assert.equal(pkg.build.productName, "Pi Web Launcher")
  assert.equal(pkg.build.nsis.shortcutName, "Pi Web Launcher")
  assert.equal(pkg.build.nsis.artifactName, "pi-web-launcher-${version}-${arch}-setup.${ext}")
  assert.equal(pkg.build.nsis.artifactName.replace("${version}", pkg.version).replace("${arch}", "x64").replace("${ext}", "exe"), "pi-web-launcher-0.0.1-x64-setup.exe")
})

test("validates CRLF checksums, atomically tags the source SHA, uploads buffers, then publishes", async t => {
  const f = fixture(t)
  const published = await publishRelease(f.options)
  assert.equal(published, f.result)
  assert.deepEqual(called(f), ["listReleases", "getRef", "createRef", "createRelease", "uploadReleaseAsset", "uploadReleaseAsset", "uploadReleaseAsset", "updateRelease"])
  const { owner, repo } = f.options.context.repo
  assert.deepEqual(f.calls[0].args, { owner, repo, per_page: 100, page: 1 })
  assert.deepEqual(f.calls[1].args, { owner, repo, ref: "tags/v0.0.1" })
  assert.deepEqual(f.calls[2].args, { owner, repo, ref: "refs/tags/v0.0.1", sha: f.options.context.sha })
  const draft = f.calls[3].args
  assert.equal(draft.tag_name, "v0.0.1")
  assert.equal(draft.target_commitish, f.options.context.sha)
  assert.equal(draft.name, "Pi Web Launcher v0.0.1")
  assert.equal(draft.draft, true)
  assert.equal(draft.prerelease, false)
  assert.match(draft.body, /Unsigned Windows x64/)
  assert.match(draft.body, /Node\.js >=22\.19.*external Pi Web/)
  assert.match(draft.body, /not Windows GUI, installation or uninstallation acceptance/)
  assert.ok(draft.body.includes(`/commit/${f.options.context.sha}`))
  assert.ok(draft.body.includes("https://github.com/example/launcher/actions/runs/456"))
  const uploads = f.calls.filter(call => call.method === "uploadReleaseAsset").map(call => call.args)
  assert.deepEqual(uploads.map(asset => asset.name), [...Object.keys(f.files).sort(), "SHA256SUMS.txt"])
  for (const asset of uploads) {
    const isChecksum = asset.name === "SHA256SUMS.txt"
    assert.equal(asset.release_id, 123)
    assert.equal(asset.owner, owner)
    assert.equal(asset.repo, repo)
    assert.ok(Buffer.isBuffer(asset.data))
    assert.deepEqual(asset.data, isChecksum ? Buffer.from(f.checksum) : f.files[asset.name])
    assert.equal(asset.headers["content-type"], isChecksum ? "text/plain; charset=utf-8" : "application/octet-stream")
    assert.equal(asset.headers["content-length"], asset.data.length)
  }
  assert.deepEqual(f.calls.at(-1).args, { owner, repo, release_id: 123, draft: false })
  assert.deepEqual(f.outputs, [["release_url", f.result.html_url]])
  assert.deepEqual(f.warnings, [])
  assert.deepEqual(f.state, { tag: true, draft: false, published: true })
})

test("uploaded bytes remain the validated snapshot even if the directory changes during API checks", async t => {
  const f = fixture(t)
  f.handlers.listReleases = () => {
    fs.writeFileSync(path.join(f.options.directory, Object.keys(f.files)[0]), "changed after validation")
    fs.writeFileSync(path.join(f.options.directory, "extra.txt"), "not uploaded")
    return { data: [] }
  }
  await publishRelease(f.options)
  const upload = f.calls.find(call => call.method === "uploadReleaseAsset").args
  assert.deepEqual(upload.data, f.files[upload.name])
  assert.equal(f.calls.filter(call => call.method === "uploadReleaseAsset").length, 3)
})

test("same-tag draft (without a Git tag), prerelease and published releases are never reused", async t => {
  for (const kind of ["draft", "prerelease", "published"]) await t.test(kind, async t => {
    const f = fixture(t)
    f.handlers.listReleases = () => ({ data: [{ tag_name: "v0.0.1", draft: kind === "draft", prerelease: kind === "prerelease" }] })
    await assert.rejects(publishRelease(f.options), /already exists; refusing to overwrite or reuse/)
    assert.deepEqual(called(f), ["listReleases"])
    assert.equal(f.state.tag, false)
    assert.deepEqual(f.outputs, [])
  })
})

test("an existing tag at the same source SHA is never reused", async t => {
  const f = fixture(t)
  f.handlers.getRef = () => ({ data: { object: { sha: f.options.context.sha } } })
  await assert.rejects(publishRelease(f.options), /already exists; refusing to overwrite or reuse/)
  assert.deepEqual(called(f), ["listReleases", "getRef"])
  assert.deepEqual(f.outputs, [])
})

test("all release-list errors fail closed; only getRef HTTP 404 means absent", async t => {
  for (const method of ["listReleases", "getRef"]) {
    for (const status of method === "listReleases" ? [404, 403, 500, undefined] : [403, 500, undefined]) await t.test(`${method}: ${status || "network"}`, async t => {
      const f = fixture(t), error = apiError(status)
      f.handlers[method] = () => { throw error }
      await assert.rejects(publishRelease(f.options), thrown => thrown === error)
      assert.deepEqual(called(f), method === "getRef" ? ["listReleases", "getRef"] : ["listReleases"])
      assert.deepEqual(f.outputs, [])
    })
  }
})

test("paginates release lists and rejects a same-tag draft on page two before any writes", async t => {
  const f = fixture(t)
  f.handlers.listReleases = ({ page }) => ({ data: page === 1
    ? Array.from({ length: 100 }, (_, i) => ({ tag_name: `v2.0.${i}` }))
    : [{ tag_name: "v0.0.1", draft: true }] })
  await assert.rejects(publishRelease(f.options), /already exists/)
  assert.deepEqual(called(f), ["listReleases", "listReleases"])
  assert.deepEqual(f.calls.map(call => call.args.page), [1, 2])
  assert.ok(f.calls.every(call => call.args.per_page === 100))
})

test("complete multi-page release scans permit publishing only after the final short/empty page", async t => {
  for (const finalCount of [0, 3]) await t.test(`last page size ${finalCount}`, async t => {
    const f = fixture(t)
    f.handlers.listReleases = ({ page }) => ({ data: Array.from({ length: page < 3 ? 100 : finalCount }, (_, i) => ({ tag_name: `v${page}.0.${i}` })) })
    await publishRelease(f.options)
    assert.deepEqual(called(f).slice(0, 4), ["listReleases", "listReleases", "listReleases", "getRef"])
    assert.deepEqual(f.calls.slice(0, 3).map(call => call.args), [1, 2, 3].map(page => ({ owner: "example", repo: "launcher", per_page: 100, page })))
    assert.equal(f.state.published, true)
  })
})

test("a later release-list page error also stops before any writes", async t => {
  const f = fixture(t), error = apiError(404)
  f.handlers.listReleases = ({ page }) => {
    if (page === 2) throw error
    return { data: Array.from({ length: 100 }, (_, i) => ({ tag_name: `v2.0.${i}` })) }
  }
  await assert.rejects(publishRelease(f.options), thrown => thrown === error)
  assert.deepEqual(called(f), ["listReleases", "listReleases"])
})

test("failed atomic tag creation never creates a release or changes/deletes a ref", async t => {
  const f = fixture(t), error = apiError(422)
  f.handlers.createRef = () => { throw error }
  await assert.rejects(publishRelease(f.options), thrown => thrown === error)
  assert.deepEqual(called(f), ["listReleases", "getRef", "createRef"])
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /manually inspect/)
  assert.deepEqual(f.outputs, [])
})

test("any failed upload leaves tag/draft for manual inspection without publishing or deleting", async t => {
  for (const failAt of [1, 2, 3]) await t.test(`upload ${failAt}`, async t => {
    const f = fixture(t), error = apiError(500)
    let uploads = 0
    f.handlers.uploadReleaseAsset = ({ name }) => { if (++uploads === failAt) throw error; return { data: { name } } }
    await assert.rejects(publishRelease(f.options), thrown => thrown === error)
    assert.deepEqual(called(f), ["listReleases", "getRef", "createRef", "createRelease", ...Array(failAt).fill("uploadReleaseAsset")])
    assert.deepEqual(f.state, { tag: true, draft: true, published: false })
    assert.equal(f.warnings.length, 1)
    assert.match(f.warnings[0], /tag and\/or draft release may remain; manually inspect/)
    assert.match(f.warnings[0], /No automatic deletion or overwrite/)
    assert.deepEqual(f.outputs, [])
  })
})

test("renamed or missing uploaded asset names retain the draft without publication", async t => {
  for (const kind of ["renamed", "missing"]) {
    for (const failAt of [1, 3]) await t.test(`${kind} asset ${failAt}`, async t => {
      const f = fixture(t)
      let uploads = 0
      f.handlers.uploadReleaseAsset = ({ name }) => ({ data: ++uploads === failAt
        ? (kind === "missing" ? {} : { name: name.replace(/-/g, ".") + ".renamed" })
        : { name } })
      await assert.rejects(publishRelease(f.options), /Uploaded asset name does not match expected name/)
      assert.deepEqual(called(f), ["listReleases", "getRef", "createRef", "createRelease", ...Array(failAt).fill("uploadReleaseAsset")])
      assert.deepEqual(f.state, { tag: true, draft: true, published: false })
      assert.equal(f.warnings.length, 1)
      assert.match(f.warnings[0], /manually inspect/)
      assert.deepEqual(f.outputs, [])
    })
  }
})

test("createRelease and final publication errors are rethrown with recovery warnings", async t => {
  for (const method of ["createRelease", "updateRelease"]) await t.test(method, async t => {
    const f = fixture(t), error = apiError(500)
    f.handlers[method] = () => { throw error }
    await assert.rejects(publishRelease(f.options), thrown => thrown === error)
    assert.equal(called(f).at(-1), method)
    assert.equal(f.state.tag, true)
    assert.equal(f.state.published, false)
    assert.equal(f.warnings.length, 1)
    assert.deepEqual(f.outputs, [])
  })
})

test("rejects malformed, dangerous or non-SemVer versions before any API", async t => {
  for (const version of [undefined, null, 1, "", "latest", "v1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3-rc..1", "1.2.3+", "1.2.3/evil", "1.2.3+../evil", "1.2.3+foo.lock", "1.2.3\n", "1.2.3;echo bad", "1.2.3+" + "a".repeat(200)]) {
    await t.test(String(version), async t => {
      const f = fixture(t)
      f.options.version = version
      await assert.rejects(publishRelease(f.options), /Invalid release version/)
      assert.deepEqual(f.calls, [])
    })
  }
})

test("requires a full source SHA and valid run context before any API", async t => {
  for (const sha of [undefined, "main", "a".repeat(39), "z".repeat(40), "a".repeat(40) + "\n"]) await t.test(String(sha), async t => {
    const f = fixture(t)
    f.options.context.sha = sha
    await assert.rejects(publishRelease(f.options), /40-hex commit SHA/)
    assert.deepEqual(f.calls, [])
  })
  const f = fixture(t)
  f.options.context.runId = undefined
  await assert.rejects(publishRelease(f.options), /Actions run ID/)
  assert.deepEqual(f.calls, [])
})

test("bad or incomplete artifact manifests and non-whitelisted files fail before any API", async t => {
  const cases = {
    "missing EXEs": f => { for (const name of Object.keys(f.files)) fs.unlinkSync(path.join(f.options.directory, name)) },
    "missing checksum": f => fs.unlinkSync(path.join(f.options.directory, "SHA256SUMS.txt")),
    "wrong hash": f => "0".repeat(64) + f.checksum.slice(64),
    "missing EXE entry": f => f.checksum.split("\r\n")[0] + "\r\n",
    "duplicate entry": f => f.checksum + f.checksum.split("\r\n")[0] + "\r\n",
    "extra manifest entry": f => f.checksum + `${sha256("other")}  other.exe\r\n`,
    "path traversal entry": f => f.checksum.replace("portable.exe", "../portable.exe"),
    "malformed checksum": () => "not a checksum\r\n",
    "extra blank line": f => f.checksum + "\r\n",
    "extra file": f => fs.writeFileSync(path.join(f.options.directory, "debug.log"), "not permitted"),
    "EXE directory": f => { fs.unlinkSync(path.join(f.options.directory, "portable.exe")); fs.mkdirSync(path.join(f.options.directory, "portable.exe")) },
    "checksum directory": f => { fs.unlinkSync(path.join(f.options.directory, "SHA256SUMS.txt")); fs.mkdirSync(path.join(f.options.directory, "SHA256SUMS.txt")) },
  }
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = fixture(t), changedChecksum = change(f)
    if (typeof changedChecksum === "string") fs.writeFileSync(path.join(f.options.directory, "SHA256SUMS.txt"), changedChecksum)
    await assert.rejects(publishRelease(f.options))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.outputs, [])
  })
})

test("rejects filenames GitHub could normalize before any API, even with otherwise valid checksums", async t => {
  for (const name of ["Pi Web Launcher Setup.exe", "安装程序.exe", "café.exe", "setup(1).exe", "setup+build.exe", ".hidden.exe", "setup%20name.exe"]) await t.test(name, async t => {
    const f = fixture(t)
    fs.renameSync(path.join(f.options.directory, "portable.exe"), path.join(f.options.directory, name))
    fs.writeFileSync(path.join(f.options.directory, "SHA256SUMS.txt"), f.checksum.replace("portable.exe", name))
    await assert.rejects(publishRelease(f.options), /stable ASCII asset names/)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.outputs, [])
  })
})

test("rejects symlink EXEs, checksum files and artifact directories before any API", async t => {
  for (const target of ["portable.exe", "SHA256SUMS.txt", "directory"]) await t.test(target, async t => {
    const f = fixture(t)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-target-"))
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
    const isDirectory = target === "directory"
    const link = isDirectory ? path.join(outside, "artifacts") : path.join(f.options.directory, target)
    const source = isDirectory ? f.options.directory : path.join(outside, target)
    if (!isDirectory) { fs.copyFileSync(link, source); fs.unlinkSync(link) }
    try { fs.symlinkSync(source, link, isDirectory ? "dir" : "file") }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Windows symlink permission unavailable"); return }
      throw error
    }
    if (isDirectory) f.options.directory = link
    await assert.rejects(publishRelease(f.options), /regular (file|directory), not a symlink/)
    assert.deepEqual(f.calls, [])
  })
})

test("SemVer prerelease detection ignores build metadata, and LF/BOM checksums are supported", async t => {
  for (const [version, prerelease] of [["1.2.3-rc.1+build.7", true], ["1.2.3-alpha-beta.0", true], ["1.2.3+build-beta.01", false], ["10.20.30", false]]) {
    await t.test(version, async t => {
      const f = fixture(t)
      f.options.version = version
      fs.writeFileSync(path.join(f.options.directory, "SHA256SUMS.txt"), "\uFEFF" + f.checksum.replace(/\r\n/g, "\n"))
      await publishRelease(f.options)
      const draft = f.calls.find(call => call.method === "createRelease").args
      assert.equal(draft.prerelease, prerelease)
      assert.equal(draft.tag_name, `v${version}`)
      assert.equal(draft.name, `Pi Web Launcher v${version}`)
    })
  }
})
