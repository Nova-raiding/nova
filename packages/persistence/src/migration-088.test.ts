import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { ImageContinuationLeaseError, MemoryImageContinuationLeaseRepository, PostgresImageContinuationLeaseRepository } from './image-generation-continuation-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const t = (milliseconds: number) => new Date(Date.UTC(2026, 7, 30) + milliseconds).toISOString()
const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration 088 image generation continuation leases', () => {
  it('registers a tenant-scoped provider-boundary state machine', async () => {
    const sql = await readFile(new URL('./migrations/088_image_generation_continuation_leases.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 88)).toMatchObject({ version: 88, name: 'image_generation_continuation_leases' })
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: 122 }, (_, index) => index + 1))
    expect(sql).toContain("state IN ('available','leased','provider_started','outcome_unknown','completed','failed')")
    expect(sql).toContain('image_generation_continuation_reclaim_idx')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('REVOKE DELETE,TRUNCATE')
  })

  it('allows takeover only before provider dispatch and fences the stale owner', async () => {
    const repository = new MemoryImageContinuationLeaseRepository()
    const first = await repository.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(0) })
    await expect(repository.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(99) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_EXECUTION_BUSY' })
    const takeover = await repository.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(100) })
    expect(takeover).toMatchObject({ attempt: 2, state: 'leased' })
    expect(takeover.ownerToken).not.toBe(first.ownerToken)
    await expect(repository.markProviderStarted({ workspaceId: 'ws_088', jobId: 'job_088', ownerToken: first.ownerToken, now: t(101) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_EXECUTION_LEASE_LOST' })
    await repository.markProviderStarted({ workspaceId: 'ws_088', jobId: 'job_088', ownerToken: takeover.ownerToken, now: t(102) })
    await expect(repository.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(10_000) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN' })
    await repository.markOutcomeUnknown({ workspaceId: 'ws_088', jobId: 'job_088', ownerToken: takeover.ownerToken, errorCode: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', errorMessage: 'response lost', now: t(103) })
    await expect(repository.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(20_000) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN' })
  })

  postgresIt('enforces one owner across replicas, expires pre-provider leases, and never retries unknown provider outcomes', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_088_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let replicaA: Pool | undefined
    let replicaB: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base); isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_088','active')`)
      await database.query(`INSERT INTO products (id,workspace_id,platform,store_name,remote_product_id,title,source) VALUES ('product_088','ws_088','jd','store','remote_088','lease test','fixture')`)
      const insertJob = (id: string, key: string) => database!.query(`INSERT INTO image_generation_jobs (id,workspace_id,product_id,idempotency_key,intent_hash,source_product_version,direction,requested_count,state,artifact_role,archive_state) VALUES ($1,'ws_088','product_088',$2,$3,1,'white background',1,'queued','candidate','pending')`, [id, key, 'a'.repeat(64)])
      await insertJob('job_088', 'key_088')
      await insertJob('job_088_complete', 'key_088_complete')
      replicaA = new Pool({ connectionString: isolated.toString(), max: 2 })
      replicaB = new Pool({ connectionString: isolated.toString(), max: 2 })
      const a = new PostgresImageContinuationLeaseRepository(replicaA)
      const b = new PostgresImageContinuationLeaseRepository(replicaB)

      const claims = await Promise.allSettled([
        a.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(0) }),
        b.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(0) }),
      ])
      const winner = claims.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof a.claim>>> => item.status === 'fulfilled')
      expect(claims.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(claims.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'IMAGE_CONTINUATION_EXECUTION_BUSY' } })

      const takeover = await b.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(100) })
      expect(takeover.attempt).toBe(2)
      await expect(a.markProviderStarted({ workspaceId: 'ws_088', jobId: 'job_088', ownerToken: winner!.value.ownerToken, now: t(101) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_EXECUTION_LEASE_LOST' })
      await b.markProviderStarted({ workspaceId: 'ws_088', jobId: 'job_088', ownerToken: takeover.ownerToken, now: t(102) })
      await expect(a.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(50_000) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_PROVIDER_OUTCOME_UNKNOWN' })
      const unknown = await b.markOutcomeUnknown({ workspaceId: 'ws_088', jobId: 'job_088', ownerToken: takeover.ownerToken, errorCode: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', errorMessage: 'provider response lost', now: t(103) })
      expect(unknown).toMatchObject({ state: 'outcome_unknown', attempt: 2, errorCode: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
      await expect(a.claim({ workspaceId: 'ws_088', jobId: 'job_088', leaseMs: 100, now: t(100_000) })).rejects.toBeInstanceOf(ImageContinuationLeaseError)

      const completeLease = await a.claim({ workspaceId: 'ws_088', jobId: 'job_088_complete', leaseMs: 100, now: t(0) })
      await a.markProviderStarted({ workspaceId: 'ws_088', jobId: 'job_088_complete', ownerToken: completeLease.ownerToken, now: t(1) })
      await a.markCompleted({ workspaceId: 'ws_088', jobId: 'job_088_complete', ownerToken: completeLease.ownerToken, now: t(2) })
      await expect(b.claim({ workspaceId: 'ws_088', jobId: 'job_088_complete', leaseMs: 100, now: t(10_000) })).rejects.toMatchObject({ code: 'IMAGE_CONTINUATION_EXECUTION_COMPLETED' })
      expect((await database.query(`SELECT state,attempt,owner_token,lease_expires_at,error_code FROM image_generation_continuation_leases WHERE workspace_id='ws_088' ORDER BY job_id`)).rows).toEqual([
        { state: 'outcome_unknown', attempt: 2, owner_token: null, lease_expires_at: null, error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' },
        { state: 'completed', attempt: 1, owner_token: null, lease_expires_at: null, error_code: null },
      ])
    } finally {
      await Promise.all([replicaA?.end(), replicaB?.end()])
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
