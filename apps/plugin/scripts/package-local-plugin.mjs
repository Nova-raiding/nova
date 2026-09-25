#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeBundleProvenance, provenanceFile } from './bundle-provenance.mjs'
import { verifyChatGPTMacApp } from './verify-chatgpt-macos.mjs'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(pluginRoot, '..', '..')
const git = (args) => {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`Git source provenance unavailable: ${result.stderr?.trim() || result.error?.message || result.status}`)
  return result.stdout.trim()
}
const gitCommit = git(['rev-parse', '--verify', 'HEAD'])
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
const version = String(manifest.version ?? '')
if (!version || version !== String(packageJson.version ?? '')) {
  throw new Error('plugin manifest and package versions must match before packaging')
}

const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'artifacts', 'local-plugin', `${manifest.id}-${version}-${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`))
const windowsHelperArg = process.argv.indexOf('--windows-helper-dir')
if (windowsHelperArg !== -1 && (!process.argv[windowsHelperArg + 1] || windowsHelperArg !== 3)) {
  throw new Error('usage: package-local-plugin.mjs [output.tar.gz] [--windows-helper-dir signed-binary-directory]')
}
const windowsHelperDir = windowsHelperArg === -1 ? null : resolve(process.argv[windowsHelperArg + 1])
const platform = process.platform
if (!['darwin', 'win32'].includes(platform)) throw new Error('desktop packages require macOS or Windows')
const ciTestCertificate = process.argv.includes('--ci-test-certificate')
if (ciTestCertificate && (platform !== 'win32' || !windowsHelperDir || process.env.GITHUB_ACTIONS !== 'true')) {
  throw new Error('CI test-certificate packages require a signed Windows helper on GitHub Actions')
}
if (platform === 'win32' && !windowsHelperDir) throw new Error('Windows package requires a signed credential helper; source-only output is not installable')
const architecture = process.arch
if (!['arm64', 'x64'].includes(architecture)) throw new Error('unsupported desktop architecture')
if (platform === 'win32' && architecture !== 'x64') throw new Error('Windows credential helper currently supports x64 only')
const bundledChatGPTPath = platform === 'darwin' && process.env.STORENOVA_BUNDLE_CHATGPT_APP === 'true'
  ? resolve(process.env.STORENOVA_CHATGPT_APP_PATH || '/Applications/ChatGPT.app') : null
if (bundledChatGPTPath) {
  const checked = verifyChatGPTMacApp(bundledChatGPTPath)
  if (!checked.ok) throw new Error(`bundled ChatGPT.app failed official signature verification: ${checked.reason}`)
}
const nodeVersion = 'v22.16.0'
const nodeArchiveName = platform === 'win32' ? `node-${nodeVersion}-win-${architecture}.zip` : `node-${nodeVersion}-${platform}-${architecture}.tar.gz`
// Pinned from Node.js v22.16.0's signed SHASUMS. A checksum downloaded from
// the same location as an archive cannot authenticate it on its own.
const nodeArchiveHashes = {
  'node-v22.16.0-darwin-arm64.tar.gz': '1d7f34ec4c03e12d8b33481e5c4560432d7dc31a0ef3ff5a4d9a8ada7cf6ecc9',
  'node-v22.16.0-darwin-x64.tar.gz': '838d400f7e66c804e5d11e2ecb61d6e9e878611146baff69d6a2def3cc23f4ac',
  'node-v22.16.0-win-x64.zip': '21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd',
}
const pinnedNodeHash = nodeArchiveHashes[nodeArchiveName]
if (!pinnedNodeHash) throw new Error(`bundled Node runtime has no pinned SHA-256: ${nodeArchiveName}`)
const cache = resolve(repositoryRoot, 'artifacts', 'local-plugin', 'runtime-cache')
mkdirSync(cache, { recursive: true })
const archive = resolve(cache, nodeArchiveName)
const sums = resolve(cache, `SHASUMS256-${nodeVersion}.txt`)
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...extraEnv } })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr?.trim() || result.error?.message || result.status}`)
  return result.stdout
}
function runPowerShell(script, extraEnv = {}) {
  const environment = { ...process.env, ...extraEnv }
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  let result = spawnSync('pwsh.exe', args, { encoding: 'utf8', timeout: 180_000, windowsHide: true, env: environment })
  if (result.error?.code === 'ENOENT') {
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'psmodulepath') delete environment[key]
    result = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 180_000, windowsHide: true, env: environment })
  }
  if (result.error || result.status !== 0) throw new Error(`PowerShell failed: ${result.stderr?.trim() || result.error?.message || result.status}`)
  return result.stdout
}
function downloadIfMissing(url, target) {
  if (existsSync(target)) return
  const temporary = `${target}.${process.pid}.tmp`
  try { run('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180', url, '--output', temporary]); renameSync(temporary, target) }
  finally { if (existsSync(temporary)) rmSync(temporary) }
}
downloadIfMissing(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, sums)
downloadIfMissing(`https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`, archive)
const expectedNodeHash = readFileSync(sums, 'utf8').split(/\r?\n/u)
  .map(line => line.trim().split(/\s+/u)).find(parts => parts[1] === nodeArchiveName)?.[0]
const actualNodeHash = createHash('sha256').update(readFileSync(archive)).digest('hex')
if (expectedNodeHash !== pinnedNodeHash || actualNodeHash !== pinnedNodeHash) {
  throw new Error('official Node runtime archive SHA-256 mismatch against pinned release digest')
}
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
  const signatureScript = '$s=Get-AuthenticodeSignature -LiteralPath $env:STORENOVA_VERIFY_BINARY; if ($s.Status -ne "Valid") { [Console]::Error.WriteLine("signature_status=" + $s.Status); exit 1 }; if ($null -eq $s.SignerCertificate) { [Console]::Error.WriteLine("signer_missing"); exit 1 }; if ($s.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant() -ne $env:STORENOVA_VERIFY_SIGNER) { [Console]::Error.WriteLine("signer_mismatch"); exit 1 }'
  const signatureEnvironment = { ...process.env, STORENOVA_VERIFY_BINARY: binary, STORENOVA_VERIFY_SIGNER: expectedSigner }
  let signatureCheck = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', signatureScript],
    { encoding: 'utf8', windowsHide: true, env: signatureEnvironment })
  if (signatureCheck.error?.code === 'ENOENT') {
    // A PowerShell 7 parent can give Windows PowerShell an incompatible PSModulePath.
    for (const key of Object.keys(signatureEnvironment)) if (key.toLowerCase() === 'psmodulepath') delete signatureEnvironment[key]
    signatureCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', signatureScript],
      { encoding: 'utf8', windowsHide: true, env: signatureEnvironment })
  }
  if (signatureCheck.status !== 0) throw new Error(`Windows credential helper Authenticode signature or signer mismatch: ${signatureCheck.stderr?.trim() || signatureCheck.error?.message || signatureCheck.status}`)
  windowsHelperFiles = { binary, hashFile }
}
const required = [
  '.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'README.md',
  'assets/store-nova-logo.png',
  'mcp/bridge.mjs', 'mcp/bridge.sh', 'mcp/keychain-credential.mjs', 'mcp/keychain-credential-helper.swift',
  'mcp/managed-token.mjs', 'mcp/relay-evidence.mjs', 'mcp/installation-identity.mjs', 'mcp/windows-credential.mjs',
  'mcp/windows-installation-binding.mjs',
  'macos/store-nova-connect-helper.swift',
  'scripts/build-connect-helper.mjs', 'scripts/connect-local-macos.mjs',
  'windows/StoreNovaConnectHelper.cs', 'windows/StoreNovaCredentialHelper.cs', 'windows/StoreNovaCredentialHelper.csproj',
  'scripts/build-connect-helper-windows.mjs', 'scripts/build-windows-credential-helper.mjs', 'scripts/verify-connect-helper-windows.ps1',
  'scripts/ensure-chatgpt-windows.ps1',
  'scripts/build-keychain-helper.mjs', 'scripts/diagnose-workspace-binding.mjs', 'scripts/install-local-macos.sh',
  'scripts/install-local-plugin.mjs', 'scripts/login-local-macos.mjs', 'scripts/login-local-windows.mjs', 'scripts/upgrade-installed-plugin.mjs',
  'scripts/windows-installation-binding.mjs',
  'scripts/verify-installed-bridge.mjs', 'scripts/verify-marketplace-source.mjs',
  'scripts/install-chatgpt-bundled.mjs', 'scripts/install-all-macos.mjs', 'scripts/verify-chatgpt-macos.mjs', 'scripts/launch-verified-chatgpt-macos.mjs',
  'scripts/bundle-provenance.mjs', 'scripts/verify-bundle-provenance.mjs',
  'scheduled/daily-store-risk-scan.json', 'scheduled/weekly-six-platform-digest.json',
  'skills/ecommerce-video-marketing/SKILL.md', 'skills/merchant-marketing/SKILL.md',
  'skills/six-platform-public-import/SKILL.md', 'skills/storyboard-prompt-assistant/SKILL.md',
  'skills/ecommerce-video-marketing/references/culture_adaptation.md',
  'skills/ecommerce-video-marketing/references/shot_guide.md',
  'skills/ecommerce-video-marketing/references/video_guide.md',
  'skills/ecommerce-video-marketing/references/video_templates.md',
  'skills/six-platform-public-import/references/platforms.md',
  'skills/six-platform-public-import/scripts/extract-product.mjs',
  'skills/merchant-marketing/references/automations.md',
  'skills/merchant-marketing/references/ecommerce-detail-page-generator.md',
  'skills/merchant-marketing/references/ecommerce-detail-page-generator/category-playbooks.md',
  'skills/merchant-marketing/references/ecommerce-detail-page-generator/page-spec.schema.json',
  'skills/merchant-marketing/references/ecommerce-detail-page-generator/platform-profiles.json',
  'skills/merchant-marketing/references/ecommerce-detail-page-generator/platform-style-guide.md',
  'skills/merchant-marketing/references/ecommerce-detail-page-generator/prompt-recipes.md',
  'ui/image-local-edit.html', 'ui/recharge.html',
]
for (const relativePath of required) {
  if (!existsSync(resolve(pluginRoot, relativePath))) throw new Error(`local plugin input is missing: ${relativePath}`)
}
// Only source files copied into the bundle and build-time code that determines
// its contents affect the package's Git provenance. Other applications may be
// edited concurrently in the same worktree without changing this artifact.
const sourceProvenanceInputs = [...new Set([
  ...required,
  'scripts/package-local-plugin.mjs',
  'scripts/verify-chatgpt-macos.mjs',
])].map(relativePath => `apps/plugin/${relativePath}`)
const sourceDirty = Boolean(git(['status', '--porcelain', '--untracked-files=all', '--', ...sourceProvenanceInputs]))

const staging = mkdtempSync(resolve(repositoryRoot, '.local-plugin-package-'))
try {
  for (const relativePath of required) {
    const destination = resolve(staging, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(resolve(pluginRoot, relativePath), destination, { recursive: true })
  }
  const runtimeFolder = resolve(staging, 'runtime')
  mkdirSync(runtimeFolder, { recursive: true })
  const extracted = mkdtempSync(resolve(cache, '.node-extract-'))
  try {
    if (platform === 'win32') {
      runPowerShell('Expand-Archive -LiteralPath $env:STORENOVA_NODE_ARCHIVE -DestinationPath $env:STORENOVA_NODE_EXTRACT -Force',
        { STORENOVA_NODE_ARCHIVE: archive, STORENOVA_NODE_EXTRACT: extracted })
      cpSync(resolve(extracted, `node-${nodeVersion}-win-${architecture}`, 'node.exe'), resolve(runtimeFolder, 'node.exe'))
    } else {
      run('tar', ['-xzf', archive, '-C', extracted, `node-${nodeVersion}-${platform}-${architecture}/bin/node`])
      cpSync(resolve(extracted, `node-${nodeVersion}-${platform}-${architecture}`, 'bin', 'node'), resolve(runtimeFolder, 'node'))
    }
  } finally { rmSync(extracted, { recursive: true, force: true }) }
  chmodSync(resolve(runtimeFolder, platform === 'win32' ? 'node.exe' : 'node'), 0o755)
  const runtimeProbe = run(resolve(runtimeFolder, platform === 'win32' ? 'node.exe' : 'node'), ['-p', '`${process.platform}/${process.arch}/${process.versions.node}`'])
  if (runtimeProbe.trim() !== `${platform}/${architecture}/${nodeVersion.slice(1)}`) throw new Error('bundled Node runtime platform/version mismatch')
  if (platform === 'darwin') {
    const helperSource = resolve(staging, 'mcp/keychain-credential-helper.swift')
    const helperBinary = resolve(staging, 'mcp/keychain-credential-helper')
    const swiftArchitecture = architecture === 'x64' ? 'x86_64' : architecture
    run('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${swiftArchitecture}-apple-macos11.0`, helperSource, '-o', helperBinary])
    chmodSync(helperBinary, 0o700)
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    writeFileSync(resolve(staging, 'mcp/keychain-credential-helper.build.json'), `${JSON.stringify({ schema_version: '1', source_sha256: digest(helperSource), binary_sha256: digest(helperBinary), platform, arch: architecture })}\n`)
  }
  if (bundledChatGPTPath) {
    // Keep the official app's internal symlinks intact; provenance hashes the
    // archive as one input and the installer expands it with ditto.
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundledChatGPTPath, resolve(staging, 'ChatGPT.app.zip')])
  }
  if (windowsHelperFiles) writeFileSync(resolve(staging, 'windows/credential-signer.txt'), `${String(process.env.STORENOVA_WINDOWS_SIGNER_THUMBPRINT).replace(/\s/gu, '').toUpperCase()}\n`)
  const mcpConfig = JSON.parse(readFileSync(resolve(staging, '.mcp.json'), 'utf8'))
  mcpConfig.mcpServers['merchant-marketing'].command = platform === 'win32' ? './runtime/node.exe' : './runtime/node'
  writeFileSync(resolve(staging, '.mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`)
  if (windowsHelperFiles) {
    cpSync(windowsHelperFiles.binary, resolve(staging, 'windows/StoreNovaCredentialHelper.exe'))
    cpSync(windowsHelperFiles.hashFile, resolve(staging, 'windows/StoreNovaCredentialHelper.exe.sha256'))
  }
  writeFileSync(resolve(staging, 'marketplace.json'), `${JSON.stringify({ name: 'merchant-local', interface: { displayName: 'Merchant Local' }, plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2)}\n`)
  const installer = `#!/bin/sh\nset -eu\nroot=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)\n"$root/runtime/node" "$root/scripts/install-chatgpt-bundled.mjs"\n`
  writeFileSync(resolve(staging, 'install.sh'), installer)
  chmodSync(resolve(staging, 'install.sh'), 0o755)
  writeFileSync(resolve(staging, 'login.sh'), '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$root/runtime/node" "$root/scripts/login-local-macos.mjs" --base-url https://yxsona.com "$@"\n')
  chmodSync(resolve(staging, 'login.sh'), 0o755)
  writeFileSync(resolve(staging, 'install.command'), '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nsh "$root/install.sh"\nprintf "请输入管理员分配的工作区 ID（ws_...）："\nIFS= read -r workspace || workspace=""\nif [ -z "$workspace" ]; then echo "插件已安装，但工作区绑定未完成。获得工作区后运行 login.sh --workspace ws_..."; exit 42; fi\nsh "$root/login.sh" --workspace "$workspace"\nprintf "安装与登录已完成。请完全重启 ChatGPT，在插件页启用 Merchant Marketing，并在新对话验证 onboarding.status。\\n"\n')
  chmodSync(resolve(staging, 'install.command'), 0o755)
  if (platform === 'darwin') {
    writeFileSync(resolve(staging, 'install-all.command'), '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$root/runtime/node" "$root/scripts/install-all-macos.mjs"\n')
    chmodSync(resolve(staging, 'install-all.command'), 0o755)
  }
  const windowsPluginPowerShell = [
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$credentialHelper = Join-Path $root "windows\\StoreNovaCredentialHelper.exe"',
    '$credentialHashFile = Join-Path $root "windows\\StoreNovaCredentialHelper.exe.sha256"',
    'if (-not (Test-Path -LiteralPath $credentialHelper -PathType Leaf)) { throw "Windows credential helper is missing" }',
    'if (-not (Test-Path -LiteralPath $credentialHashFile -PathType Leaf)) { throw "Windows credential helper SHA-256 evidence is missing" }',
    '$expectedHash = ((Get-Content -LiteralPath $credentialHashFile -Raw).Trim() -split "\\s+")[0].ToUpperInvariant()',
    '$actualHash = (Get-FileHash -LiteralPath $credentialHelper -Algorithm SHA256).Hash.ToUpperInvariant()',
    'if ($expectedHash -notmatch "^[0-9A-F]{64}$" -or $actualHash -ne $expectedHash) { throw "Windows credential helper SHA-256 mismatch" }',
    '$expectedSigner = (Get-Content -LiteralPath (Join-Path $root "windows\\credential-signer.txt") -Raw).Trim()',
    'if ($expectedSigner -notmatch "^[0-9A-F]{40,64}$") { throw "Trusted Windows signer thumbprint is not configured" }',
    '$signature = Get-AuthenticodeSignature -LiteralPath $credentialHelper',
    'if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) { throw "Windows credential helper Authenticode signature is invalid" }',
    'if ($signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant() -ne $expectedSigner.Replace(" ", "").ToUpperInvariant()) { throw "Windows credential helper signer mismatch" }',
    '& (Join-Path $root "runtime\\node.exe") (Join-Path $root "scripts\\install-chatgpt-bundled.mjs")',
    'if ($LASTEXITCODE -ne 0) { throw "Store Nova local installation failed" }',
    '$workspace = Read-Host "Enter your assigned Store Nova workspace ID (ws_...)"',
    'if (-not [string]::IsNullOrWhiteSpace($workspace)) {',
    '  & (Join-Path $root "runtime\\node.exe") (Join-Path $root "scripts\\login-local-windows.mjs") --base-url https://yxsona.com --workspace $workspace',
    '  if ($LASTEXITCODE -ne 0) { throw "Store Nova login failed" }',
    '} else { Write-Host "Login pending. Run login.cmd --workspace <assigned-workspace> when available." }',
    'Write-Host "Restart ChatGPT, enable Merchant Marketing, then verify onboarding.status in a new conversation."',
    'exit 0',
  ].join('\r\n')
  const directWindowsInstallDenied = 'throw "Run the separately signed .install.ps1 beside the ZIP; direct ZIP installation is not trusted."\r\n'
  writeFileSync(resolve(staging, 'install-plugin.ps1'), platform === 'win32' ? directWindowsInstallDenied : windowsPluginPowerShell)
  writeFileSync(resolve(staging, 'install-chatgpt.ps1'), platform === 'win32' ? directWindowsInstallDenied : [
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '& (Join-Path $root "scripts\\ensure-chatgpt-windows.ps1")',
    '& (Join-Path $root "install-plugin.ps1")',
    'exit 0',
  ].join('\r\n'))
  writeFileSync(resolve(staging, 'login.cmd'), '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\login-local-windows.mjs" --base-url https://yxsona.com %*\r\nexit /b %ERRORLEVEL%\r\n')
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
    'echo This ZIP cannot install itself. Run the separately signed .install.ps1 beside the ZIP.',
    'exit /b 1',
    '',
  ].join('\r\n')
  writeFileSync(resolve(staging, 'install.cmd'), windowsInstaller)
  const bundleStatus = {
    schema_version: '1',
    release_status: platform === 'darwin' ? 'unsigned_candidate' : ciTestCertificate ? 'ci_test_only' : 'signed_candidate',
    ready_to_install: platform === 'win32' && Boolean(windowsHelperFiles) && !ciTestCertificate && !sourceDirty,
    ci_test_certificate: ciTestCertificate,
    source_dirty: sourceDirty,
    chatgpt_app_bundled: Boolean(bundledChatGPTPath),
  }
  if (sourceDirty) bundleStatus.release_status = 'dirty_source_candidate'
  writeFileSync(resolve(staging, 'bundle-status.json'), `${JSON.stringify(bundleStatus, null, 2)}\n`)
  writeBundleProvenance(staging, { plugin: manifest.id, version, platform, architecture, gitCommit, sourceDirty })
  const packageEntries = [...required, 'runtime', ...(platform === 'darwin' ? ['mcp/keychain-credential-helper', 'mcp/keychain-credential-helper.build.json', 'login.sh', 'install.command', 'install-all.command'] : []), ...(bundledChatGPTPath ? ['ChatGPT.app.zip'] : []), ...(windowsHelperFiles ? ['windows/StoreNovaCredentialHelper.exe', 'windows/StoreNovaCredentialHelper.exe.sha256', 'windows/credential-signer.txt'] : []), 'marketplace.json', 'install.sh', 'install.cmd', 'login.cmd', 'install-plugin.ps1', 'install-chatgpt.ps1', '.agents/plugins/marketplace.json', 'bundle-status.json', provenanceFile]
  mkdirSync(dirname(output), { recursive: true })
  if (platform === 'win32') {
    if (!output.toLowerCase().endsWith('.zip')) throw new Error('Windows deliverable must be a .zip file')
    const temporary = `${output}.${process.pid}.tmp`
    try {
      runPowerShell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:STORENOVA_PACKAGE_STAGING, $env:STORENOVA_PACKAGE_OUTPUT)',
        { STORENOVA_PACKAGE_STAGING: staging, STORENOVA_PACKAGE_OUTPUT: temporary })
      if (existsSync(output)) rmSync(output)
      renameSync(temporary, output)
    } finally { if (existsSync(temporary)) rmSync(temporary) }
  } else {
    const result = spawnSync('tar', ['-czf', output, '-C', staging, ...packageEntries], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr?.trim() || 'tar failed while creating local plugin package')
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: output,
    plugin: manifest.id,
    version,
    platform,
    architecture,
    bundled_node_version: nodeVersion,
    git_commit: gitCommit,
    // The macOS tarball is a locally runnable candidate. Gatekeeper-ready
    // distribution requires Developer ID signing and Apple notarization.
    ...bundleStatus,
    cloud_code_included: false,
    connect_helper: {
      source_included: true,
      app_bundle_included: Boolean(bundledChatGPTPath),
      custom_scheme: 'development_recovery_only',
      production_ready: false,
      reason: 'Custom-scheme helper binaries are not shipped until platform signing and installation-instance binding are enforced.',
      platforms: {
        darwin: { source_included: true, binary_included: false },
        win32: { source_included: true, binary_included: false, authenticode_required: true },
      },
    },
  }, null, 2)}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
