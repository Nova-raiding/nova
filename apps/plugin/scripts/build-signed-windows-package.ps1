param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$CertificateThumbprint,
  [string]$HelperDirectory,
  [string]$TimestampServer,
  [switch]$CiTestCertificate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'A Windows signing host is required' }
$thumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[0-9A-F]{40,64}$') { throw 'A valid signing certificate thumbprint is required' }
if ($CiTestCertificate -and $env:GITHUB_ACTIONS -ne 'true') { throw 'Test-certificate mode is restricted to GitHub Actions' }
if (-not $CiTestCertificate -and [string]::IsNullOrWhiteSpace($TimestampServer)) { throw 'A timestamp server is required for a production Windows package' }

$output = [System.IO.Path]::GetFullPath($OutputPath)
if (-not $output.EndsWith('.zip', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Windows package output must end in .zip' }
if (Test-Path -LiteralPath $output) { throw 'Output package already exists' }
if (Test-Path -LiteralPath "$output.sha256") { throw 'Output package checksum already exists' }
$outputDirectory = Split-Path -Parent $output
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$pluginRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $pluginRoot)
$dirty = & git -C $repoRoot status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Production Windows package requires a clean Git source tree' }
$helper = if ([string]::IsNullOrWhiteSpace($HelperDirectory)) {
  Join-Path $env:TEMP ('storenova-helper-' + [guid]::NewGuid().ToString('N'))
} else {
  [System.IO.Path]::GetFullPath($HelperDirectory)
}
$ownsHelper = [string]::IsNullOrWhiteSpace($HelperDirectory)
$extract = Join-Path $env:TEMP ('storenova-package-check-' + [guid]::NewGuid().ToString('N'))
$verified = $false

try {
  if ($ownsHelper) {
    & node (Join-Path $PSScriptRoot 'build-windows-credential-helper.mjs') $helper
    if ($LASTEXITCODE -ne 0) { throw 'Self-contained credential helper build failed' }
  }
  $binary = Join-Path $helper 'StoreNovaCredentialHelper.exe'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Credential helper executable is missing' }

  $certificate = @(Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My |
    Where-Object { $_.Thumbprint.Replace(' ', '').ToUpperInvariant() -eq $thumbprint -and $_.HasPrivateKey } |
    Select-Object -First 1)
  if ($certificate.Count -ne 1) { throw 'Signing certificate with a usable private key is unavailable' }
  if ($certificate[0].NotBefore -gt (Get-Date) -or $certificate[0].NotAfter -lt (Get-Date)) { throw 'Signing certificate is outside its validity period' }
  if ($CiTestCertificate -and $certificate[0].Subject -ne 'CN=Store Nova CI package test only') { throw 'Test-certificate mode requires the runner-local test certificate' }
  $codeSigningOid = '1.3.6.1.5.5.7.3.3'
  $signingUsages = @($certificate[0].Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] })
  $hasCodeSigningUsage = $false
  if ($signingUsages.Count -eq 1) {
    foreach ($usage in $signingUsages[0].EnhancedKeyUsages) {
      if ($usage.Value -eq $codeSigningOid) { $hasCodeSigningUsage = $true; break }
    }
  }
  if (-not $hasCodeSigningUsage) {
    throw 'Signing certificate must explicitly allow Authenticode code signing'
  }
  if (-not $CiTestCertificate) {
    if ($certificate[0].Subject -eq 'CN=Store Nova CI package test only') { throw 'The CI test certificate cannot sign a production package' }
    if ($certificate[0].Subject -eq $certificate[0].Issuer) { throw 'A self-signed certificate cannot sign a production package' }
  }

  $signingArguments = @{ FilePath = $binary; Certificate = $certificate[0]; HashAlgorithm = 'SHA256' }
  if (-not [string]::IsNullOrWhiteSpace($TimestampServer)) { $signingArguments.TimestampServer = $TimestampServer }
  $signed = Set-AuthenticodeSignature @signingArguments
  if ($null -eq $signed.SignerCertificate -or $signed.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant() -ne $thumbprint) {
    throw 'Credential helper signature was not attached by the expected certificate'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $binary
  if ($signature.Status -ne 'Valid') { throw "Credential helper signature is not trusted: $($signature.Status)" }
  if (-not $CiTestCertificate -and $null -eq $signature.TimeStamperCertificate) { throw 'Production credential helper has no trusted timestamp' }

  $helperHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToUpperInvariant()
  [System.IO.File]::WriteAllText("$binary.sha256", "$helperHash`n", [System.Text.Encoding]::ASCII)
  $env:STORENOVA_WINDOWS_SIGNER_THUMBPRINT = $thumbprint
  $packageArguments = @((Join-Path $PSScriptRoot 'package-local-plugin.mjs'), $output, '--windows-helper-dir', $helper)
  if ($CiTestCertificate) { $packageArguments += '--ci-test-certificate' }
  $packageResultText = & node @packageArguments
  if ($LASTEXITCODE -ne 0) { throw 'Windows plugin packaging failed' }
  $packageResult = ($packageResultText -join "`n") | ConvertFrom-Json
  $expectedStatus = if ($CiTestCertificate) { 'ci_test_only' } else { 'signed_candidate' }
  $expectedReady = -not [bool]$CiTestCertificate
  if ($packageResult.release_status -ne $expectedStatus -or $packageResult.ready_to_install -ne $expectedReady -or $packageResult.ci_test_certificate -ne [bool]$CiTestCertificate) {
    throw 'Windows package release status does not match its signing certificate mode'
  }

  Expand-Archive -LiteralPath $output -DestinationPath $extract
  $bundleStatus = Get-Content -LiteralPath (Join-Path $extract 'bundle-status.json') -Raw | ConvertFrom-Json
  if ($bundleStatus.release_status -ne $expectedStatus -or $bundleStatus.ready_to_install -ne $expectedReady -or $bundleStatus.ci_test_certificate -ne [bool]$CiTestCertificate) {
    throw 'Archived Windows bundle status does not match its signing certificate mode'
  }
  $packagedHelper = Join-Path $extract 'windows\StoreNovaCredentialHelper.exe'
  $packagedHash = (Get-FileHash -LiteralPath $packagedHelper -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($packagedHash -ne $helperHash) { throw 'Packaged credential helper differs from the signed executable' }
  $packagedNode = Join-Path $extract 'runtime\node.exe'
  $nodeSignature = Get-AuthenticodeSignature -LiteralPath $packagedNode
  if ($nodeSignature.Status -ne 'Valid' -or $null -eq $nodeSignature.SignerCertificate) {
    throw "Bundled Windows Node Authenticode signature is not trusted: $($nodeSignature.Status)"
  }
  if ($nodeSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=OpenJS Foundation(?:,|$)') {
    throw 'Bundled Windows Node executable was not signed by the expected upstream publisher'
  }
  if ($null -eq $nodeSignature.TimeStamperCertificate) {
    throw 'Bundled Windows Node executable has no trusted timestamp'
  }
  $nodeVersion = & $packagedNode --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v22.16.0') { throw 'Bundled Windows Node runtime failed verification' }
  $packageHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToUpperInvariant()
  [System.IO.File]::WriteAllText("$output.sha256", "$packageHash`n", [System.Text.Encoding]::ASCII)
  $verified = $true
  [pscustomobject]@{ ok = $true; artifact = $output; sha256 = $packageHash; signer = $thumbprint; bundled_node = $nodeVersion; release_status = $expectedStatus; ready_to_install = $expectedReady; ci_test_certificate = [bool]$CiTestCertificate } |
    ConvertTo-Json -Compress | Write-Output
} finally {
  if (-not $verified) {
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
    if (Test-Path -LiteralPath "$output.sha256") { Remove-Item -LiteralPath "$output.sha256" -Force }
  }
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  if ($ownsHelper -and (Test-Path -LiteralPath $helper)) { Remove-Item -LiteralPath $helper -Recurse -Force }
}
