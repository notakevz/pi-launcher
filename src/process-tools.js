const { execFile } = require("node:child_process")
const path = require("node:path")

const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

function execute(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, ...options }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })
}

async function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const script = "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = $env:PI_INSPECT_PID\"; if ($p) { [pscustomobject]@{ pid=[int]$p.ProcessId; executable=$p.ExecutablePath; commandLine=$p.CommandLine; created=$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }"
  const output = await execute(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PI_INSPECT_PID: String(pid) },
  })
  return output ? JSON.parse(output) : undefined
}

async function stopProcessTree(info) {
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter \"ProcessId = $env:PI_INSPECT_PID\"; if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $env:PI_INSPECT_CREATED) { & \"$env:SystemRoot\\System32\\taskkill.exe\" /pid $p.ProcessId /t /f | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'taskkill failed' } }"
  await execute(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PI_INSPECT_PID: String(info.pid), PI_INSPECT_CREATED: info.created },
  })
}

module.exports = { execute, inspectProcess, stopProcessTree }
