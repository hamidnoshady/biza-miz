$ErrorActionPreference = 'Continue'
$env:DEBUG = 'next:*'
$logPath = Join-Path (Get-Location) '.next-build-ci.log'
if (Test-Path $logPath) { Remove-Item -LiteralPath $logPath -Force }

npm run build 2>&1 | Tee-Object -FilePath $logPath
$buildExitCode = $LASTEXITCODE
if ($buildExitCode -ne 0) {
  Write-Host '::group::Next.js production build diagnostics (last 180 lines)'
  Get-Content -LiteralPath $logPath -Tail 180 | ForEach-Object {
    Write-Host ("::error::NEXT_BUILD: " + $_)
  }
  Write-Host '::endgroup::'
  exit $buildExitCode
}
