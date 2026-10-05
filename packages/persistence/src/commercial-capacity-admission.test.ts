import { describe, expect, it, vi } from 'vitest'
import { requireCommercialAbsoluteCapacityInTransaction } from './commercial-capacity-admission.js'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'
import { PostgresBusinessRepository } from './business-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const active = { period_start: '2000-01-01T00:00:00.000Z', period_end: '2100-01-01T00:00:00.000Z', period_status: 'active', executable: true, checksum: 'a'.repeat(64), unresolved_blockers: [], resolved_benefits: [{ code: 'max_brands', quantity: 2 }, { code: 'max_stores', quantity: 3 }] }
function client(usage: Record<string, unknown> = { used: 1 }, rows = [active]) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('merchant_entitlement') ? rows : sql.includes('count(') ? [usage] : [] }))
  return { query, release: vi.fn() } as unknown as SqlClient
}
describe('absolute capacity check inside consumer transaction', () => {
  it('locks the contract first, then resolves current quota and actual all-brand usage', async () => {
    const db = client()
    await requireCommercialAbsoluteCapacityInTransaction(db, { workspaceId: 'ws_atomic', code: 'max_brands', operation: 'brand_create' })
    const calls = vi.mocked(db.query).mock.calls
    expect(calls[0]?.[0]).toContain('pg_advisory_xact_lock')
    expect(calls[0]?.[1]).toEqual(['workspace_subscription_periods_v2', 'ws_atomic'])
    expect(calls[1]?.[0]).toContain('merchant_entitlement_snapshots_v3')
    expect(calls[2]?.[0]).toBe('SELECT count(*)::integer AS used FROM brands WHERE workspace_id=$1')
    await expect(requireCommercialAbsoluteCapacityInTransaction(client({ used: 2 }), { workspaceId: 'ws_atomic', code: 'max_brands', operation: 'brand_create' })).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTA_EXCEEDED', used: 3, included: 2 })
  })
  it('checks both connected accounts and distinct active bindings, without double-counting an existing target', async () => {
    const input = { workspaceId: 'ws_atomic', code: 'max_stores' as const, operation: 'store_bind' as const, platform: 'taobao', accountId: 'store-1' }
    await requireCommercialAbsoluteCapacityInTransaction(client({ accounts: 3, bindings: 3, account_present: true, binding_present: true }), input)
    await expect(requireCommercialAbsoluteCapacityInTransaction(client({ accounts: 1, bindings: 3, account_present: true, binding_present: false }), input)).rejects.toMatchObject({ used: 4, included: 3 })
    await expect(requireCommercialAbsoluteCapacityInTransaction(client({ accounts: 3, bindings: 0, account_present: false, binding_present: false }), { ...input, operation: 'account_connect' })).rejects.toMatchObject({ used: 4, included: 3 })
  })
  it('frozen source blocks actual brand/binding writes before INSERT', async () => {
    const db = client({ used: 0 }, [{ ...active, period_status: 'blocked' }])
    const pool = { connect: async () => db } as SqlPool
    const repo = new PostgresBrandUnitRepository(pool, { commercialEntitlement: true })
    await expect(repo.createBrand({ workspaceId: 'ws_atomic', id: 'brand-1', name: '品牌' })).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    await expect(repo.bindStore({ workspaceId: 'ws_atomic', brandId: 'brand-1', platform: 'taobao', accountId: 'store-1' })).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
  })
  it('platform account snapshot cannot commit an over-quota connection before the normalized projection', async () => {
    const db = client({ accounts: 3, bindings: 0, account_present: false, binding_present: false })
    const repo = new PostgresBusinessRepository({ connect: async () => db } as SqlPool, { normalizedProjection: true, commercialEntitlement: true })
    await expect(repo.save({ workspaceId: 'ws_atomic', entityType: 'platform_account', entityId: 'store-4', entityVersion: 1, payload: { platform: 'taobao', tokenState: 'connected' } })).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTA_EXCEEDED' })
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
    expect(() => new PostgresBusinessRepository({ connect: async () => db } as SqlPool, { commercialEntitlement: true })).toThrow('COMMERCIAL_CAPACITY_NORMALIZED_PROJECTION_REQUIRED')
  })
})
