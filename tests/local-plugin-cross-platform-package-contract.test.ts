import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('local plugin cross-platform helper package contract', () => {
  it('keeps the unsigned Windows launcher fail-closed until instance binding exists', () => {
    const launcher = read('../apps/plugin/windows/StoreNovaConnectHelper.cs')
    const verifier = read('../apps/plugin/scripts/verify-connect-helper-windows.ps1')

    expect(launcher).toContain('STORE_NOVA_CONNECT_WINDOWS_NOT_PRODUCTION_READY')
    expect(launcher).toContain('return 78')
    expect(verifier).toContain("protocol_registered = $false")
    expect(verifier).toContain("installed = $false")
    expect(verifier).toContain("production_ready = $false")
    expect(verifier).toContain("blocker = 'installation_instance_binding_missing'")
    expect(verifier).toContain('Get-AuthenticodeSignature')
    expect(verifier).toContain('STORENOVA_WINDOWS_SIGNER_THUMBPRINT')
  })

  it('does not embed credentials or register a protocol from the placeholder binary', () => {
    const launcher = read('../apps/plugin/windows/StoreNovaConnectHelper.cs')
    expect(launcher).not.toMatch(/access_token|refresh_token|password|pairing_token|CredentialManager|CredWrite|RegistryKey/iu)
  })

  it('requires platform-native trusted builds instead of cross-building Windows on macOS', () => {
    const builder = read('../apps/plugin/scripts/build-connect-helper-windows.mjs')
    expect(builder).toContain("process.platform !== 'win32'")
    expect(builder).toContain('STORENOVA_WINDOWS_CSC_PATH')
    expect(builder).toContain('signed: false')
    expect(builder).toContain('production_ready: false')
  })
})
