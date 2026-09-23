#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(pluginRoot, '..', '..')
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (!version || version !== String(packageJson.version ?? '')) {
  throw new Error('plugin manifest and package versions must match before packaging')
}

const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'artifacts', 'local-plugin', `${manifest.id}-${version}.tar.gz`))
const windowsHelperArg = process.argv.indexOf('--windows-helper-dir')
if (windowsHelperArg !== -1 && (!process.argv[windowsHelperArg + 1] || windowsHelperArg !== 3)) {
  throw new Error('usage: package-local-plugin.mjs [output.tar.gz] [--windows-helper-dir signed-binary-directory]')
}
const windowsHelperDir = windowsHelperArg === -1 ? null : resolve(process.argv[windowsHelperArg + 1])
let windowsHelperFiles = null
if (windowsHelperDir) {
  if (process.platform !== 'win32') throw new Error('signed Windows helper packaging must run on Windows')
  const expectedSigner = String(process.env.STORENOVA_WINDOWS_SIGNER_THUMBPRINT ?? '').replace(/\s/gu, '').toUpperCase()
  if (!/^[0-9A-F]{40,64}$/u.test(expectedSigner)) throw new Error('trusted Windows signer thumbprint is required for helper packaging')
  const binary = resolve(windowsHelperDir, 'StoreNovaCredentialHelper.exe')
  const hashFile = resolve(windowsHelperDir, 'StoreNovaCredentialHelper.exe.sha256')
  if (!existsSync(binary) || !existsSync(hashFile)) throw new Error('signed Windows credential helper and SHA-256 file are both required')
  const expectedHash = readFileSync(hashFile, 'utf8').trim().split(/\s+/u)[0]?.toUpperCase()
  const actualHash = createHash('sha256').update(readFileSync(binary)).digest('hex').toUpperCase()
  if (!/^[0-9A-F]{64}$/u.test(expectedHash ?? '') || expectedHash !== actualHash) throw new Error('Windows credential helper SHA-256 mismatch')
  const signatureCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s=Get-AuthenticodeSignature -LiteralPath $env:STORENOVA_VERIFY_BINARY; if ($s.Status -ne "Valid" -or $null -eq $s.SignerCertificate -or $s.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant() -ne $env:STORENOVA_WINDOWS_SIGNER_THUMBPRINT.Replace(" ", "").ToUpperInvariant()) { exit 1 }'],
  { encoding: 'utf8', windowsHide: true, env: { ...process.env, STORENOVA_VERIFY_BINARY: binary } })
  if (signatureCheck.status !== 0) throw new Error('Windows credential helper Authenticode signature or signer mismatch')
  windowsHelperFiles = { binary, hashFile }
}
const required = [
  '.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'README.md',
  'assets/store-nova-logo.png',
  'mcp/bridge.mjs', 'mcp/bridge.sh', 'mcp/keychain-credential.mjs', 'mcp/keychain-credential-helper.swift',
  'mcp/managed-token.mjs', 'mcp/relay-evidence.mjs', 'mcp/installation-identity.mjs', 'mcp/windows-credential.mjs',
  'macos/store-nova-connect-helper.swift',
  'scripts/build-connect-helper.mjs', 'scripts/connect-local-macos.mjs',
  'windows/StoreNovaConnectHelper.cs', 'windows/StoreNovaCredentialHelper.cs', 'windows/StoreNovaCredentialHelper.csproj',
  'scripts/build-connect-helper-windows.mjs', 'scripts/build-windows-credential-helper.mjs', 'scripts/verify-connect-helper-windows.ps1',
  'scripts/build-keychain-helper.mjs', 'scripts/diagnose-workspace-binding.mjs', 'scripts/install-local-macos.sh',
  'scripts/install-local-plugin.mjs', 'scripts/login-local-macos.mjs', 'scripts/login-local-windows.mjs', 'scripts/upgrade-installed-plugin.mjs',
  'scripts/verify-installed-bridge.mjs', 'scripts/verify-marketplace-source.mjs',
  'scheduled/daily-store-risk-scan.json', 'scheduled/weekly-six-platform-digest.json',
  'skills/ecommerce-video-marketing/SKILL.md', 'skills/merchant-marketing/SKILL.md',
  'skills/six-platform-public-import/SKILL.md', 'skills/storyboard-prompt-assistant/SKILL.md',
  'ui/image-local-edit.html', 'ui/recharge.html',
]
for (const relativePath of required) {
  if (!existsSync(resolve(pluginRoot, relativePath))) throw new Error(`local plugin input is missing: ${relativePath}`)
}

const staging = mkdtempSync(resolve(repositoryRoot, '.local-plugin-package-'))
try {
  for (const relativePath of required) {
    const destination = resolve(staging, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(resolve(pluginRoot, relativePath), destination, { recursive: true })
  }
  if (windowsHelperFiles) {
    cpSync(windowsHelperFiles.binary, resolve(staging, 'windows/StoreNovaCredentialHelper.exe'))
    cpSync(windowsHelperFiles.hashFile, resolve(staging, 'windows/StoreNovaCredentialHelper.exe.sha256'))
  }
  writeFileSync(resolve(staging, 'marketplace.json'), `${JSON.stringify({ name: 'merchant-local', interface: { displayName: 'Merchant Local' }, plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2)}\n`)
  const installer = `#!/bin/sh\nset -eu\nroot=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)\ncommand -v codex >/dev/null 2>&1 || { echo 'codex CLI is required' >&2; exit 2; }\ncommand -v node >/dev/null 2>&1 || { echo 'Node.js 18+ is required' >&2; exit 2; }\nversion=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$root/.codex-plugin/plugin.json")\nlocal_root="\${CODEX_HOME:-\$HOME/.codex}/merchant-local-packages/merchant-marketing/\$version"\nmkdir -p "$local_root/plugin"\ncp -R "$root/." "$local_root/plugin/"\nprintf '%s\\n' '{"name":"merchant-local","interface":{"displayName":"Merchant Local"},"plugins":[{"name":"merchant-marketing","source":{"source":"local","path":"./plugin"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}' > "$local_root/marketplace.json"\ncodex plugin marketplace add "$local_root" --json >/dev/null 2>&1 || true\ncodex plugin add "merchant-marketing@merchant-local" --json\nprintf '%s\\n' "Store Nova installed: version=$version. Restart ChatGPT/Codex to load the local stdio plugin."\n`
  writeFileSync(resolve(staging, 'install.sh'), installer)
  chmodSync(resolve(staging, 'install.sh'), 0o755)
  const windowsPowerShell = [
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$credentialHelper = Join-Path $root "windows\\StoreNovaCredentialHelper.exe"',
    '$credentialHashFile = Join-Path $root "windows\\StoreNovaCredentialHelper.exe.sha256"',
    'if (-not (Test-Path -LiteralPath $credentialHelper -PathType Leaf)) { throw "Windows credential helper is missing; this source-only package cannot complete local login" }',
    'if (-not (Test-Path -LiteralPath $credentialHashFile -PathType Leaf)) { throw "Windows credential helper SHA-256 evidence is missing" }',
    '$expectedHash = ((Get-Content -LiteralPath $credentialHashFile -Raw).Trim() -split "\\s+")[0].ToUpperInvariant()',
    '$actualHash = (Get-FileHash -LiteralPath $credentialHelper -Algorithm SHA256).Hash.ToUpperInvariant()',
    'if ($expectedHash -notmatch "^[0-9A-F]{64}$" -or $actualHash -ne $expectedHash) { throw "Windows credential helper SHA-256 mismatch" }',
    '$expectedSigner = $env:STORENOVA_WINDOWS_SIGNER_THUMBPRINT',
    'if ([string]::IsNullOrWhiteSpace($expectedSigner)) { throw "Trusted Windows signer thumbprint is not configured" }',
    '$signature = Get-AuthenticodeSignature -LiteralPath $credentialHelper',
    'if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) { throw "Windows credential helper Authenticode signature is invalid" }',
    'if ($signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant() -ne $expectedSigner.Replace(" ", "").ToUpperInvariant()) { throw "Windows credential helper signer mismatch" }',
    '$pluginRoot = Join-Path $env:USERPROFILE ".codex\\plugins\\merchant-marketing"',
    '$marketplaceRoot = Join-Path $env:USERPROFILE ".agents\\plugins"',
    '$marketplacePath = Join-Path $marketplaceRoot "marketplace.json"',
    '$storeNovaEntry = @{ name = "merchant-marketing"; source = @{ source = "local"; path = "../../.codex/plugins/merchant-marketing" }; policy = @{ installation = "AVAILABLE"; authentication = "ON_INSTALL" }; category = "Productivity" }',
    '$existingMarketplace = $null',
    'if (Test-Path -LiteralPath $marketplacePath -PathType Leaf) {',
    '  $existingMarketplace = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json',
    '  if ($null -eq $existingMarketplace -or $existingMarketplace -isnot [pscustomobject] -or $existingMarketplace.plugins -isnot [array]) { throw "Existing personal marketplace is invalid; refusing to overwrite it" }',
    '  $otherPlugins = @($existingMarketplace.plugins | Where-Object { $_.name -ne "merchant-marketing" })',
    '  $existingMarketplace | Add-Member -NotePropertyName plugins -NotePropertyValue @($otherPlugins + $storeNovaEntry) -Force',
    '  $marketplace = $existingMarketplace',
    '} else {',
    '  $marketplace = @{ name = "merchant-personal"; interface = @{ displayName = "Merchant Marketing" }; plugins = @($storeNovaEntry) }',
    '}',
    '$marketplaceJson = $marketplace | ConvertTo-Json -Depth 32',
    'New-Item -ItemType Directory -Force -Path $pluginRoot, $marketplaceRoot | Out-Null',
    'Copy-Item -Path (Join-Path $root "*") -Destination $pluginRoot -Recurse -Force',
    '$temporaryPath = Join-Path $marketplaceRoot ("marketplace.json." + [guid]::NewGuid().ToString("N") + ".tmp")',
    'try {',
    '  [System.IO.File]::WriteAllText($temporaryPath, $marketplaceJson, [System.Text.UTF8Encoding]::new($false))',
    '  if (Test-Path -LiteralPath $marketplacePath -PathType Leaf) {',
    '    $backupPath = Join-Path $marketplaceRoot ("marketplace.json." + [guid]::NewGuid().ToString("N") + ".bak")',
    '    [System.IO.File]::Replace($temporaryPath, $marketplacePath, $backupPath)',
    '  } else { Move-Item -LiteralPath $temporaryPath -Destination $marketplacePath }',
    '} finally { if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force } }',
    'Write-Host "Store Nova plugin source copied to the local desktop plugin directory."',
    'Write-Host "Fully restart the ChatGPT desktop app, open Plugins, and install Merchant Marketing."',
    'Write-Host "A workspace must be bound through the local login flow; this installer does not select one."',
    'Write-Host "Windows login requires the credential helper and a workspace assigned by Store Nova. Run node scripts/login-local-windows.mjs --base-url https://yxsona.com --workspace <assigned-workspace> from the installed plugin directory."',
  ].join('\r\n')
  writeFileSync(resolve(staging, 'install-chatgpt.ps1'), windowsPowerShell)
  const chatgptMarketplace = {
    name: 'merchant-personal',
    interface: { displayName: 'Merchant Marketing' },
    plugins: [{
      name: 'merchant-marketing',
      source: { source: 'local', path: './' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  }
  mkdirSync(resolve(staging, '.agents/plugins'), { recursive: true })
  writeFileSync(resolve(staging, '.agents/plugins/marketplace.json'), `${JSON.stringify(chatgptMarketplace, null, 2)}\n`)
  const windowsInstaller = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-chatgpt.ps1"',
    'if errorlevel 1 (echo Store Nova installation failed. & pause & exit /b 1)',
    'echo Store Nova plugin source copied. Restart ChatGPT, install Merchant Marketing, then complete local workspace login.',
    'pause',
    '',
  ].join('\r\n')
  writeFileSync(resolve(staging, 'install.cmd'), windowsInstaller)
  const packageEntries = [...required, ...(windowsHelperFiles ? ['windows/StoreNovaCredentialHelper.exe', 'windows/StoreNovaCredentialHelper.exe.sha256'] : []), 'marketplace.json', 'install.sh', 'install.cmd', 'install-chatgpt.ps1', '.agents/plugins/marketplace.json']
  mkdirSync(dirname(output), { recursive: true })
  const result = spawnSync('tar', ['-czf', output, '-C', staging, ...packageEntries], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'tar failed while creating local plugin package')
  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: output,
    plugin: manifest.id,
    version,
    cloud_code_included: false,
    connect_helper: {
      source_included: true,
      app_bundle_included: false,
      custom_scheme: 'development_recovery_only',
      production_ready: false,
      reason: 'Custom-scheme helper binaries are not shipped until platform signing and installation-instance binding are enforced.',
      platforms: {
        darwin: { source_included: true, binary_included: false },
        win32: { source_included: true, binary_included: Boolean(windowsHelperFiles), authenticode_required: true },
      },
    },
  }, null, 2)}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
