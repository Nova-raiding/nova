param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Identity read from the Store-signed x64 MSIX linked by OpenAI's Windows
# deployment guide. A changed publisher requires a reviewed package update.
$packageName = 'OpenAI.Codex'
$publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
$storeId = '9PLM9XGG6VKS'
$officialInstaller = "https://get.microsoft.com/installer/download/$storeId"

if (-not [System.Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw 'This Store Nova plugin package requires x64 Windows. Use a matching package for another architecture.'
}

function Get-TrustedChatGPTPackage {
  $packages = @(Get-AppxPackage -Name $packageName -ErrorAction Stop)
  foreach ($package in $packages) {
    if ($package.Publisher -ne $publisher -or
        $package.SignatureKind.ToString() -ne 'Store' -or
        $package.Architecture.ToString() -ne 'X64') {
      throw "An OpenAI.Codex package is present but its publisher, Store signature, or architecture is untrusted: $($package.PackageFullName)"
    }
  }
  return $packages
}

$installed = @(Get-TrustedChatGPTPackage)
if ($installed.Count -eq 0 -and $VerifyOnly) {
  throw 'CHATGPT_APP_REQUIRED: The official ChatGPT desktop app is not installed for this Windows user.'
}
if ($installed.Count -eq 0) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    & $winget.Source install --id $storeId --source msstore --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "Official Microsoft Store installation failed (winget exit $LASTEXITCODE)." }
  } else {
    Write-Host 'Opening the official ChatGPT Windows installer. Complete its installation, then return here.'
    Start-Process -FilePath $officialInstaller
    [void](Read-Host 'Press Enter after the official installer reports success')
  }
  $installed = @(Get-TrustedChatGPTPackage)
  if ($installed.Count -eq 0) {
    throw 'CHATGPT_APP_REQUIRED: The official ChatGPT app is not registered for this Windows user. Finish installation or sign out and back in, then retry.'
  }
}

Write-Host "Verified official ChatGPT desktop app: $($installed[0].PackageFullName)"
