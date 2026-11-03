// Explicit Windows build/deployment tooling, never part of application startup.
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { normalizeRepository, readRelease, sha256, releaseFileHash } = require("./backend-manifest")
const defaults = require("../config/backend-build.json")
const { resolveRuntime, serverEnvironment } = require("../src/backend")

function run(command, args, cwd, env, capture = false) {
  console.log(`> ${path.basename(command)} ${args.join(" ")}`)
  const result = spawnSync(command, args, { cwd, env, windowsHide: true, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 10 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message || result.stderr || "see log above"}`)
  return result.stdout?.trim()
}

function listFiles(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) return [] // npm's .bin shims are not needed to start the server.
    return entry.isDirectory() ? listFiles(root, file) : [path.relative(root, file).split(path.sep).join("/")]
  })
}

// Stage on the destination volume, then reserve output exclusively. Copying into
// that reservation avoids rename's empty-directory replacement on POSIX too.
// On any failure retain the source/staged artifact and any partial output.
function deliverArtifact(artifact, output, io = fs) {
  if (io.lstatSync(output, { throwIfNoEntry: false })) throw new Error(`Output already exists; choose a fresh --output path: ${output}`)
  io.mkdirSync(path.dirname(output), { recursive: true })
  const staging = io.mkdtempSync(path.join(path.dirname(output), ".pi-backend-delivery-"))
  const stagedArtifact = path.join(staging, "artifact")
  try {
    try { io.renameSync(artifact, stagedArtifact) }
    catch (error) {
      if (error.code !== "EXDEV") throw error
      io.cpSync(artifact, stagedArtifact, { recursive: true, force: false, errorOnExist: true })
    }
    io.mkdirSync(output) // No recursive flag: fail even if an empty output appeared meanwhile.
    for (const name of io.readdirSync(stagedArtifact)) {
      io.cpSync(path.join(stagedArtifact, name), path.join(output, name), { recursive: true, force: false, errorOnExist: true })
    }
  } catch (error) {
    const recovery = io.existsSync(stagedArtifact) && !io.existsSync(artifact) ? stagedArtifact : artifact
    throw new Error(`Backend delivery failed; completed artifact preserved at ${recovery}. Any partial output was left untouched: ${output}\n${error.message}`, { cause: error })
  }
  io.rmSync(staging, { recursive: true, force: true })
}

async function main() {
  if (process.platform !== "win32") throw new Error("Build this Windows release using Windows-native Node/npm")
  const args = process.argv.slice(2)
  function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
  if (args.some((value, index) => index % 2 === 0 && !["--source", "--commit", "--output", "--test-scope", "--repository"].includes(value)) || args.length % 2) {
    throw new Error("Usage: node scripts/build-source.js [--source PATH] [--commit SHA] [--output PATH] [--test-scope full|windows-core] [--repository URL]")
  }
  const project = path.resolve(__dirname, "..")
  const source = path.resolve(option("--source", path.resolve(project, defaults.source)))
  const output = path.resolve(option("--output", path.resolve(project, defaults.output)))
  const scope = option("--test-scope", defaults.testScope)
  const repository = normalizeRepository(option("--repository", defaults.repository))
  if (!["full", "windows-core"].includes(scope)) throw new Error("Unknown test scope")
  const env = serverEnvironment()
  if (fs.existsSync(output)) throw new Error(`Output already exists. Stop its backend and move the old directory first, or choose a new --output path: ${output}`)
  const runtime = resolveRuntime(env, true) // npm is required only for this explicit build.
  const npm = path.join(path.dirname(runtime.npx), "npm-cli.js")
  const git = (args, capture = true) => run("git", ["-C", source, ...args], source, env, capture)
  if (normalizeRepository(git(["remote", "get-url", "origin"])) !== repository) throw new Error("Source origin is not the configured repository; set --repository explicitly for another source")
  if (git(["status", "--porcelain"])) throw new Error("Source checkout has local changes; refusing an ambiguous release")
  const commit = git(["rev-parse", "--verify", `${option("--commit", defaults.commit)}^{commit}`])
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid commit")
  const branch = git(["branch", "--show-current"])
  fs.mkdirSync(path.join(project, ".build"), { recursive: true })
  const work = fs.mkdtempSync(path.join(project, ".build", "source-"))
  const checkout = path.join(work, "checkout")
  const artifact = path.join(work, "artifact")
  const validationAgent = path.join(work, "agent")
  // Tests/build never see real credentials, sessions, or globally installed extensions.
  const checkEnv = { ...env, PI_CODING_AGENT_DIR: validationAgent, PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1" }
  let added = false, artifactComplete = false, delivered = false
  try {
    git(["worktree", "add", "--detach", checkout, commit], false)
    added = true
    const originalPackage = fs.readFileSync(path.join(checkout, "package.json"), "utf8")
    const pkg = JSON.parse(originalPackage)
    const allowScripts = { "@agegr/pi-web": true, "node-pty": true, "@google/genai": true, protobufjs: true, "unrs-resolver": true }
    fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ ...pkg, allowScripts }, null, 2), "utf8")
    run(runtime.node, [npm, "ci", "--no-audit", "--no-fund"], checkout, env)
    fs.writeFileSync(path.join(checkout, "package.json"), originalPackage, "utf8")
    const tests = scope === "full" ? ["app/**/*.test.mjs", "components/**/*.test.mjs", "hooks/**/*.test.mjs", "lib/**/*.test.mjs", "public/**/*.test.mjs"] : [
      "lib/tool-presets.test.mjs", "lib/local-tool-modes.test.mjs", "lib/rpc-manager-tool-exposure.test.mjs", "lib/rpc-manager-tool-exposure.integration.test.mjs",
      "hooks/tool-preset.test.mjs", "hooks/new-session-switch.test.mjs", "hooks/model-thinking-defaults.test.mjs",
      "lib/session-tool-selection.test.mjs", "lib/session-view-prefetch.test.mjs", "lib/thinking-controls.test.mjs",
      "lib/thinking-requests.test.mjs", "components/ChatInput.test.mjs", "components/ChatInput.thinking.test.mjs", "components/AppShell.title.test.mjs",
    ]
    run(runtime.node, ["--import", pathToFileURL(path.join(__dirname, "windows-test-imports.mjs")).href, "--experimental-strip-types", "--test", "--test-concurrency=4", "--test-timeout=120000", ...tests], checkout, checkEnv)
    run(runtime.node, [path.join(checkout, "node_modules/typescript/bin/tsc"), "--noEmit"], checkout, checkEnv)
    run(runtime.node, [npm, "run", "lint"], checkout, checkEnv)
    // Windows tracing was observed escaping into the real user profile and failing
    // on protected files. An isolated build-only profile prevents that traversal.
    // Runtime processes still inherit the user's actual profile and configuration.
    const profile = path.join(work, "profile")
    for (const dir of ["AppData/Local", "AppData/Roaming", "agent"]) fs.mkdirSync(path.join(profile, dir), { recursive: true })
    const buildEnv = { ...checkEnv,
      APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"),
      USERPROFILE: profile, HOMEDRIVE: profile.slice(0, 2), HOMEPATH: profile.slice(2), HOME: profile,
      PI_CODING_AGENT_DIR: path.join(profile, "agent") }
    run(runtime.node, [path.join(checkout, "node_modules/next/dist/bin/next"), "build", "--webpack"], checkout, buildEnv)

    fs.mkdirSync(artifact)
    for (const name of ["bin", "public", "package.json", "package-lock.json", "LICENSE"]) {
      fs.cpSync(path.join(checkout, name), path.join(artifact, name), { recursive: true })
    }
    fs.cpSync(path.join(checkout, ".next"), path.join(artifact, ".next"), { recursive: true, filter: file => {
      const relative = path.relative(path.join(checkout, ".next"), file).split(path.sep).join("/")
      return !["cache", "dev", "server/route-cache"].some(dir => relative === dir || relative.startsWith(dir + "/")) && !file.endsWith(".map")
    } })
    // next start must not install TypeScript on an offline machine. Transpile only the
    // deployment copy of the original config, preserving import.meta and all options.
    const ts = require(path.join(checkout, "node_modules/typescript"))
    fs.writeFileSync(path.join(artifact, "next.config.mjs"), ts.transpileModule(fs.readFileSync(path.join(checkout, "next.config.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText, "utf8")
    fs.mkdirSync(path.join(artifact, "lib"))
    fs.copyFileSync(path.join(checkout, "lib/gfm-autolink-email-loader.cjs"), path.join(artifact, "lib/gfm-autolink-email-loader.cjs"))
    // A private runtime install, not a junction to development dependencies or npx.
    fs.writeFileSync(path.join(artifact, "package.json"), JSON.stringify({ ...pkg, allowScripts }, null, 2), "utf8")
    run(runtime.node, [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], artifact, env)
    fs.writeFileSync(path.join(artifact, "package.json"), originalPackage, "utf8")
    // Reject an artifact that cannot start from a fresh, offline, isolated profile.
    run(runtime.node, [path.join(artifact, "bin/pi-web.js"), "version"], artifact,
      { ...buildEnv, PI_WEB_NO_OPEN: "1" })
    const files = {}
    for (const relative of listFiles(artifact).sort()) {
      // Include runtime JS, native binaries and DLLs, not just package metadata.
      if (relative === ".next/trace" || relative.startsWith(".next/trace-")) continue
      files[relative] = releaseFileHash(relative, fs.readFileSync(path.join(artifact, relative)))
    }
    const manifest = { schema: 1, repository, branch, commit, version: pkg.version,
      platform: process.platform, arch: process.arch, node: process.version, builtAt: new Date().toISOString(),
      id: `${commit}-${sha256(JSON.stringify(files)).slice(0, 16)}`, files,
      validation: { tests: scope, fullSuiteCertified: scope === "full", typecheck: true, lint: true, build: true, artifactVersionCheck: true } }
    fs.writeFileSync(path.join(artifact, "source-release.json"), JSON.stringify(manifest, null, 2), "utf8")
    readRelease(artifact, "full", repository)
    artifactComplete = true
    deliverArtifact(artifact, output)
    delivered = true
    console.log(JSON.stringify({ result: "PASS", output, id: manifest.id, commit, version: pkg.version }, null, 2))
  } finally {
    if (added) git(["worktree", "remove", "--force", checkout], false)
    if (artifactComplete && !delivered && fs.existsSync(artifact)) console.error(`Completed backend retained for recovery: ${artifact}`)
    else fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { listFiles, deliverArtifact }
