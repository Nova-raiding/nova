import { describe, expect, it } from 'vitest'
// @ts-expect-error Runtime module intentionally has no TS build step.
import { commitPreparedWindowsInstallationBinding, prepareWindowsInstallationBinding, verifyWindowsInstallationBinding } from './windows-installation-binding.mjs'

describe('Windows signed package installation binding', () => {
  it('chains upgrades to one secure-store identity and commits only after success', () => {
    let identity: unknown, receipt: unknown
    const identityStore = { load: () => identity, save: (value: unknown) => { identity = value } }
    const receiptStore = { load: () => receipt, save: (value: unknown) => { receipt = value } }
    const first = prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: 'a'.repeat(64),
      pluginVersion: '0.1.0+codex.20260925075058', signerThumbprint: 'B'.repeat(40) })
    expect(receipt).toBeUndefined()
    expect(verifyWindowsInstallationBinding(first.candidate)).toBe(true)
    expect(verifyWindowsInstallationBinding({ ...first.candidate, platform: 'macos' })).toBe(false)
    first.commit()
    const second = prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: 'c'.repeat(64),
      pluginVersion: '0.1.0+codex.20260923132800', signerThumbprint: 'B'.repeat(40) })
    expect(second.candidate).toMatchObject({ installation_id: first.candidate.installation_id,
      previous_package_sha256: first.candidate.package_sha256, sequence: 2 })
    // Simulated failed upgrade: not committing leaves the last-known-good receipt intact.
    expect(receipt).toEqual(first.candidate)
    commitPreparedWindowsInstallationBinding({ identityStore, receiptStore, candidate: second.candidate })
    expect(receipt).toEqual(second.candidate)
  })

  it('rejects a tampered previous receipt instead of rotating identity or overwriting rollback evidence', () => {
    let identity: unknown, receipt: any
    const identityStore = { load: () => identity, save: (value: unknown) => { identity = value } }
    const receiptStore = { load: () => receipt, save: (value: unknown) => { receipt = value } }
    const first = prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: '1'.repeat(64),
      pluginVersion: '1.0.0', signerThumbprint: 'D'.repeat(40) })
    first.commit()
    receipt = { ...receipt, package_sha256: '2'.repeat(64) }
    expect(() => prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: '3'.repeat(64),
      pluginVersion: '1.0.1', signerThumbprint: 'D'.repeat(40) })).toThrow('LOCAL_PLUGIN_WINDOWS_INSTALLATION_BINDING_INVALID')
    expect(receipt.package_sha256).toBe('2'.repeat(64))
  })

  it('does not rotate a missing upgrade identity when a last-known-good receipt exists', () => {
    let saves = 0
    const receipt = { schema_version: '1' }
    expect(() => prepareWindowsInstallationBinding({
      identityStore: { load: () => undefined, save: () => { saves++ } },
      receiptStore: { load: () => receipt, save: () => {} },
      packageSha256: '4'.repeat(64), pluginVersion: '1.0.2', signerThumbprint: 'E'.repeat(40),
    })).toThrow('LOCAL_PLUGIN_WINDOWS_INSTALLATION_BINDING_INVALID')
    expect(saves).toBe(0)
  })

  it('rejects an out-of-order concurrent receipt commit and leaves the first committed package intact', () => {
    let identity: unknown, receipt: any
    const identityStore = { load: () => identity, save: (value: unknown) => { identity = value } }
    const receiptStore = { load: () => receipt, save: (value: unknown) => { receipt = value } }
    const first = prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: 'a'.repeat(64),
      pluginVersion: '1.0.0', signerThumbprint: 'A'.repeat(40) })
    first.commit()
    const candidateA = prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: 'b'.repeat(64),
      pluginVersion: '1.0.1', signerThumbprint: 'A'.repeat(40) })
    const candidateB = prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256: 'c'.repeat(64),
      pluginVersion: '1.0.2', signerThumbprint: 'A'.repeat(40) })
    commitPreparedWindowsInstallationBinding({ identityStore, receiptStore, candidate: candidateA.candidate })
    expect(() => commitPreparedWindowsInstallationBinding({ identityStore, receiptStore, candidate: candidateB.candidate }))
      .toThrow('LOCAL_PLUGIN_WINDOWS_INSTALLATION_BINDING_INVALID')
    expect(receipt.package_sha256).toBe('B'.repeat(64))
  })

  it('keeps the prior receipt on a failed credential-store write so the exact candidate can be retried', () => {
    let identity: unknown, receipt: any
    const identityStore = { load: () => identity, save: (value: unknown) => { identity = value } }
    const durableReceiptStore = { load: () => receipt, save: (value: unknown) => { receipt = value } }
    const initial = prepareWindowsInstallationBinding({ identityStore, receiptStore: durableReceiptStore, packageSha256: '1'.repeat(64),
      pluginVersion: '1.0.0', signerThumbprint: 'F'.repeat(40) })
    initial.commit()
    const previous = receipt
    const candidate = prepareWindowsInstallationBinding({ identityStore, receiptStore: durableReceiptStore, packageSha256: '2'.repeat(64),
      pluginVersion: '1.0.1', signerThumbprint: 'F'.repeat(40) }).candidate
    const failingReceiptStore = { load: () => receipt, save: () => { throw new Error('Credential Manager unavailable') } }
    expect(() => commitPreparedWindowsInstallationBinding({ identityStore, receiptStore: failingReceiptStore, candidate }))
      .toThrow('Credential Manager unavailable')
    expect(receipt).toEqual(previous)
    commitPreparedWindowsInstallationBinding({ identityStore, receiptStore: durableReceiptStore, candidate })
    expect(receipt.package_sha256).toBe('2'.repeat(64).toUpperCase())
  })
})
