# Issue #984 — installs the published Biza Support Companion on Windows.
#
# Per-user by default (no admin): EXE to %LocalAppData%\Biza Support Companion,
# protocol to HKCU. -Machine installs to %ProgramFiles% + HKLM (requires an
# elevated prompt). Data (%LocalAppData%\Biza\SupportCompanion) is created on
# first run; update-keys.json must be placed by the operator (see README).
#
# This script never signs: releases ship unsigned until the release-signing
# setup is provisioned (exact gap in packaging/README.md). If a signature is
# present it is verified and reported, never skipped silently.
#
# Usage (from an unpacked publish dir):
#   .\install.ps1 -SourceDir .\publish
#   .\install.ps1 -SourceDir .\publish -Machine

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [switch]$Machine
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$exeName = "BizaSupportCompanion.exe"
$appDirName = "Biza Support Companion"
$protocol = "biza-support"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$sourceExe = Join-Path $SourceDir $exeName
if (-not (Test-Path $sourceExe -PathType Leaf)) {
    throw "Source EXE not found: $sourceExe (pass the publish dir via -SourceDir)."
}

if ($Machine -and -not (Test-Administrator)) {
    throw "-Machine requires an elevated prompt. Re-run as administrator, or omit -Machine for a per-user install."
}

$installRoot = if ($Machine) {
    Join-Path $env:ProgramFiles $appDirName
} else {
    Join-Path $env:LOCALAPPDATA $appDirName
}

Write-Host "Installing $exeName to $installRoot ..."
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
Copy-Item -Force $sourceExe (Join-Path $installRoot $exeName)

$signature = Get-AuthenticodeSignature (Join-Path $installRoot $exeName)
if ($signature.Status -eq "Valid") {
    Write-Host ("Signed by: {0}" -f $signature.SignerCertificate.Subject)
} else {
    Write-Warning ("UNSIGNED: {0} (status {1}). Sign releases before distribution; see packaging/README.md." -f $exeName, $signature.Status)
}

# Protocol: biza-support://... -> EXE "%1". HKLM for machine, HKCU per-user.
# The cross-runtime maintenance gate meets at %ProgramData%\Biza, which only
# an elevated install can create. Per-user installs reuse it once it exists.
if ($Machine) {
    $gateDir = Join-Path $env:ProgramData "Biza"
    New-Item -ItemType Directory -Force -Path $gateDir | Out-Null
    $acl = Get-Acl $gateDir
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "BUILTIN\Users", "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl $gateDir $acl
    Write-Host "Maintenance gate dir ready: $gateDir"
}

$classesRoot = if ($Machine) { "HKLM:\SOFTWARE\Classes" } else { "HKCU:\Software\Classes" }
$protoKey = Join-Path $classesRoot $protocol
New-Item -Force -Path $protoKey | Out-Null
Set-ItemProperty $protoKey -Name "(Default)" -Value "Biza Support Companion link"
Set-ItemProperty $protoKey -Name "URL Protocol" -Value ""
$commandKey = Join-Path $protoKey "shell\open\command"
New-Item -Force -Path $commandKey | Out-Null
$target = Join-Path $installRoot $exeName
Set-ItemProperty $commandKey -Name "(Default)" -Value "`"$target`" `"%1`""

Write-Host "Protocol $protocol registered."
Write-Host "Done. Data dir: $(Join-Path $env:LOCALAPPDATA 'Biza\SupportCompanion')"
Write-Host "Next: place the release authority's update-keys.json in the data dir (see packaging/README.md), then enroll from the app."
