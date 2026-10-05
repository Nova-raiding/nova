import { describe, expect, it, vi } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { CommercialAbsoluteCapacityError } from '../../../packages/persistence/src/commercial-capacity-admission.js'
import { recoverKnownPlatformAccountAdmissionRollback, requireKnownEffectiveStorageSnapshot } from './platform-account-persistence-recovery.js'
function register(service: MerchantService, workspaceId = 'ws_oauth') {
  return service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'store-1', credentialRef: 'secret-reference' })
}
const rejection = new CommercialAbsoluteCapacityError('max_stores', 2, 1)
describe('OAuth account memory after persistence rejection', () => {
  it('removes only the exact rejected tenant account after durable repository proves absence', async () => {
    const service = new MerchantService(), attempted = register(service), other = register(service, 'ws_other')
    expect(await recoverKnownPlatformAccountAdmissionRollback({ workspaceId: attempted.workspaceId, attempted, error: rejection, service, readDurable: async () => undefined })).toBe('removed')
    expect(service.platformAccounts.has(attempted.id)).toBe(false)
    expect(service.platformAccounts.get(other.id)).toEqual(other)
  })
  it('restores a prior durable revoked account using hydrateSnapshot exact entity.id key', async () => {
    const service = new MerchantService(), attempted = register(service)
    const durable = { ...attempted, tokenState: 'revoked', revision: 1, authRevision: 1, credentialRef: 'old-secret-reference' }
    expect(await recoverKnownPlatformAccountAdmissionRollback({ workspaceId: attempted.workspaceId, attempted, error: rejection, service, readDurable: async () => durable })).toBe('restored')
    expect(service.platformAccounts.get(attempted.id)).toMatchObject(durable)
    expect(service.platformAccounts.has(`${attempted.workspaceId}:${attempted.id}`)).toBe(false)
  })
  it('does not read/remove on unknown commit outcome or overwrite a newer concurrent registration', async () => {
    const service = new MerchantService(), attempted = register(service), readDurable = vi.fn(async () => undefined)
    expect(await recoverKnownPlatformAccountAdmissionRollback({ workspaceId: attempted.workspaceId, attempted, error: new Error('connection lost after COMMIT'), service, readDurable })).toBe('unknown_outcome')
    expect(service.platformAccounts.get(attempted.id)).toBe(attempted)
    const newer = register(service)
    expect(await recoverKnownPlatformAccountAdmissionRollback({ workspaceId: attempted.workspaceId, attempted, error: rejection, service, readDurable })).toBe('superseded')
    expect(service.platformAccounts.get(attempted.id)).toBe(newer)
    expect(readDurable).not.toHaveBeenCalled()
  })
  it('unavailable or wrong-tenant durable read never deletes and blocks transient connected credential use', async () => {
    for (const readDurable of [async () => { throw new Error('database unavailable') }, async () => ({ id: 'foreign', workspaceId: 'ws_other' })]) {
      const service = new MerchantService(), attempted = register(service)
      expect(await recoverKnownPlatformAccountAdmissionRollback({ workspaceId: attempted.workspaceId, attempted, error: rejection, service, readDurable })).toBe('read_unavailable')
      expect(service.platformAccounts.get(attempted.id)).toMatchObject({ id: attempted.id, workspaceId: attempted.workspaceId, tokenState: 'refresh_required' })
    }
  })
  it('does not overwrite a later in-place revocation during the durable read', async () => {
    const service = new MerchantService(), attempted = register(service), attemptedRevision = attempted.revision
    expect(await recoverKnownPlatformAccountAdmissionRollback({ workspaceId: attempted.workspaceId, attempted, attemptedRevision, error: rejection, service,
      readDurable: async () => { service.revokePlatformAccount(attempted.workspaceId, attempted.id); return undefined } })).toBe('superseded')
    expect(service.platformAccounts.get(attempted.id)).toMatchObject({ tokenState: 'revoked', revision: attemptedRevision + 1 })
  })
})
describe('effective storage quota usage evidence', () => {
  it('missing ledger cannot assert zero and known ledger preserves used/reserved while replacing only limit', () => {
    expect(() => requireKnownEffectiveStorageSnapshot(1000, undefined)).toThrow('存储用量台账')
    expect(() => requireKnownEffectiveStorageSnapshot(1000, { usedBytes: NaN, reservedBytes: 0 })).toThrow('存储用量台账')
    expect(requireKnownEffectiveStorageSnapshot(1000, { usedBytes: 900, reservedBytes: 150 })).toEqual({ limitBytes: 1000, usedBytes: 900, reservedBytes: 150 })
  })
})
