param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Sha256File,
  [string]$ExpectedSignerThumbprint = $env:STORENOVA_WINDOWS_SIGNER_THUMBPRINT
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Windows helper executable is missing' }
if (-not (Test-Path -LiteralPath $Sha256File -PathType Leaf)) { throw 'Windows helper SHA-256 evidence is missing' }
$expected = ((Get-Content -LiteralPath $Sha256File -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected) { throw 'Windows helper SHA-256 mismatch' }
if ([string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)) { throw 'Trusted Windows signer thumbprint is not configured' }
$signature = Get-AuthenticodeSignature -LiteralPath $Executable
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Windows helper Authenticode signature is not valid' }
$actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
$wantedThumbprint = $ExpectedSignerThumbprint.Replace(' ', '').ToUpperInvariant()
if ($actualThumbprint -ne $wantedThumbprint) { throw 'Windows helper signer is not trusted for Store Nova' }

# Signature and hash are necessary but not sufficient: the current custom
# protocol has no installation-instance binding, so registration/install stays
# fail-closed even after signature verification.
[ordered]@{
  ok = $true
  hash_verified = $true
  signature_verified = $true
  signer_thumbprint = $actualThumbprint
  protocol_registered = $false
  installed = $false
  production_ready = $false
  blocker = 'installation_instance_binding_missing'
} | ConvertTo-Json -Compress
exit 78
