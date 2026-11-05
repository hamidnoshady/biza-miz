$ErrorActionPreference = 'Continue'
$logPath = Join-Path (Get-Location) '.next-build-ci.log'
if (Test-Path $logPath) { Remove-Item -LiteralPath $logPath -Force }

npm run build 2>&1 | Tee-Object -FilePath $logPath
$buildExitCode = $LASTEXITCODE
if ($buildExitCode -ne 0) {
  Write-Host '::group::Next.js production build diagnostics (last 180 lines)'
  $diagnostics = Select-String -LiteralPath $logPath -Pattern '(?i)(error|fatal|out of memory|heap|exception|killed|failed)' | Select-Object -Last 120
  if ($diagnostics) {
    $diagnostics | ForEach-Object { Write-Host ("::error::NEXT_BUILD: " + $_.Line) }
  } else {
    Get-Content -LiteralPath $logPath -Tail 100 | ForEach-Object {
      Write-Host ("::error::NEXT_BUILD: " + $_)
    }
  }
  Write-Host '::endgroup::'
  exit $buildExitCode
}
