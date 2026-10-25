[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [int]$RequiredNodeMajor = 24,
  [int]$MinimumElectronMajor = 44,
  [string]$OutputPath = "packaged-electron-runtime.json"
)

$ErrorActionPreference = "Stop"
function Stop-RuntimeVerification([string]$Message) {
  Write-Host "::error title=Packaged Electron runtime verification::$Message"
  throw $Message
}

$root = (Resolve-Path -LiteralPath $ArtifactRoot).Path
$executables = @(Get-ChildItem -LiteralPath $root -File -Filter "*.exe" | Where-Object { $_.Name -ne "Uninstall Bizamiz.exe" })
if ($executables.Count -ne 1) {
  Stop-RuntimeVerification "Expected exactly one packaged application executable in $root, found $($executables.Count): $($executables.Name -join ', ')"
}
$executablePath = $executables[0].FullName
$tempStem = Join-Path ([IO.Path]::GetTempPath()) "business-suite-electron-runtime-$([Guid]::NewGuid().ToString('N'))"
$probePath = "$tempStem.cjs"
$stdoutPath = "$tempStem.stdout.log"
$stderrPath = "$tempStem.stderr.log"
$probeSource = 'process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome}))'
[IO.File]::WriteAllText($probePath, $probeSource, (New-Object System.Text.UTF8Encoding($false)))

$prior = $env:ELECTRON_RUN_AS_NODE
$probeFailure = $null
$probeExit = $null
$raw = ""
$probeStderr = ""
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  # The packaged application is a Windows GUI-subsystem executable. Direct `&`
  # invocation can return before it exits and leave $LASTEXITCODE unset, even
  # when ELECTRON_RUN_AS_NODE makes the child behave as Node. Start-Process gives
  # us an actual process handle, bounded wait, exit code, and captured streams.
  $process = Start-Process -FilePath $executablePath `
    -ArgumentList @("`"$probePath`"") `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  if (-not $process.WaitForExit(30000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $probeFailure = "Packaged Electron runtime probe timed out after 30 seconds"
  } else {
    # A parameterless second wait ensures asynchronous redirected stream reads
    # are fully drained before the files are consumed.
    $process.WaitForExit()
    $probeExit = $process.ExitCode
  }
  if (Test-Path -LiteralPath $stdoutPath) { $raw = [IO.File]::ReadAllText($stdoutPath).Trim() }
  if (Test-Path -LiteralPath $stderrPath) { $probeStderr = [IO.File]::ReadAllText($stderrPath).Trim() }
} catch {
  $probeFailure = "Packaged Electron runtime probe could not start: $($_.Exception.Message)"
} finally {
  if ($null -eq $prior) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  } else {
    $env:ELECTRON_RUN_AS_NODE = $prior
  }
  Remove-Item -LiteralPath $probePath, $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
}
if ($probeFailure) {
  Stop-RuntimeVerification $probeFailure
}
# Windows PowerShell can leave ExitCode unavailable for a GUI-subsystem image
# even after its process handle signals. Valid version JSON is the authoritative
# success result; still reject every non-zero code when Windows exposes one.
if ($null -ne $probeExit -and $probeExit -ne 0) {
  Stop-RuntimeVerification "Packaged Electron runtime probe failed with exit code ${probeExit}. stderr: $probeStderr"
}
if ([string]::IsNullOrWhiteSpace($raw)) {
  Stop-RuntimeVerification "Packaged Electron runtime probe returned no version data. stderr: $probeStderr"
}

try {
  $versions = $raw | ConvertFrom-Json
} catch {
  Stop-RuntimeVerification "Packaged Electron runtime returned invalid version JSON: $raw"
}

$nodeMajor = if ($versions.node -match '^(\d+)\.') { [int]$Matches[1] } else { -1 }
$electronMajor = if ($versions.electron -match '^(\d+)\.') { [int]$Matches[1] } else { -1 }
if ($nodeMajor -ne $RequiredNodeMajor) {
  Stop-RuntimeVerification "Packaged Electron must carry Node.js $RequiredNodeMajor.x, found $($versions.node)"
}
if ($electronMajor -lt $MinimumElectronMajor) {
  Stop-RuntimeVerification "Packaged Electron must be $MinimumElectronMajor.x or newer, found $($versions.electron)"
}

$report = [ordered]@{
  schemaVersion = 1
  status = "PASS"
  executable = $executables[0].Name
  node = $versions.node
  electron = $versions.electron
  chromium = $versions.chrome
  requiredNodeMajor = $RequiredNodeMajor
  minimumElectronMajor = $MinimumElectronMajor
  verifiedAt = [DateTime]::UtcNow.ToString("o")
}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Packaged runtime: Electron $($versions.electron), Node.js $($versions.node), Chromium $($versions.chrome)"
