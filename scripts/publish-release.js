// Called explicitly by actions/github-script; importing this module never publishes.
const fs = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const CHECKSUM_FILE = "SHA256SUMS.txt"

async function readArtifacts(directory) {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Artifact directory must be a regular directory, not a symlink")
  const names = (await fs.readdir(directory)).sort()
  // Stable ASCII names keep the artifact, release asset and checksum manifest identical.
  if (names.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || /\s/.test(name))) throw new Error("Artifact names must be stable ASCII asset names")
  const executables = names.filter(name => /\.exe$/i.test(name))
  if (!executables.length || !names.includes(CHECKSUM_FILE)) throw new Error("Artifacts require at least one EXE and SHA256SUMS.txt")
  const allowed = new Set([...executables, CHECKSUM_FILE])
  const buffers = new Map()
  for (const name of names) {
    if (!allowed.has(name)) throw new Error(`Unexpected artifact: ${name}`)
    const filename = path.join(directory, name)
    if (!(await fs.lstat(filename)).isFile()) throw new Error(`Artifact must be a regular file, not a symlink: ${name}`)
    buffers.set(name, await fs.readFile(filename))
  }

  const lines = buffers.get(CHECKSUM_FILE).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  const seen = new Set()
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})  (.+)$/.exec(line)
    if (!match || !executables.includes(match[2]) || seen.has(match[2])) throw new Error("Invalid, duplicate or unexpected SHA256SUMS.txt entry")
    const [, expected, name] = match
    const actual = crypto.createHash("sha256").update(buffers.get(name)).digest("hex")
    if (actual !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch: ${name}`)
    seen.add(name)
  }
  if (seen.size !== executables.length) throw new Error("SHA256SUMS.txt must cover every EXE")
  // Upload the validated bytes, not files reopened after asynchronous API requests.
  return [...executables, CHECKSUM_FILE].map(name => ({ name, data: buffers.get(name) }))
}

async function requireMissing(read, description) {
  try { await read() }
  catch (error) {
    if (error.status === 404) return
    throw error
  }
  throw new Error(`${description} already exists; refusing to overwrite or reuse it`)
}

async function publishRelease({ github, context, core, directory, version }) {
  const match = typeof version === "string" && version.length <= 200 && VERSION.exec(version)
  if (!match || match[0] !== version || /\.lock$/i.test(version) || (match[4] && match[4].split(".").some(part => /^0\d+$/.test(part)))) {
    throw new Error("Invalid release version; expected x.y.z with optional prerelease/build metadata")
  }
  if (typeof context.sha !== "string" || context.sha.length !== 40 || !/^[a-fA-F0-9]{40}$/.test(context.sha)) throw new Error("Release source must be a full 40-hex commit SHA")
  const { owner, repo } = context.repo
  if (![owner, repo].every(value => typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value)) || !/^[1-9]\d*$/.test(String(context.runId))) {
    throw new Error("Release requires a repository and Actions run ID")
  }
  const tag = `v${version}`
  const artifacts = await readArtifacts(directory)
  const repository = { owner, repo }
  // getReleaseByTag cannot rule out an untagged draft. Inspect every release page.
  for (let page = 1; ; page++) {
    const { data: releases } = await github.rest.repos.listReleases({ ...repository, per_page: 100, page })
    if (!Array.isArray(releases)) throw new Error("Invalid release list response")
    if (releases.some(release => release.tag_name === tag)) throw new Error(`Release ${tag} already exists; refusing to overwrite or reuse it`)
    if (releases.length < 100) break
  }
  await requireMissing(() => github.rest.git.getRef({ ...repository, ref: `tags/${tag}` }), `Tag ${tag}`)

  const server = (context.serverUrl || "https://github.com").replace(/\/$/, "")
  const project = `${server}/${owner}/${repo}`
  const body = [
    "Unsigned Windows x64 installer. Windows SmartScreen may show a warning.",
    "Requires separately installed Node.js >=22.19 and an external Pi Web backend; neither is bundled.",
    "A successful build/release is not Windows GUI, installation or uninstallation acceptance testing.",
    "",
    `Source commit: [${context.sha}](${project}/commit/${context.sha})`,
    `Actions run: ${project}/actions/runs/${context.runId}`,
  ].join("\n")
  let published
  try {
    // Atomic creation binds the tag to the checked-out source, never a moving branch.
    await github.rest.git.createRef({ ...repository, ref: `refs/tags/${tag}`, sha: context.sha })
    const { data: draft } = await github.rest.repos.createRelease({
      ...repository, tag_name: tag, target_commitish: context.sha,
      name: `Pi Launcher ${tag}`, body, draft: true,
      prerelease: version.split("+")[0].includes("-"),
    })
    for (const { name, data } of artifacts) {
      const { data: asset } = await github.rest.repos.uploadReleaseAsset({
        ...repository, release_id: draft.id, name, data,
        headers: {
          "content-type": name === CHECKSUM_FILE ? "text/plain; charset=utf-8" : "application/octet-stream",
          "content-length": data.length,
        },
      })
      if (!asset || asset.name !== name) throw new Error(`Uploaded asset name does not match expected name: ${name}`)
    }
    const response = await github.rest.repos.updateRelease({ ...repository, release_id: draft.id, draft: false })
    published = response.data
  } catch (error) {
    core.warning(`Release ${tag} failed. A tag and/or draft release may remain; manually inspect ${project}/releases and the tag before retrying. No automatic deletion or overwrite was attempted.`)
    throw error
  }
  core.setOutput("release_url", published.html_url)
  return published
}

module.exports = { publishRelease }
