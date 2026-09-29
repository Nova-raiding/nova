import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows helper source contract', () => {
  it('allows exactly the credential targets used by the Windows stores, including installation receipts', () => {
    const source = readFileSync('apps/plugin/windows/StoreNovaCredentialHelper.cs', 'utf8')
    const stores = readFileSync('apps/plugin/mcp/windows-credential.mjs', 'utf8')
    const allowedTargets = [...source.matchAll(/request\.target != "([^"]+)"/gu)].map(match => match[1]).sort()
    const storeTargets = [...new Set([...stores.matchAll(/'(com\.storenova\.[^']+)'/gu)].map(match => match[1]))].sort()
    expect(storeTargets).toEqual([
      'com.storenova.installation-binding',
      'com.storenova.installation-identity',
      'com.storenova.merchant-mcp',
    ])
    expect(allowedTargets).toEqual(storeTargets)
    expect(source).toContain('|| !System.Text.RegularExpressions.Regex.IsMatch(request.account, "^(?:[a-f0-9]{64}|current-installation)$")) return 1;')
  })

  it('protects secrets with CurrentUser DPAPI before Credential Manager persistence', () => {
    const source = readFileSync('apps/plugin/windows/StoreNovaCredentialHelper.cs', 'utf8')
    expect(source).toContain('ProtectedData.Protect')
    expect(source).toContain('ProtectedData.Unprotect')
    expect(source).toContain('DataProtectionScope.CurrentUser')
    expect(source).toContain('SHA256.HashData')
    expect(source).not.toMatch(/Console\.(?:Write|WriteLine)\(.*(?:data|secret|clear)/u)
  })

  it('returns a dedicated oversized protected-blob exit before CredWrite', () => {
    const source = readFileSync('apps/plugin/windows/StoreNovaCredentialHelper.cs', 'utf8')
    const protect = source.indexOf('secret = ProtectedData.Protect(clear, entropy, DataProtectionScope.CurrentUser)')
    const sizeGuard = source.indexOf('if (secret.Length > MAX_CREDENTIAL_BLOB_BYTES) { Array.Clear(secret); return EXIT_CREDENTIAL_BLOB_TOO_LARGE; }')
    const write = source.indexOf('if (CredWrite(ref credential, 0)) return 0;')
    expect(source).toContain('const int EXIT_CREDENTIAL_BLOB_TOO_LARGE = 78;')
    expect(protect).toBeGreaterThan(-1)
    expect(sizeGuard).toBeGreaterThan(protect)
    expect(write).toBeGreaterThan(sizeGuard)
  })

  it('keeps custom protocol execution fail-closed before trusted enrollment and signing', () => {
    const source = readFileSync('apps/plugin/windows/StoreNovaConnectHelper.cs', 'utf8')
    expect(source).toContain('STORE_NOVA_CONNECT_WINDOWS_NOT_PRODUCTION_READY')
    expect(source).toContain('return 78')
    expect(source).not.toContain('Process.Start')
  })

  it('requires an external signed installer to bind the full ZIP before extraction', () => {
    const bootstrap = readFileSync('apps/plugin/scripts/install-signed-windows-package.template.ps1', 'utf8')
    const builder = readFileSync('apps/plugin/scripts/build-signed-windows-package.ps1', 'utf8')
    const packaging = readFileSync('apps/plugin/scripts/package-local-plugin.mjs', 'utf8')
    const workflow = readFileSync('.github/workflows/windows-plugin-package.yml', 'utf8')
    expect(workflow).toContain('      - main')
    expect(workflow).toContain("      - '.codex-marketplace/plugins/merchant-marketing/**'")
    expect(bootstrap).toContain('Get-AuthenticodeSignature -LiteralPath $PSCommandPath')
    expect(bootstrap).toContain('__STORENOVA_PACKAGE_SHA256__')
    expect(bootstrap).toContain('[System.IO.FileShare]::Read')
    expect(bootstrap.indexOf('if ($actualHash -ne $expectedHash)')).toBeLessThan(bootstrap.indexOf('ExtractToDirectory'))
    expect(bootstrap.indexOf('ExtractToDirectory')).toBeLessThan(bootstrap.indexOf('& $preflight'))
    expect(bootstrap.indexOf("$WorkspaceId -cnotmatch '^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$'")).toBeLessThan(bootstrap.indexOf('& $preflight'))
    expect(bootstrap.indexOf('& $preflight')).toBeLessThan(bootstrap.indexOf('& $runtime $installer'))
    expect(workflow).toContain("$signedEntry.IndexOf('& $runtime $installer') -le $signedEntry.IndexOf('& $preflight')")
    expect(bootstrap).toContain('Get-AuthenticodeSignature -LiteralPath $helper')
    expect(builder).toContain("throw 'A timestamp server is required for a production Windows package'")
    expect(builder).toContain('Set-AuthenticodeSignature @bootstrapSigningArguments')
    expect(packaging).toContain('direct ZIP installation is not trusted')
    expect(packaging).toContain("writeFileSync(resolve(staging, 'install-plugin.ps1'), platform === 'win32' ? directWindowsInstallDenied")
    expect(bootstrap).toContain('$bindingScript prepare --package-sha256 $expectedHash')
    expect(bootstrap.indexOf('$bindingScript prepare')).toBeLessThan(bootstrap.indexOf('$installResultText = & $runtime $installer'))
    expect(bootstrap.indexOf('$installResultText = & $runtime $installer')).toBeLessThan(bootstrap.indexOf('$bindingScript commit'))
  })

  it('serializes signed installs and verifies both installed copies before committing their receipt', () => {
    const bootstrap = readFileSync('apps/plugin/scripts/install-signed-windows-package.template.ps1', 'utf8')
    const lockAcquire = bootstrap.indexOf('[System.IO.File]::Open($lockPath')
    const prepare = bootstrap.indexOf('$bindingScript prepare')
    const install = bootstrap.indexOf('$installResultText = & $runtime $installer')
    const provenanceCheck = bootstrap.indexOf('& $runtime $verifyScript $installedPath --installed')
    const commit = bootstrap.indexOf('$bindingScript commit')
    const lockDispose = bootstrap.indexOf('$installerLock.Dispose()')
    expect(bootstrap).toContain('[System.IO.FileShare]::None')
    expect(lockAcquire).toBeGreaterThan(-1)
    expect(lockAcquire).toBeLessThan(prepare)
    expect(prepare).toBeLessThan(install)
    expect(install).toBeLessThan(provenanceCheck)
    expect(provenanceCheck).toBeLessThan(commit)
    expect(commit).toBeLessThan(lockDispose)
    expect(bootstrap).toContain('bundle-provenance.json')
    expect(bootstrap).toContain('Installed Store Nova package provenance differs from the signed candidate')
  })

  it('runs login before changing installed files and gives deterministic recovery instructions if receipt commit fails', () => {
    const bootstrap = readFileSync('apps/plugin/scripts/install-signed-windows-package.template.ps1', 'utf8')
    const login = bootstrap.indexOf("scripts\\login-local-windows.mjs")
    const install = bootstrap.indexOf('$installResultText = & $runtime $installer')
    const commit = bootstrap.indexOf('$bindingScript commit')
    expect(login).toBeGreaterThan(-1)
    expect(login).toBeLessThan(install)
    expect(bootstrap).toContain('the installed package and its receipt were not changed')
    expect(commit).toBeGreaterThan(install)
    expect(bootstrap).toContain('WINDOWS_INSTALLATION_RECEIPT_COMMIT_FAILED')
    expect(bootstrap).toContain('Re-run this exact signed installer to reconcile the receipt')
    expect(bootstrap).not.toContain('previous binding remains the last-known-good upgrade receipt')
  })
})
