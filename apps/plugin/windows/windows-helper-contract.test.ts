import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows helper source contract', () => {
  it('protects secrets with CurrentUser DPAPI before Credential Manager persistence', () => {
    const source = readFileSync('apps/plugin/windows/StoreNovaCredentialHelper.cs', 'utf8')
    expect(source).toContain('ProtectedData.Protect')
    expect(source).toContain('ProtectedData.Unprotect')
    expect(source).toContain('DataProtectionScope.CurrentUser')
    expect(source).toContain('SHA256.HashData')
    expect(source).not.toMatch(/Console\.(?:Write|WriteLine)\(.*(?:data|secret|clear)/u)
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
    expect(bootstrap).toContain('Get-AuthenticodeSignature -LiteralPath $PSCommandPath')
    expect(bootstrap).toContain('__STORENOVA_PACKAGE_SHA256__')
    expect(bootstrap).toContain('[System.IO.FileShare]::Read')
    expect(bootstrap.indexOf('if ($actualHash -ne $expectedHash)')).toBeLessThan(bootstrap.indexOf('ExtractToDirectory'))
    expect(bootstrap.indexOf('ExtractToDirectory')).toBeLessThan(bootstrap.indexOf('& $preflight'))
    expect(bootstrap.indexOf('& $preflight')).toBeLessThan(bootstrap.indexOf('& $runtime $installer'))
    expect(workflow).toContain("$signedEntry.IndexOf('& $runtime $installer') -le $signedEntry.IndexOf('& $preflight')")
    expect(bootstrap).toContain('Get-AuthenticodeSignature -LiteralPath $helper')
    expect(builder).toContain("throw 'A timestamp server is required for a production Windows package'")
    expect(builder).toContain('Set-AuthenticodeSignature @bootstrapSigningArguments')
    expect(packaging).toContain('direct ZIP installation is not trusted')
    expect(packaging).toContain("writeFileSync(resolve(staging, 'install-plugin.ps1'), platform === 'win32' ? directWindowsInstallDenied")
  })
})
