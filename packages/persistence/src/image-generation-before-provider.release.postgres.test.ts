import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresImageGenerationExecutionRepository, type FailImageGenerationBeforeProviderInput } from './image-generation-execution-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const lost = { code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' }
const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('image generation known-before-provider cancellation PostgreSQL acceptance', () => {
  postgresIt('enforces exact ownership, one-shot cancellation and concurrent provider-start fencing as merchant_app', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_image_before_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined; let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(value => value.version))
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 4 })
      // Match the real isolated-runtime bootstrap after all migrations. Verify
      // this cluster already accepts the same local-only credential; do not
      // replace the bootstrap with ad-hoc grants or custom role/password changes.
      expect((await app.query('SELECT current_user AS role')).rows).toEqual([{ role: 'merchant_app' }])
      const roleProjection = `SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolcanlogin
        FROM pg_roles WHERE rolname IN ('merchant_app','merchant_ops','merchant_alert_receiver') ORDER BY rolname`
      const rolesBefore = (await database.query(roleProjection)).rows
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      expect((await database.query(roleProjection)).rows).toEqual(rolesBefore)
      const workspaceId = `image-before-${randomUUID()}`
      const otherWorkspaceId = `image-other-${randomUUID()}`
      await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),($2,'active')", [workspaceId, otherWorkspaceId])
      expect((await app.query('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
        .toEqual([{ role: 'merchant_app', rolsuper: false, rolbypassrls: false }])
      const repo = new PostgresImageGenerationExecutionRepository(app)
      const business = new PostgresBusinessRepository(app, { normalizedProjection: true })
      // Synthetic product/job fixtures are written through the real tenant
      // repository solely to satisfy durable FKs. No model is called, no asset
      // or scan receipt is manufactured, and no generation success is asserted.
      const productId = `product-${randomUUID()}`
      await business.save({ workspaceId, entityType: 'product', entityId: productId, entityVersion: 1,
        payload: { id: productId, workspaceId, title: 'Isolated CAS fixture', platform: 'jd',
          source: 'fixture', remoteId: `fixture-${productId}`, storeName: 'Isolated execution tests', version: 1, skuCount: 1, stock: 0 } })
      const prepare = async (state: 'leased' | 'provider_reserved' | 'provider_dispatching' = 'provider_dispatching') => {
        const jobId = `image-${randomUUID()}`; const eventId = `event-${randomUUID()}`
        await business.save({ workspaceId, entityType: 'image_generation_job', entityId: jobId, entityVersion: 1,
          payload: { id: jobId, workspaceId, productId, idempotencyKey: `idempotency-${jobId}`,
            intentHash: 'a'.repeat(64), sourceProductVersion: 1, direction: 'Isolated CAS fixture',
            count: 1, state: 'queued', archiveState: 'pending' } })
        const leased = await repo.claim({ workspaceId, jobId, eventId, leaseMs: 60_000 })
        const owned = { workspaceId, jobId, ownerToken: leased.ownerToken }
        if (state !== 'leased') await repo.reserveProviderOperation(owned)
        if (state === 'provider_dispatching') await repo.beginProviderDispatch(owned)
        const failure: FailImageGenerationBeforeProviderInput = { ...owned, eventId,
          errorCode: 'CUSTOMER_DELIVERY_INCOMPLETE', errorMessage: 'Final authorization denied before any provider call' }
        return { owned, failure }
      }

      // The workspace filter is enforced by RLS, independently from API auth.
      expect((await app.query('SELECT job_id FROM image_generation_executions')).rows).toEqual([])
      const exact = await prepare()
      const original = await repo.get(exact.owned)
      expect(await repo.get({ workspaceId: otherWorkspaceId, jobId: exact.owned.jobId })).toBeUndefined()
      for (const mismatch of [
        { workspaceId: otherWorkspaceId }, { jobId: `wrong-${randomUUID()}` },
        { eventId: `wrong-${randomUUID()}` }, { ownerToken: `wrong-${randomUUID()}` },
      ]) {
        await expect(repo.failBeforeProvider({ ...exact.failure, ...mismatch })).rejects.toMatchObject(lost)
        expect(await repo.get(exact.owned)).toEqual(original)
      }
      const failed = await repo.failBeforeProvider(exact.failure)
      expect(failed).toMatchObject({ workspaceId, jobId: exact.owned.jobId, eventId: exact.failure.eventId,
        state: 'failed', attempt: 1, providerOperationKey: original!.providerOperationKey,
        errorCode: exact.failure.errorCode, errorMessage: exact.failure.errorMessage })
      expect(failed.ownerToken).toBeUndefined(); expect(failed.leaseExpiresAt).toBeUndefined()
      expect(failed.providerRequestId).toBeUndefined(); expect(failed.providerStartedAt).toBeUndefined()
      await expect(repo.failBeforeProvider(exact.failure)).rejects.toMatchObject(lost)
      await expect(repo.claim({ workspaceId, jobId: exact.owned.jobId, eventId: exact.failure.eventId, leaseMs: 60_000 }))
        .rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_FAILED', execution: { state: 'failed', providerOperationKey: original!.providerOperationKey } })
      expect(await repo.get(exact.owned)).toEqual(failed)

      const reserved = await prepare('provider_reserved')
      expect(await repo.failBeforeProvider(reserved.failure)).toMatchObject({ state: 'failed' })
      const leased = await prepare('leased')
      await expect(repo.failBeforeProvider(leased.failure)).rejects.toMatchObject(lost)
      expect(await repo.get(leased.owned)).toMatchObject({ state: 'leased', ownerToken: leased.owned.ownerToken })

      const duplicate = await prepare()
      const duplicateBefore = (await repo.get(duplicate.owned))!
      const attempts = await Promise.allSettled([repo.failBeforeProvider(duplicate.failure),
        repo.failBeforeProvider({ ...duplicate.failure, errorCode: 'ACCOUNT_SUSPENDED', errorMessage: 'Second exact-owner cancellation' })])
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining(lost) })])
      const duplicateWinner = attempts.find(result => result.status === 'fulfilled')!
      if (duplicateWinner.status !== 'fulfilled') throw new Error('missing cancellation winner')
      expect(await repo.get(duplicate.owned)).toEqual(duplicateWinner.value)
      expect(duplicateWinner.value).toMatchObject({ state: 'failed', eventId: duplicate.failure.eventId,
        attempt: duplicateBefore.attempt, providerOperationKey: duplicateBefore.providerOperationKey })
      expect(duplicateWinner.value.ownerToken).toBeUndefined(); expect(duplicateWinner.value.leaseExpiresAt).toBeUndefined()
      await expect(repo.failBeforeProvider({ ...duplicate.failure, errorCode: 'LATE_OVERWRITE' })).rejects.toMatchObject(lost)
      expect(await repo.get(duplicate.owned)).toEqual(duplicateWinner.value)

      const started = await prepare()
      const requestId = `request-${randomUUID()}`
      const startedSnapshot = await repo.markProviderStarted({ ...started.owned, providerRequestId: requestId })
      await expect(repo.failBeforeProvider(started.failure)).rejects.toMatchObject(lost)
      expect(await repo.get(started.owned)).toEqual(startedSnapshot)
      const unknownSnapshot = await repo.markOutcomeUnknown({ ...started.owned, errorCode: 'TIMEOUT_AFTER_PROVIDER', errorMessage: 'Synthetic post-start unknown state' })
      await expect(repo.failBeforeProvider(started.failure)).rejects.toMatchObject(lost)
      expect(await repo.get(started.owned)).toEqual(unknownSnapshot)
      expect(unknownSnapshot.providerRequestId).toBe(requestId)
      expect(unknownSnapshot.providerStartedAt).toBe(startedSnapshot.providerStartedAt)
      await expect(repo.claim({ workspaceId, jobId: started.owned.jobId, eventId: started.failure.eventId, leaseMs: 60_000 }))
        .rejects.toMatchObject({ code: 'IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN' })

      const unknownRace = await prepare()
      const unknownResults = await Promise.allSettled([
        repo.markOutcomeUnknown({ ...unknownRace.owned, errorCode: 'DISPATCH_OUTCOME_UNKNOWN', errorMessage: 'Synthetic unknown-state CAS competitor' }),
        repo.failBeforeProvider(unknownRace.failure),
      ])
      expect(unknownResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(unknownResults.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining(lost) })])
      const unknownWinner = unknownResults.find(result => result.status === 'fulfilled')!
      if (unknownWinner.status !== 'fulfilled') throw new Error('missing unknown-state race winner')
      expect(await repo.get(unknownRace.owned)).toEqual(unknownWinner.value)
      await expect(repo.failBeforeProvider(unknownRace.failure)).rejects.toMatchObject(lost)

      // These compete on different physical pool connections and the same row.
      // Either valid winner is accepted; the loser must never erase a winner's
      // request ID or turn a known pre-provider failure into outcome_unknown.
      for (let round = 0; round < 6; round++) {
        const racing = await prepare(); const racingRequestId = `request-${randomUUID()}`
        const cancel = () => repo.failBeforeProvider(racing.failure)
        const start = () => repo.markProviderStarted({ ...racing.owned, providerRequestId: racingRequestId })
        const results = await Promise.allSettled(round % 2 ? [cancel(), start()] : [start(), cancel()])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining(lost) })])
        const saved = (await repo.get(racing.owned))!
        const winner = results.find(result => result.status === 'fulfilled')!
        if (winner.status !== 'fulfilled') throw new Error('missing concurrent winner')
        expect(saved).toEqual(winner.value)
        if (saved.state === 'provider_started') {
          expect(saved.providerRequestId).toBe(racingRequestId); expect(saved.providerStartedAt).toEqual(expect.any(String))
          await expect(repo.failBeforeProvider(racing.failure)).rejects.toMatchObject(lost)
          expect(await repo.get(racing.owned)).toEqual(saved)
        } else {
          expect(saved.state).toBe('failed'); expect(saved.providerRequestId).toBeUndefined(); expect(saved.providerStartedAt).toBeUndefined()
          await expect(repo.claim({ workspaceId, jobId: racing.owned.jobId, eventId: racing.failure.eventId, leaseMs: 60_000 }))
            .rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_FAILED' })
        }
      }
      const scopes = (await app.query("SELECT current_setting('app.workspace_id',true) AS workspace")).rows[0]
      expect([null, '']).toContain(scopes.workspace)
    } finally {
      await app?.end(); await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
