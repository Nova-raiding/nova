import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresActionLedgerRepository } from './action-ledger-repository.js'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresChargedTextDispatchRepository } from './charged-text-dispatch-repository.js'
import { PostgresChargedTextNoDeliveryRepository } from './charged-text-no-delivery-repository.js'
import { PostgresCreativeActionClaimRepository } from './creative-point-action-claim-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresModelUsageRepository } from './model-usage-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { withWorkspaceTransaction } from './repository.js'

const postgresIt = process.env.PERSISTENCE_RELEASE_DATABASE_URL ? it : it.skip
const urlFor = (base: URL, name: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${name}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('253 charged text no-delivery finance resolution', () => {
  postgresIt('refunds a verified settled malformed response once and closes its job; never releases unknown active holds', async () => {
    const base = new URL(process.env.PERSISTENCE_RELEASE_DATABASE_URL!)
    const name = `release_fresh_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let db: Pool | undefined; let app: Pool | undefined; let failure: unknown
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      db = new Pool({ connectionString: urlFor(base, name), max: 4 })
      const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await db.query(roleSql)
      expect((await new MigrationRunner(db, await loadMigrations()).run()).at(-1)).toBe(254)
      await db.query(roleSql)
      const role = await db.query<{ canReadToken: boolean; canReadEvidence: boolean; canResolve: boolean; opsResolve: boolean }>(`
        SELECT has_column_privilege('merchant_app','charged_text_dispatch_attempts','owner_token','SELECT') AS "canReadToken",
          has_column_privilege('merchant_app','charged_text_dispatch_attempts','provider_request_id','SELECT') AS "canReadEvidence",
          has_function_privilege('merchant_app','insert_charged_text_no_delivery_resolution(text,text,text,text,text,text,text,text,text,integer)','EXECUTE') AS "canResolve",
          has_function_privilege('merchant_ops','insert_charged_text_no_delivery_resolution(text,text,text,text,text,text,text,text,text,integer)','EXECUTE') AS "opsResolve"`)
      expect(role.rows[0]).toEqual({ canReadToken: false, canReadEvidence: true, canResolve: true, opsResolve: false })
      app = new Pool({ connectionString: urlFor(base, name, 'merchant_app', 'merchant_app_local_only'), max: 8 })
      const ws = 'ws_no_delivery_253'; const actionKey = 'model:generation:client-253'; const providerId = 'relay-253'
      const contextHash = 'e'.repeat(64)
      await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),('ws_other_253','active')", [ws])
      await db.query("INSERT INTO products(id,workspace_id,platform,remote_product_id,title,stock,sku_count,source) VALUES('product-253',$1,'douyin','product-253','Fixture',1,1,'fixture')", [ws])
      await db.query("INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES('task-253',$1,'product-253','douyin','plan_confirmed')", [ws])
      const business = new PostgresBusinessRepository(app, { normalizedProjection: true })
      const job = { id: 'job-253', workspaceId: ws, taskId: 'task-253', idempotencyKey: 'client-253', state: 'queued', attempt: 0, revision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      await business.save({ workspaceId: ws, entityType: 'generation_job', entityId: job.id, entityVersion: 1, payload: job })
      const points = new PostgresCreativePointRepository(app)
      await points.grant({ workspaceId: ws, idempotencyKey: 'grant-253', sourceType: 'test_fixture', sourceId: 'grant-253', points: 10 })
      const reserved = await points.reserve({ workspaceId: ws, actionKey, idempotencyKey: `commercial.reserve:${actionKey}`, points: 3, rateCardVersion: 'rate-253' })
      const actions = new PostgresCreativeActionClaimRepository(app)
      const owner = await actions.claim({ workspaceId: ws, actionKey, intentSha256: contextHash, leaseMs: 60_000 })
      const payload = { job_id: job.id, task_id: job.taskId, action_id: actionKey, context_hash: contextHash,
        input: { platform: 'douyin', product: { id: 'product-253' }, knowledgeContext: { documents: [] } },
        commercial_access_snapshot: { access_mode: 'POINT_CHARGED', reservation_id: reserved.value.id, quoted_points: 3 },
        authorization_snapshot: { resource_id: job.id, authorized: true } }
      await withWorkspaceTransaction(app, ws, async client => {
        await client.query("INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES('event-253',$1,'job-253','generation.requested',1,$2::jsonb)", [ws, JSON.stringify(payload)])
        await actions.bindInTransaction(client, { ...owner, reservationId: reserved.value.id, jobId: job.id, eventId: 'event-253' })
      })
      await business.save({ workspaceId: ws, entityType: 'generation_job', entityId: job.id, entityVersion: 2, payload: { ...job, state: 'running', revision: 2 } })
      const dispatch = new PostgresChargedTextDispatchRepository(app)
      const physical = await dispatch.claim({ workspaceId: ws, actionKey, eventId: 'event-253', logicalAttempt: 1, transportAttempt: 1,
        providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64) })
      await dispatch.transition({ workspaceId: ws, id: physical.id, ownerToken: physical.ownerToken, to: 'provider_started' })
      await dispatch.transition({ workspaceId: ws, id: physical.id, ownerToken: physical.ownerToken, to: 'response_recorded', providerRequestId: providerId })
      await dispatch.transition({ workspaceId: ws, id: physical.id, ownerToken: physical.ownerToken, to: 'completed' })
      await db.query("UPDATE outbox_events SET unknown_at=now(),last_error=$1::jsonb WHERE id='event-253'", [JSON.stringify({ code: 'CHARGED_TEXT_SCHEMA_REPAIR_DISABLED' })])
      const resolver = new PostgresChargedTextNoDeliveryRepository(app)
      await expect(resolver.resolve({ workspaceId: ws, actionKey, actorId: 'finance-253', reason: 'malformed response', evidenceRef: 'case-253', expectedJobRevision: 2 }))
        .rejects.toMatchObject({ code: 'CHARGED_TEXT_NO_DELIVERY_EVIDENCE_MISMATCH' })
      expect((await db.query('SELECT status FROM creative_point_reservations WHERE id=$1', [reserved.value.id])).rows[0]?.status).toBe('active')
      const actionLedger = new PostgresActionLedgerRepository(app)
      await actionLedger.record({ workspaceId: ws, actionKey, actionKind: 'model_text', settlement: 'wallet', units: 1,
        amountFen: 10, actorId: 'fixture', description: 'fixture', settlementStatus: 'authorized' })
      await actionLedger.settleProviderUsage({ workspaceId: ws, actionKey, providerRequestId: providerId, actualAmountFen: 10 })
      const modelUsage = new PostgresModelUsageRepository(app)
      await modelUsage.record({ workspaceId: ws, actionId: actionKey, modality: 'text', model: 'fixture-model', providerRequestId: providerId,
        inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny: 0.1, customerChargeCny: 0.1, markupMultiplier: 1,
        pricingPolicyRevision: 1, settlementStatus: 'settled' })
      const lifecycle = new PostgresCreativePointLifecycleRepository(app)
      const observedAt = new Date().toISOString()
      const usage = { modality: 'text', model: 'fixture-model', input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      const cost = { currency: 'CNY', actual: 0.1 }
      const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId: providerId, usage, cost, observedAt })).digest('hex')
      await lifecycle.recordProviderReceipt({ workspaceId: ws, operationId: reserved.value.operationId, provider: 'model-relay', providerRequestId: providerId,
        outcome: 'succeeded', usage, cost, receiptHash, verifiedAt: observedAt, at: observedAt })
      await lifecycle.recordProviderReceipt({ workspaceId: ws, operationId: reserved.value.operationId, provider: 'fixture-relay', providerRequestId: providerId,
        outcome: 'succeeded', usage, cost, receiptHash: 'c'.repeat(64), verifiedAt: observedAt, at: observedAt })
      await points.settle({ workspaceId: ws, reservationId: reserved.value.id, idempotencyKey: `commercial.settle:${actionKey}`, actualPoints: 2,
        metadata: { provider_request_id: providerId, receipt_hash: receiptHash, cost_cny: 0.1, modality: 'text' } })
      await expect(withWorkspaceTransaction(app, ws, client => client.query(`SELECT * FROM insert_charged_text_no_delivery_resolution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ws, actionKey, reserved.value.id, job.id, 'event-253', providerId, 'finance-253', 'malformed response', 'case-253', 2])))
        .rejects.toMatchObject({ code: '23514' })
      await expect(withWorkspaceTransaction(app, ws, client => client.query(`SELECT * FROM insert_charged_text_no_delivery_resolution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        ['ws_other_253', actionKey, reserved.value.id, job.id, 'event-253', providerId, 'finance-253', 'malformed response', 'case-253', 2])))
        .rejects.toMatchObject({ code: '42501' })
      await expect(withWorkspaceTransaction(app, ws, client => client.query(`SELECT * FROM insert_charged_text_no_delivery_resolution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ws, actionKey, reserved.value.id, job.id, 'event-253', 'forged-provider-id', 'finance-253', 'malformed response', 'case-253', 2])))
        .rejects.toMatchObject({ code: '23514' })
      const claim = { workspaceId: ws, actionKey, actorId: 'finance-253', reason: 'malformed response', evidenceRef: 'case-253', expectedJobRevision: 2 }
      const raced = await Promise.all([resolver.resolve(claim), resolver.resolve({ ...claim, actorId: 'finance-other' })])
      expect(raced[0]!.reservationId).toBe(reserved.value.id)
      expect(raced[1]!.reservationId).toBe(reserved.value.id)
      expect(raced[0]!.refundedPoints).toBe(2)
      const state = await db.query("SELECT (SELECT count(*) FROM creative_point_reversals_v2 WHERE original_reservation_id=$1) AS reversals,(SELECT points FROM creative_point_reversals_v2 WHERE original_reservation_id=$1) AS refunded_points,(SELECT count(*) FROM workspace_operation_audit WHERE action='ops.marketing.generation.no_delivery.refund' AND resource_id='job-253') AS audits,(SELECT state FROM generation_jobs WHERE id='job-253') AS job_state,(SELECT payload->>'state' FROM business_entity_snapshots WHERE entity_type='generation_job' AND entity_id='job-253') AS snapshot_state,(SELECT entity_version FROM business_entity_snapshots WHERE entity_type='generation_job' AND entity_id='job-253') AS snapshot_version", [reserved.value.id])
      expect(state.rows[0]).toMatchObject({ reversals: '1', refunded_points: '2', audits: '1', job_state: 'failed', snapshot_state: 'failed', snapshot_version: 3 })
      const imageAction = 'model:generation:image-253'; const imageProvider = 'relay-image-253'
      const imageReservation = await points.reserve({ workspaceId: ws, actionKey: imageAction, idempotencyKey: `commercial.reserve:${imageAction}`, points: 2, rateCardVersion: 'rate-253' })
      await actionLedger.record({ workspaceId: ws, actionKey: imageAction, actionKind: 'model_text', settlement: 'wallet', units: 1,
        amountFen: 10, actorId: 'fixture', description: 'fixture', settlementStatus: 'authorized' })
      await actionLedger.settleProviderUsage({ workspaceId: ws, actionKey: imageAction, providerRequestId: imageProvider, actualAmountFen: 10 })
      await modelUsage.record({ workspaceId: ws, actionId: imageAction, modality: 'image', model: 'fixture-model', providerRequestId: imageProvider,
        inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny: 0.1, customerChargeCny: 0.1, markupMultiplier: 1,
        pricingPolicyRevision: 1, settlementStatus: 'settled' })
      const imageUsage = { ...usage, modality: 'image' }
      const imageHash = createHash('sha256').update(JSON.stringify({ providerRequestId: imageProvider, usage: imageUsage, cost, observedAt })).digest('hex')
      await lifecycle.recordProviderReceipt({ workspaceId: ws, operationId: imageReservation.value.operationId, provider: 'model-relay', providerRequestId: imageProvider,
        outcome: 'succeeded', usage: imageUsage, cost, receiptHash: imageHash, verifiedAt: observedAt, at: observedAt })
      await lifecycle.recordProviderReceipt({ workspaceId: ws, operationId: imageReservation.value.operationId, provider: 'fixture-relay', providerRequestId: imageProvider,
        outcome: 'succeeded', usage: imageUsage, cost, receiptHash: 'd'.repeat(64), verifiedAt: observedAt, at: observedAt })
      await points.settle({ workspaceId: ws, reservationId: imageReservation.value.id, idempotencyKey: `commercial.settle:${imageAction}`, actualPoints: 2,
        metadata: { provider_request_id: imageProvider, receipt_hash: imageHash, cost_cny: 0.1, modality: 'image' } })
      const imageEvidence = { workspaceId: ws, reservationId: imageReservation.value.id, actionId: imageAction,
        providerRequestId: imageProvider, relayProvider: 'fixture-relay', allowPartialPoints: true }
      expect(await lifecycle.verifyModelUsageDeliverySettlement({ ...imageEvidence, requireText: false })).toBe(true)
      expect(await lifecycle.verifyModelUsageDeliverySettlement({ ...imageEvidence, requireText: true })).toBe(false)
      expect((await db.query('SELECT count(*) AS count FROM creative_point_reversals_v2 WHERE original_reservation_id=$1', [imageReservation.value.id])).rows[0]?.count).toBe('0')
      await expect(db.query("UPDATE generation_jobs SET state='queued' WHERE id='job-253'")).rejects.toMatchObject({ code: '23514' })
      await expect(resolver.resolve({ ...claim, workspaceId: 'ws_other_253' })).rejects.toMatchObject({ code: 'CHARGED_TEXT_POINT_ACCESS_MISSING' })
    } catch (error) { failure = error; throw error }
    finally {
      await withPostgresFixtureCleanup(async () => { await app?.end(); await db?.end(); await dropDrainedPostgresFixture(admin, name) }, failure, [() => admin.end()])
    }
  }, 240_000)
})
