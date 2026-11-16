[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [string]$ManifestPath = "config/windows-signing-manifest.json",
  [ValidateSet("signed", "unsigned-development")][string]$Mode = "signed",
  [string]$ExpectedSigner = $env:WINDOWS_EXPECTED_SIGNER,
  [string]$ExpectedThumbprint = $env:WINDOWS_EXPECTED_SIGNER_THUMBPRINT,
  [ValidatePattern('^[0-9a-f]{40}$')][string]$CandidateCommit = $env:GITHUB_SHA,
  [string]$OutputPath = "windows-signature-verification.json"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $ArtifactRoot).Path
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw "Unsupported signing manifest schema: $($manifest.schemaVersion)" }
if ($Mode -eq "signed" -and [string]::IsNullOrWhiteSpace($ExpectedSigner)) {
  throw "ExpectedSigner/WINDOWS_EXPECTED_SIGNER is required in signed mode"
}
# Issue #1000 - a publisher name is not an identity. Signed verification pins the
# exact signing certificate thumbprint, and a missing pin is a refusal.
$pinnedThumbprint = if ($ExpectedThumbprint) { ($ExpectedThumbprint -replace '[\s:]', '').ToUpperInvariant() } else { "" }
if ($Mode -eq "signed" -and $pinnedThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw "ExpectedThumbprint/WINDOWS_EXPECTED_SIGNER_THUMBPRINT must be a 40-character SHA-1 thumbprint in signed mode"
}

$results = @()
$failed = $false
foreach ($entry in $manifest.required) {
  $nativePattern = ([string]$entry.pattern).Replace("/", [IO.Path]::DirectorySeparatorChar)
  $matches = @(Get-ChildItem -Path (Join-Path $root $nativePattern) -File -ErrorAction SilentlyContinue)
  if ($matches.Count -ne [int]$entry.exactly) {
    Write-Host "::error title=Signing manifest mismatch::$($entry.id) expected $($entry.exactly), found $($matches.Count): $($entry.pattern)"
    $failed = $true
    continue
  }

  foreach ($file in $matches) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    $signerCommonName = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }
    $thumbprint = if ($signature.SignerCertificate) { ([string]$signature.SignerCertificate.Thumbprint).ToUpperInvariant() } else { $null }
    $timestampSigner = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
    $valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
    $signerMatches = $signer -and (
      [string]::Equals($signer, $ExpectedSigner, [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($signerCommonName, $ExpectedSigner, [StringComparison]::OrdinalIgnoreCase)
    )
    $thumbprintMatches = $thumbprint -and [string]::Equals($thumbprint, $pinnedThumbprint, [StringComparison]::OrdinalIgnoreCase)
    $timestamped = -not [string]::IsNullOrWhiteSpace($timestampSigner)
    $accepted = if ($Mode -eq "signed") {
      $valid -and $signerMatches -and $thumbprintMatches -and $timestamped
    } else {
      $signature.Status -eq [System.Management.Automation.SignatureStatus]::NotSigned
    }

    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relative = $file.FullName.Substring($root.Length).TrimStart("\", "/").Replace("\", "/")
    $results += [ordered]@{
      id = [string]$entry.id
      path = $relative
      bytes = $file.Length
      sha256 = $hash
      status = [string]$signature.Status
      signer = $signer
      signerCommonName = $signerCommonName
      thumbprint = $thumbprint
      timestampSigner = $timestampSigner
      accepted = $accepted
    }
    if (-not $accepted) {
      $failed = $true
      Write-Host "::error file=$relative,title=Authenticode verification failed::mode=$Mode status=$($signature.Status) expectedSigner=$ExpectedSigner signer=$signer signerCommonName=$signerCommonName expectedThumbprint=$pinnedThumbprint thumbprint=$thumbprint timestampSigner=$timestampSigner"
    } else {
      Write-Host "Verified $relative ($Mode, sha256:$hash, thumbprint:$thumbprint)"
    }
  }
}

$report = [ordered]@{
  schemaVersion = 1
  mode = $Mode
  expectedSigner = if ($Mode -eq "signed") { $ExpectedSigner } else { $null }
  expectedThumbprint = if ($Mode -eq "signed") { $pinnedThumbprint } else { $null }
  rfc3161TimestampRequired = $Mode -eq "signed"
  commit = $CandidateCommit
  generatedAt = [DateTime]::UtcNow.ToString("o")
  artifacts = $results
  passed = -not $failed
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
if ($failed) { throw "Windows signature verification failed; see $OutputPath" }
