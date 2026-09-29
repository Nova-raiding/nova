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
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'Windows per-user application data path is unavailable' }
$lockDirectory = Join-Path $env:LOCALAPPDATA 'StoreNova'
New-Item -ItemType Directory -Force -Path $lockDirectory | Out-Null
$lockPath = Join-Path $lockDirectory 'merchant-marketing-install.lock'
try {
  # FileShare.None is released by Windows if this process exits or crashes. The
  # same per-user path coordinates installers across terminal/login sessions.
  $installerLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  throw 'Another Store Nova installation is already running for this Windows user. Wait for it to finish, then retry.'
}
$extract = Join-Path $env:TEMP ('storenova-verified-install-' + [guid]::NewGuid().ToString('N'))
$lockedPackage = $null
try {
  $lockedPackage = [System.IO.File]::Open($package, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
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
  $bindingScript = Join-Path $extract 'scripts\windows-installation-binding.mjs'
  $helperHashPath = "$helper.sha256"
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf) -or -not (Test-Path -LiteralPath $installer -PathType Leaf) -or
      -not (Test-Path -LiteralPath $preflight -PathType Leaf) -or -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
      -not (Test-Path -LiteralPath $helperHashPath -PathType Leaf) -or -not (Test-Path -LiteralPath $bindingScript -PathType Leaf)) {
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
  $pluginVersion = (Get-Content -LiteralPath (Join-Path $extract 'package.json') -Raw | ConvertFrom-Json).version
  if ([string]::IsNullOrWhiteSpace($pluginVersion)) { throw 'Verified Windows package has no plugin version' }

  # Login can fail independently of installation. Complete it before replacing
  # the last-known-good package so an auth/network failure leaves its receipt
  # and installed files aligned.
  if (-not $ciTestOnly -and -not [string]::IsNullOrWhiteSpace($WorkspaceId)) {
    & $runtime (Join-Path $extract 'scripts\login-local-windows.mjs') --base-url https://yxsona.com --workspace $WorkspaceId
    if ($LASTEXITCODE -ne 0) { throw 'Store Nova local plugin login failed; the installed package and its receipt were not changed' }
  }

  $bindingCandidate = & $runtime $bindingScript prepare --package-sha256 $expectedHash --plugin-version $pluginVersion --signer-thumbprint $expectedSigner
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($bindingCandidate -join ''))) {
    throw 'Windows installation identity binding preflight failed; plugin files were not changed'
  }
  try { $bindingRecord = ($bindingCandidate -join "`n") | ConvertFrom-Json }
  catch { throw 'Windows installation identity binding preflight returned invalid data; plugin files were not changed' }
  if ($bindingRecord.package_sha256 -ne $expectedHash -or $bindingRecord.plugin_version -ne $pluginVersion -or
      $bindingRecord.signer_thumbprint -ne $expectedSigner) {
    throw 'Windows installation identity binding does not match this signed package; plugin files were not changed'
  }

  $installResultText = & $runtime $installer
  if ($LASTEXITCODE -ne 0) { throw 'Store Nova local plugin installation failed' }
  try { $installResult = ($installResultText -join "`n") | ConvertFrom-Json }
  catch { throw 'Store Nova installer did not return verifiable installation paths; package receipt was not changed' }
  if ($installResult.ok -ne $true -or $installResult.plugin -ne 'merchant-marketing' -or $installResult.version -ne $pluginVersion -or
      [string]::IsNullOrWhiteSpace($installResult.source) -or [string]::IsNullOrWhiteSpace($installResult.installed)) {
    throw 'Store Nova installer result does not identify the expected installed package; package receipt was not changed'
  }

  $verifyScript = Join-Path $extract 'scripts\verify-bundle-provenance.mjs'
  $expectedSource = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'plugins\merchant-marketing'))
  $actualSource = [System.IO.Path]::GetFullPath($installResult.source)
  $codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { Join-Path $env:USERPROFILE '.codex' } else { $env:CODEX_HOME }
  $expectedCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $codexHome 'plugins\cache')) + [System.IO.Path]::DirectorySeparatorChar
  $actualCache = [System.IO.Path]::GetFullPath($installResult.installed)
  if (-not [string]::Equals($actualSource, $expectedSource, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not $actualCache.StartsWith($expectedCacheRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Store Nova installer returned a path outside the current user plugin directories; package receipt was not changed'
  }

  foreach ($installedPath in @($actualSource, $actualCache)) {
    $verificationText = & $runtime $verifyScript $installedPath --installed
    if ($LASTEXITCODE -ne 0) { throw 'Installed Store Nova package provenance verification failed; package receipt was not changed' }
    try { $verification = ($verificationText -join "`n") | ConvertFrom-Json }
    catch { throw 'Installed Store Nova package provenance result is invalid; package receipt was not changed' }
    if ($verification.ok -ne $true -or $verification.version -ne $pluginVersion -or
        $verification.platform -ne 'win32' -or $verification.architecture -ne 'x64') {
      throw 'Installed Store Nova package does not match the verified Windows release; package receipt was not changed'
    }
    $installedProvenance = [System.IO.File]::ReadAllText((Join-Path $installedPath 'bundle-provenance.json'))
    $candidateProvenance = [System.IO.File]::ReadAllText((Join-Path $extract 'bundle-provenance.json'))
    if ($installedProvenance -cne $candidateProvenance) {
      throw 'Installed Store Nova package provenance differs from the signed candidate; package receipt was not changed'
    }
  }

  # The process lock remains held from before prepare through this verification
  # and commit, preventing two signed installers from committing out of order.
  ($bindingCandidate -join "`n") | & $runtime $bindingScript commit
  if ($LASTEXITCODE -ne 0) {
    throw "WINDOWS_INSTALLATION_RECEIPT_COMMIT_FAILED: the signed package is installed and verified, but Credential Manager did not confirm its receipt. Do not install another package. Re-run this exact signed installer to reconcile the receipt (package SHA-256: $expectedHash); if asked for a workspace, press Enter to skip login and retry the receipt commit. The prior receipt was preserved unless the credential helper completed its write before reporting the failure."
  }
  if (-not $ciTestOnly -and [string]::IsNullOrWhiteSpace($WorkspaceId)) {
    Write-Host 'Login pending. Run login.cmd --workspace <assigned-workspace> when available.'
  }
  Write-Host 'Store Nova plugin installed. Restart ChatGPT and verify onboarding.status in a new conversation.'
} finally {
  try {
    if ($null -ne $lockedPackage) { $lockedPackage.Dispose() }
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  } finally { $installerLock.Dispose() }
}
