import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresImageGenerationExecutionRepository, type FailImageGenerationBeforeProviderInput } from './image-generation-execution-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
import { PostgresModelUsageRepository } from './model-usage-repository.js'
import { handleInternalRuntimeRoute } from '../../../apps/api/src/http-internal-runtime-routes.js'
import type { InternalRuntimeContext } from '../../../apps/api/src/server.js'
const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('image dispatch budget PostgreSQL interleaving acceptance', () => {
  postgresIt('preserves dispatch winners and replays zero-dispatch budget cleanup with durable PostgreSQL state', async () => {
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

      const budgets = new PostgresModelUsageRepository(app)
      const setup = async () => {
        const { owned, failure } = await prepare('provider_reserved')
        const action = `image:idempotency-${owned.jobId}`
        const reservationId = `reservation-${owned.jobId}`
        const operationId = `operation-${owned.jobId}`
        // The production pre-dispatch proof is intentionally bound to a real
        // charged creative-point reservation. Keep the fixture on that same
        // durable path so a missing commercial snapshot cannot accidentally
        // make budget cleanup look successful.
        await database!.query(`INSERT INTO creative_point_operations
          (id,workspace_id,kind,idempotency_key,status,request,result,completed_at)
          VALUES ($1,$2,'reserve',$3,'completed',$4::jsonb,$5::jsonb,now())`, [
          operationId, workspaceId, `commercial.reserve:${action}`, JSON.stringify({ action_key: action, points: 1, rate_card_version: 'test' }), JSON.stringify({ entity_id: reservationId }),
        ])
        await database!.query(`INSERT INTO creative_point_reservations
          (id,workspace_id,operation_id,action_key,points,status,rate_card_version)
          VALUES ($1,$2,$3,$4,1,'active','test')`, [reservationId, workspaceId, operationId, action])
        const budgetInput = { workspaceId, reservationKey: action, runKey: action, modality: 'image' as const,
          model: 'isolated-no-provider', estimateCny: 0.2, estimateVersion: 'test', dailyLimitCny: 100, runLimitCny: 2 }
        const event = { id: failure.eventId, workspaceId, aggregateId: owned.jobId, eventType: 'image.generation.requested', payload: {
          job_id: owned.jobId, workspace_id: workspaceId, product_id: productId, intent_hash: 'a'.repeat(64), action_id: action, run_key: action, commercial_access_snapshot: {
            access_mode: 'POINT_CHARGED', workspace_id: workspaceId, operation: 'image_generation.execute', reservation_id: reservationId, quoted_points: 1, rate_version: 'test',
          }, authorization_snapshot: {
            schema_version: 1, decision_id: 'decision', actor_id: 'actor', identity_id: 'identity', workspace_id: workspaceId,
            workbench: 'workspace', context_id: `workspace:${workspaceId}`, context_version: '1', policy_version: '1', grant_revision: '1', grant_ids: ['grant'], scope_hash: 'a'.repeat(64), capability: 'image_generation.execute', resource_id: owned.jobId, resource_revision: '1', request_id: 'request', trace_id: 'trace', authorized: true, decided_at: new Date().toISOString(),
          },
        } }
        await database!.query(`INSERT INTO outbox_events
          (id,workspace_id,aggregate_id,event_type,sequence,payload)
          VALUES ($1,$2,$3,'image.generation.requested',1,$4::jsonb)`, [failure.eventId, workspaceId, owned.jobId, JSON.stringify(event.payload)])
        const reserve = vi.fn(() => budgets.reserveDailyBudget(budgetInput))
        const release = vi.fn(() => budgets.releaseDailyBudget({ workspaceId, reservationKey: action }))
        const context = {
          req: { method: 'POST' }, res: {}, path: `/v1/internal/image-generation-jobs/${owned.jobId}/execution`,
          requireWorkerAuthorization: vi.fn(), headerRequired: () => workspaceId, enrichRequestObservation: vi.fn(),
          body: async () => ({ operation: 'begin_provider_dispatch', owner_token: owned.ownerToken }),
          persistence: { imageGenerationExecutions: repo, outbox: { listAggregateEvents: async () => [event] } },
          service: { getImageGenerationJob: () => ({ idempotencyKey: `idempotency-${owned.jobId}` }) },
          reserveDailyModelBudget: reserve, releaseDailyModelBudget: release, recheckWorkerAuthorizationSnapshot: vi.fn(), send: vi.fn(),
        } as unknown as InternalRuntimeContext
        const status = async () => (await database!.query('SELECT status FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, action])).rows[0]?.status
        const close = () => { context.body = async () => ({ operation: 'fail_before_provider', event_id: failure.eventId, owner_token: owned.ownerToken, error_code: 'MODEL_DAILY_COST_BUDGET_EXCEEDED', error_message: 'isolated rejection' }) }
        return { owned, failure, reserve, release, context, status, close, action, budgetInput }
      }
      // A second real repository connection closes while the first route is
      // between its read fence and committing its budget reservation.
      const closed = await setup()
      closed.reserve.mockImplementationOnce(async () => {
        await new PostgresImageGenerationExecutionRepository(app!).failBeforeProvider(closed.failure)
        return budgets.reserveDailyBudget(closed.budgetInput)
      })
      await expect(handleInternalRuntimeRoute(closed.context)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
      expect(await closed.status()).toBe('released')
      expect((await repo.get(closed.owned))?.state).toBe('failed')
      // A competing connection wins provider dispatch after our read fence.
      const winner = await setup()
      winner.reserve.mockImplementationOnce(async () => {
        const budget = await budgets.reserveDailyBudget(winner.budgetInput)
        await new PostgresImageGenerationExecutionRepository(app!).beginProviderDispatch(winner.owned)
        return budget
      })
      await expect(handleInternalRuntimeRoute(winner.context)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
      expect(await winner.status()).toBe('active')
      expect(winner.release).not.toHaveBeenCalled()
      expect((await repo.get(winner.owned))?.state).toBe('provider_dispatching')
      // Inject an actual SQL error at the release port after the durable
      // execution CAS commits. A new repository instance must recover it.
      const recovery = await setup()
      await budgets.reserveDailyBudget(recovery.budgetInput)
      recovery.close()
      recovery.release.mockImplementationOnce(async () => { await app!.query('SELECT 1/0'); return undefined })
      await expect(handleInternalRuntimeRoute(recovery.context)).rejects.toMatchObject({ code: 'MODEL_USAGE_BUDGET_CLEANUP_PENDING', reconciliationRequired: true })
      expect((await repo.get(recovery.owned))?.state).toBe('failed')
      expect(await recovery.status()).toBe('active')
      recovery.context.persistence.imageGenerationExecutions = new PostgresImageGenerationExecutionRepository(app)
      await handleInternalRuntimeRoute(recovery.context)
      expect(await recovery.status()).toBe('released')
      const beforeReplay = (await database.query('SELECT revision FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, recovery.action])).rows
      await handleInternalRuntimeRoute(recovery.context)
      expect((await database.query('SELECT revision FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [workspaceId, recovery.action])).rows).toEqual(beforeReplay)
      expect(await new PostgresImageGenerationExecutionRepository(app).get({ workspaceId: otherWorkspaceId, jobId: recovery.owned.jobId })).toBeUndefined()
    } finally {
      await app?.end(); await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
