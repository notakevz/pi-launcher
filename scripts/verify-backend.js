// Explicit manifest verification only; never reads personal launcher config.
const path = require("node:path")
const { readRelease } = require("./backend-manifest")

try {
  const [directory, ...extra] = process.argv.slice(2)
  if (!directory || extra.length) throw new Error("Usage: npm run backend:verify -- PATH_TO_BUILT_BACKEND")
  const manifest = readRelease(path.resolve(directory), "full")
  console.log(`Verified backend ${manifest.version} @ ${manifest.commit}`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
