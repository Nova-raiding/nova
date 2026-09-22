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
})
