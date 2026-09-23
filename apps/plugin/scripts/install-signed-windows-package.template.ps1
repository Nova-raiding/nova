param([string]$PackagePath, [string]$WorkspaceId)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This file is rendered and Authenticode-signed OUTSIDE the ZIP by the release builder.
# Never execute code from the ZIP until its complete digest matches this signed file.
$expectedHash = '__STORENOVA_PACKAGE_SHA256__'
$expectedSigner = '__STORENOVA_SIGNER_THUMBPRINT__'
$ciTestOnly = __STORENOVA_CI_TEST_ONLY__
if ($ciTestOnly -and $env:GITHUB_ACTIONS -ne 'true') { throw 'CI test package cannot be installed outside GitHub Actions' }
$signature = Get-AuthenticodeSignature -LiteralPath $PSCommandPath
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'External installer Authenticode signature is invalid' }
if ($signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant() -ne $expectedSigner) { throw 'External installer signer mismatch' }

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $PackagePath = $PSCommandPath -replace '\.install\.ps1$', '.zip'
  if ($PackagePath -eq $PSCommandPath) { throw 'Signed installer filename must end in .install.ps1' }
}
$package = [System.IO.Path]::GetFullPath($PackagePath)
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw 'Windows plugin ZIP is missing' }
$extract = Join-Path $env:TEMP ('storenova-verified-install-' + [guid]::NewGuid().ToString('N'))
$lockedPackage = [System.IO.File]::Open($package, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $actualHash = [System.BitConverter]::ToString($sha256.ComputeHash($lockedPackage)).Replace('-', '') }
  finally { $sha256.Dispose() }
  if ($actualHash -ne $expectedHash) { throw 'Windows plugin ZIP hash does not match the signed installer' }
  # Extract from the same verified open handle; never reopen a pathname that could be swapped.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $lockedPackage.Position = 0
  $archive = [System.IO.Compression.ZipArchive]::new($lockedPackage, [System.IO.Compression.ZipArchiveMode]::Read, $true)
  try { [System.IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $extract) }
  finally { $archive.Dispose() }
  $runtime = Join-Path $extract 'runtime\node.exe'
  $installer = Join-Path $extract 'scripts\install-chatgpt-bundled.mjs'
  $preflight = Join-Path $extract 'scripts\ensure-chatgpt-windows.ps1'
  $helper = Join-Path $extract 'windows\StoreNovaCredentialHelper.exe'
  $helperHashPath = "$helper.sha256"
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf) -or -not (Test-Path -LiteralPath $installer -PathType Leaf) -or
      -not (Test-Path -LiteralPath $preflight -PathType Leaf) -or -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
      -not (Test-Path -LiteralPath $helperHashPath -PathType Leaf)) {
    throw 'Verified Windows package is missing its runtime, official-host preflight, credential helper, or installer'
  }
  if (-not $ciTestOnly -and [string]::IsNullOrWhiteSpace($WorkspaceId)) {
    $WorkspaceId = Read-Host 'Enter your assigned Store Nova workspace ID (ws_...), or press Enter to bind later'
  }
  if (-not [string]::IsNullOrWhiteSpace($WorkspaceId) -and
      $WorkspaceId -cnotmatch '^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$') {
    throw 'Store Nova workspace ID is invalid; plugin files were not changed'
  }
  # The signed bootstrap authenticates the whole ZIP before invoking this included preflight.
  & $preflight
  $helperSignature = Get-AuthenticodeSignature -LiteralPath $helper
  if ($helperSignature.Status -ne 'Valid' -or $null -eq $helperSignature.SignerCertificate -or
      $helperSignature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant() -ne $expectedSigner) {
    throw 'Windows credential helper signature does not match the signed installer'
  }
  $expectedHelperHash = (Get-Content -LiteralPath $helperHashPath -Raw).Trim().ToUpperInvariant()
  if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToUpperInvariant() -ne $expectedHelperHash) {
    throw 'Windows credential helper digest differs from the verified ZIP record'
  }
  & $runtime $installer
  if ($LASTEXITCODE -ne 0) { throw 'Store Nova local plugin installation failed' }
  if (-not $ciTestOnly) {
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceId)) {
      & $runtime (Join-Path $extract 'scripts\login-local-windows.mjs') --base-url https://yxsona.com --workspace $WorkspaceId
      if ($LASTEXITCODE -ne 0) { throw 'Store Nova local plugin login failed' }
    } else {
      Write-Host 'Login pending. Run login.cmd --workspace <assigned-workspace> when available.'
    }
  }
  Write-Host 'Store Nova plugin installed. Restart ChatGPT and verify onboarding.status in a new conversation.'
} finally {
  $lockedPackage.Dispose()
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
}
