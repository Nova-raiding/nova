import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { MemoryMappingPreflightApprovalRepository, PostgresMappingPreflightApprovalRepository, type UpsertMappingPreflightApprovalInput } from './mapping-preflight-approval-repository.js'

const start = Date.parse('2030-01-01T00:00:00.000Z')
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()
const digest = (value: string) => value.repeat(64)
const approval = (overrides: Partial<UpsertMappingPreflightApprovalInput> = {}): UpsertMappingPreflightApprovalInput => ({ workspaceId: 'ws_mapping_a', platform: 'taobao', productId: 'product-a', productVersion: 3, mappedPayloadHash: digest('a'), remoteSnapshotHash: digest('b'), schemaVersion: 'schema-v3', schemaEvidenceHash: digest('c'), mappingVersion: 'mapping-v3', mappingEvidenceHash: digest('d'), publishable: true, confirmationValid: true, externallyUnverified: false, findingCodes: [], evaluatedAt: at(0), expiresAt: at(15), createdBy: 'mapping-reviewer', expectedRevision: 0, ...overrides })
const active = (overrides: Partial<UpsertMappingPreflightApprovalInput> & { at?: string } = {}) => {
  const { expectedRevision: _expectedRevision, evaluatedAt: _evaluatedAt, expiresAt: _expiresAt, publishable: _publishable, confirmationValid: _confirmationValid, externallyUnverified: _externallyUnverified, findingCodes: _findingCodes, createdBy: _createdBy, ...input } = approval(overrides)
  return { ...input, ...(overrides.at ? { at: overrides.at } : {}) }
}

describe('MemoryMappingPreflightApprovalRepository', () => {
  it('binds every publish-critical hash and fails closed at expiry', async () => {
    const repository = new MemoryMappingPreflightApprovalRepository(() => new Date(at(0)))
    const saved = await repository.upsert(approval())
    await expect(repository.resolveActive(active({ at: at(14) }))).resolves.toMatchObject({ revision: 1, mappedPayloadHash: digest('a') })
    await expect(repository.resolveActive(active({ mappedPayloadHash: digest('e'), at: at(14) }))).resolves.toBeUndefined()
    await expect(repository.resolveActive(active({ productVersion: 4, at: at(14) }))).resolves.toBeUndefined()
    await expect(repository.resolveActive(active({ at: at(15) }))).resolves.toBeUndefined()
    expect(saved.replayed).toBe(false)
  })

  it('supports CAS upsert, exact replay, and revocation', async () => {
    const repository = new MemoryMappingPreflightApprovalRepository(() => new Date(at(0)))
    const input = approval()
    const first = await repository.upsert(input)
    await expect(repository.upsert(input)).resolves.toEqual({ approval: first.approval, replayed: true })
    await expect(repository.upsert(approval({ expectedRevision: 9, mappedPayloadHash: digest('e') }))).rejects.toMatchObject({ code: 'MAPPING_PREFLIGHT_REVISION_CONFLICT' })
    const updated = await repository.upsert(approval({ expectedRevision: 1, mappedPayloadHash: digest('e') }))
    expect(updated.approval).toMatchObject({ revision: 2, mappedPayloadHash: digest('e') })
    const revoked = await repository.revoke({ workspaceId: 'ws_mapping_a', platform: 'taobao', productId: 'product-a', expectedRevision: 2, revokedAt: at(1) })
    expect(revoked.approval).toMatchObject({ revision: 3, revokedAt: at(1) })
    await expect(repository.resolveActive(active({ mappedPayloadHash: digest('e'), at: at(2) }))).resolves.toBeUndefined()
  })

  it('isolates tenant keys and rejects invalid evidence', async () => {
    const repository = new MemoryMappingPreflightApprovalRepository(() => new Date(at(0)))
    await repository.upsert(approval())
    await expect(repository.get({ workspaceId: 'ws_mapping_b', platform: 'taobao', productId: 'product-a' })).resolves.toBeUndefined()
    for (const input of [approval({ mappedPayloadHash: 'bad' }), approval({ productId: 'product\u200b' }), approval({ expiresAt: at(0) }), approval({ evaluatedAt: at(1) })]) await expect(repository.upsert(input)).rejects.toMatchObject({ code: 'MAPPING_PREFLIGHT_INVALID' })
  })
})

const postgresIt = process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL ? it : it.skip

describe('PostgresMappingPreflightApprovalRepository integration', () => {
  postgresIt('enforces RLS, tenant/product binding, concurrent CAS and exact expiry', async () => {
    const adminUrl = new URL(process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL!)
    const databaseName = `mapping_preflight_${randomUUID().replaceAll('-', '')}`
    const probeRole = `mapping_public_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      await admin.query(`CREATE ROLE "${probeRole}" NOLOGIN`)
      const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_mapping_a','active'),('ws_mapping_b','active')")
      await database.query("INSERT INTO products (id,workspace_id,platform,remote_product_id,title,source) VALUES ('product-a','ws_mapping_a','taobao','remote-a','A','official_api'),('product-b','ws_mapping_b','taobao','remote-b','B','official_api')")

      const appUrl = new URL(databaseUrl); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
      appA = new Pool({ connectionString: appUrl.toString(), max: 2 }); appB = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const repositoryA = new PostgresMappingPreflightApprovalRepository(appA, () => new Date(at(0)))
      const repositoryB = new PostgresMappingPreflightApprovalRepository(appB, () => new Date(at(0)))
      const created = await repositoryA.upsert(approval())
      await expect(repositoryA.resolveActive(active({ at: at(14) }))).resolves.toMatchObject({ revision: 1 })

      const raced = await Promise.allSettled([
        repositoryA.upsert(approval({ expectedRevision: 1, mappedPayloadHash: digest('e') })),
        repositoryB.upsert(approval({ expectedRevision: 1, mappedPayloadHash: digest('f') })),
      ])
      expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(raced.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'MAPPING_PREFLIGHT_REVISION_CONFLICT' } })
      const winner = raced.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repositoryA.upsert>>> => result.status === 'fulfilled')!.value.approval
      expect(winner.revision).toBe(2)
      await expect(repositoryA.resolveActive({ workspaceId: winner.workspaceId, platform: winner.platform, productId: winner.productId, productVersion: winner.productVersion, mappedPayloadHash: winner.mappedPayloadHash, remoteSnapshotHash: winner.remoteSnapshotHash, schemaVersion: winner.schemaVersion, schemaEvidenceHash: winner.schemaEvidenceHash, mappingVersion: winner.mappingVersion, mappingEvidenceHash: winner.mappingEvidenceHash, at: at(15) })).resolves.toBeUndefined()

      await expect(repositoryB.get({ workspaceId: 'ws_mapping_b', platform: 'taobao', productId: 'product-a' })).resolves.toBeUndefined()
      await expect(repositoryB.upsert(approval({ workspaceId: 'ws_mapping_b', expectedRevision: 0 }))).rejects.toMatchObject({ code: 'MAPPING_PREFLIGHT_PRODUCT_SCOPE_MISMATCH' })

      const rls = await appA.connect()
      try {
        await rls.query('BEGIN'); await rls.query("SELECT set_config('app.workspace_id','ws_mapping_b',true)")
        await expect(rls.query("SELECT product_id FROM platform_mapping_preflight_approvals WHERE workspace_id='ws_mapping_a'")).resolves.toMatchObject({ rows: [] })
        await rls.query('ROLLBACK')
      } finally { rls.release() }

      expect(await database.query("SELECT has_table_privilege('merchant_app','platform_mapping_preflight_approvals','DELETE') AS app_delete, has_table_privilege('merchant_app','platform_mapping_preflight_approvals','SELECT') AS app_select")).toMatchObject({ rows: [{ app_delete: false, app_select: true }] })
      const probe = await database.connect()
      try {
        await probe.query('BEGIN'); await probe.query(`SET LOCAL ROLE "${probeRole}"`)
        await expect(probe.query('SELECT product_id FROM platform_mapping_preflight_approvals')).rejects.toThrow(/permission denied/u)
        await probe.query('ROLLBACK')
      } finally { probe.release() }

      const revoked = await repositoryA.revoke({ workspaceId: winner.workspaceId, platform: winner.platform, productId: winner.productId, expectedRevision: 2, revokedAt: at(1) })
      expect(revoked.approval).toMatchObject({ revision: 3, revokedAt: at(1) })
      expect(created.approval.workspaceId).toBe('ws_mapping_a')
    } finally {
      await Promise.all([appA?.end(), appB?.end()]); await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.query(`DROP ROLE IF EXISTS "${probeRole}"`); await admin.end()
    }
  }, 120_000)
})
