import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresChargedTextDispatchRepository } from './charged-text-dispatch-repository.js'
import { PostgresChargedTextNoDeliveryRepository } from './charged-text-no-delivery-repository.js'
import { PostgresCreativeActionClaimRepository } from './creative-point-action-claim-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { withWorkspaceTransaction } from './repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const urlFor = (base: URL, name: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${name}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 253 charged text no-delivery resolution', () => {
  postgresIt('keeps the resolution table private and commits evidence, refund, failed job and audit atomically', async () => {
    const base = new URL(databaseUrl!)
    const name = `release_fresh_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let db: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    let rejectAudit = false
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      db = new Pool({ connectionString: urlFor(base, name), max: 6 })
      const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await db.query(roleSql)
      expect((await new MigrationRunner(db, await loadMigrations()).run()).at(-1)).toBe(254)
      await db.query(roleSql)
      const acl = await db.query<{ tableSelect: boolean; read: boolean; insert: boolean; opsRead: boolean; ownerToken: boolean }>(`
        SELECT has_table_privilege('merchant_app','public.charged_text_no_delivery_resolutions','SELECT') AS "tableSelect",
          has_function_privilege('merchant_app','public.get_charged_text_no_delivery_resolution(text,text)','EXECUTE') AS read,
          has_function_privilege('merchant_app','public.insert_charged_text_no_delivery_resolution(text,text,text,text,text,text,text,text,text,integer)','EXECUTE') AS insert,
          has_function_privilege('merchant_ops','public.get_charged_text_no_delivery_resolution(text,text)','EXECUTE') AS "opsRead",
          has_column_privilege('merchant_app','public.charged_text_dispatch_attempts','owner_token','SELECT') AS "ownerToken"
      `)
      expect(acl.rows[0]).toEqual({ tableSelect: false, read: true, insert: true, opsRead: false, ownerToken: false })
      app = new Pool({ connectionString: urlFor(base, name, 'merchant_app', 'merchant_app_local_only'), max: 6 })
      const workspaceId = `ws_nodelivery_${randomUUID().replaceAll('-', '')}`
      const actionKey = 'model:generation:no-delivery'
      const contextHash = 'a'.repeat(64)
      const eventId = `event_${randomUUID()}`
      const jobId = `job_${randomUUID()}`
      const taskId = `task_${randomUUID()}`
      const providerRequestId = `relay-${randomUUID()}`
      const attemptKey = `mm-${'b'.repeat(64)}`
      const bodyHash = 'c'.repeat(64)
      const usage = { modality: 'text', model: 'fixture-model', input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      const cost = { currency: 'CNY', actual: 0.25 }
      const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId, usage, cost })).digest('hex')

      await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
      await withWorkspaceTransaction(app, workspaceId, client => client.query('SELECT * FROM charged_text_no_delivery_resolutions'))
        .catch(error => expect(error).toMatchObject({ code: '42501' }))
      await expect(withWorkspaceTransaction(app, workspaceId, client => client.query(
        `SELECT * FROM insert_charged_text_no_delivery_resolution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [workspaceId, actionKey, 'fake-reservation', jobId, eventId, providerRequestId, 'ops-user', 'manual refund', 'evidence-1', 1],
      ))).rejects.toMatchObject({ code: '23514' })

      const points = new PostgresCreativePointRepository(app)
      const lifecycle = new PostgresCreativePointLifecycleRepository(app)
      const claims = new PostgresCreativeActionClaimRepository(app)
      const dispatch = new PostgresChargedTextDispatchRepository(app)
      const business = new PostgresBusinessRepository(app, { normalizedProjection: true })
      const resolutions = new PostgresChargedTextNoDeliveryRepository(app)
      await points.grant({ workspaceId, idempotencyKey: 'fixture-grant', sourceType: 'paid_order', sourceId: 'fixture-order', points: 3 })
      const reservation = (await points.reserve({ workspaceId, idempotencyKey: `commercial.reserve:${actionKey}`, actionKey, points: 1, rateCardVersion: 'fixture-rate-v1' })).value
      const owner = await claims.claim({ workspaceId, actionKey, intentSha256: contextHash, leaseMs: 60_000 })

      await db.query("INSERT INTO products(id,workspace_id,platform,remote_product_id,title,stock,sku_count,source) VALUES('product-fixture',$1,'douyin','product-fixture','Fixture',1,1,'fixture')", [workspaceId])
      await db.query("INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES($1,$2,'product-fixture','douyin','plan_confirmed')", [taskId, workspaceId])
      await business.save({ workspaceId, entityType: 'generation_job', entityId: jobId, entityVersion: 1,
        payload: { id: jobId, workspaceId, taskId, idempotencyKey: 'no-delivery', state: 'queued', revision: 1, attempt: 1, updatedAt: new Date().toISOString() } })
      const eventPayload = { job_id: jobId, task_id: taskId, action_id: actionKey, context_hash: contextHash,
        input: { product: { id: 'product-fixture' }, knowledgeContext: { documents: [] } },
        commercial_access_snapshot: { access_mode: 'POINT_CHARGED', reservation_id: reservation.id, quoted_points: 1 },
        authorization_snapshot: { resource_id: jobId, authorized: true } }
      await withWorkspaceTransaction(app, workspaceId, async client => {
        await client.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)',
          [eventId, workspaceId, jobId, 'generation.requested', JSON.stringify(eventPayload)])
        await claims.bindInTransaction(client, { ...owner, reservationId: reservation.id, jobId, eventId })
      })
      const attempt = await dispatch.claim({ workspaceId, actionKey, eventId, logicalAttempt: 1, transportAttempt: 1, providerAttemptKey: attemptKey, requestBodySha256: bodyHash })
      await dispatch.transition({ workspaceId, id: attempt.id, ownerToken: attempt.ownerToken, to: 'provider_started' })
      await dispatch.transition({ workspaceId, id: attempt.id, ownerToken: attempt.ownerToken, to: 'response_recorded', providerRequestId })
      await dispatch.transition({ workspaceId, id: attempt.id, ownerToken: attempt.ownerToken, to: 'completed', providerRequestId })
      await points.settle({ workspaceId, idempotencyKey: `commercial.settle:${actionKey}`, reservationId: reservation.id, actualPoints: 1,
        metadata: { provider_request_id: providerRequestId, receipt_hash: receiptHash, cost_cny: 0.25, modality: 'text' } })
      for (const provider of ['model-relay', 'worker-relay']) await lifecycle.recordProviderReceipt({ workspaceId,
        operationId: reservation.operationId, provider, providerRequestId, outcome: 'succeeded', usage, cost,
        receiptHash, verifiedAt: new Date().toISOString(), at: new Date().toISOString() })
      await db.query(`INSERT INTO action_ledger(id,workspace_id,action_key,action_kind,settlement,state,units,amount_fen,actor_id,description,provider_request_id,settlement_status)
        VALUES($1,$2,$3,'model_text','wallet','settled',1,0,'fixture-actor','fixture settled request',$4,'settled')`,
        [`ledger_${randomUUID()}`, workspaceId, actionKey, providerRequestId])
      await db.query(`INSERT INTO model_usage_ledger(id,workspace_id,action_id,modality,model,provider_request_id,input_tokens,output_tokens,total_tokens,cost_cny,receipt_key,settlement_status,receipt_hash)
        VALUES($1,$2,$3,'text','fixture-model',$4,20,10,30,0.25,$4,'settled',$5)`,
        [`usage_${randomUUID()}`, workspaceId, actionKey, providerRequestId, receiptHash])
      await db.query(`UPDATE outbox_events SET unknown_at=now(),last_error='{"code":"CHARGED_TEXT_SCHEMA_REPAIR_DISABLED"}'::jsonb WHERE workspace_id=$1 AND id=$2`, [workspaceId, eventId])

      await db.query(`CREATE FUNCTION reject_no_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='ops.marketing.generation.no_delivery.refund' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`)
      await db.query(`CREATE TRIGGER reject_no_delivery_audit BEFORE INSERT ON workspace_operation_audit FOR EACH ROW EXECUTE FUNCTION reject_no_delivery_audit()`)
      rejectAudit = true
      const request = { workspaceId, actionKey, actorId: 'finance-fixture', reason: 'provider response had no deliverable', evidenceRef: 'case-123', expectedJobRevision: 1 }
      await expect(resolutions.resolve(request)).rejects.toThrow('fixture audit failure')
      const rolledBack = await db.query(`SELECT
        (SELECT count(*)::int FROM charged_text_no_delivery_resolutions WHERE workspace_id=$1) AS resolutions,
        (SELECT count(*)::int FROM creative_point_reversals_v2 WHERE workspace_id=$1) AS reversals,
        (SELECT state FROM generation_jobs WHERE workspace_id=$1 AND id=$2) AS job_state,
        (SELECT entity_version FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='generation_job' AND entity_id=$2) AS job_revision`, [workspaceId, jobId])
      expect(rolledBack.rows[0]).toEqual({ resolutions: 0, reversals: 0, job_state: 'queued', job_revision: 1 })
      await db.query('DROP TRIGGER reject_no_delivery_audit ON workspace_operation_audit')
      await db.query('DROP FUNCTION reject_no_delivery_audit()')
      rejectAudit = false

      const before = await points.getBalance(workspaceId)
      if (before.availablePoints === null) throw new Error('fixture creative point balance is unknown')
      const resolved = await resolutions.resolve(request)
      const replay = await resolutions.resolve(request)
      expect(resolved).toMatchObject({ actionKey, providerRequestId, refundedPoints: 1, actorId: request.actorId })
      expect(replay).toEqual(resolved)
      const after = await points.getBalance(workspaceId)
      expect(after.availablePoints).toBe(before.availablePoints + 1)
      expect(after.settledPoints).toBe(0)
      expect((await db.query(`SELECT count(*)::int AS count FROM creative_point_reversals_v2 WHERE workspace_id=$1 AND original_reservation_id=$2`, [workspaceId, reservation.id])).rows[0]?.count).toBe(1)
      await expect(db.query(`UPDATE generation_jobs SET state='succeeded' WHERE workspace_id=$1 AND id=$2`, [workspaceId, jobId])).rejects.toMatchObject({ code: '23514' })
    } catch (error) { primaryFailure = error; throw error }
    finally {
      await withPostgresFixtureCleanup(async () => {
        if (rejectAudit) await db?.query('DROP TRIGGER IF EXISTS reject_no_delivery_audit ON workspace_operation_audit').catch(() => undefined)
        await app?.end(); await db?.end(); await dropDrainedPostgresFixture(admin, name)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
