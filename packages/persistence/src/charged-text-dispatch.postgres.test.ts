import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresChargedTextDispatchRepository } from './charged-text-dispatch-repository.js'
import { PostgresCreativeActionClaimRepository } from './creative-point-action-claim-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { withWorkspaceTransaction } from './repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const keyA = `mm-${'a'.repeat(64)}`
const keyB = `mm-${'b'.repeat(64)}`
const bodyA = 'c'.repeat(64)
const bodyB = 'd'.repeat(64)
const urlFor = (base: URL, name: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${name}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 252 charged text physical dispatch fence', () => {
  postgresIt('serializes two workers and distinguishes rejected retry, repair and unknown outcomes', async () => {
    const base = new URL(databaseUrl!)
    const name = `release_fresh_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let db: Pool | undefined
    let app: Pool | undefined
    let failure: unknown
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      db = new Pool({ connectionString: urlFor(base, name), max: 4 })
      const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await db.query(roleSql)
      const migrations = [
        ...(await loadMigrations()).filter(migration => migration.version < 252),
        { version: 252, name: 'charged_text_dispatch_attempts', sql: await readFile(new URL('./migrations/252_charged_text_dispatch_attempts.sql', import.meta.url), 'utf8') },
      ]
      expect(migrations.at(-2)?.version).toBe(251)
      expect((await new MigrationRunner(db, migrations).run()).at(-1)).toBe(252)
      await db.query(roleSql)
      const acl = await db.query<{ claim: boolean; transition: boolean; opsClaim: boolean }>(`
        SELECT has_function_privilege('merchant_app','public.claim_charged_text_dispatch_attempt(text,text,text,integer,integer,text,text)','EXECUTE') AS claim,
          has_function_privilege('merchant_app','public.transition_charged_text_dispatch_attempt(text,text,text,text,text)','EXECUTE') AS transition,
          has_function_privilege('merchant_ops','public.claim_charged_text_dispatch_attempt(text,text,text,integer,integer,text,text)','EXECUTE') AS "opsClaim"
      `)
      expect(acl.rows[0]).toEqual({ claim: true, transition: true, opsClaim: false })
      app = new Pool({ connectionString: urlFor(base, name, 'merchant_app', 'merchant_app_local_only'), max: 8 })
      const actions = new PostgresCreativeActionClaimRepository(app)
      const dispatch = new PostgresChargedTextDispatchRepository(app)
      const ws = 'ws_dispatch_252'
      const action = 'model:generation:client-one'
      const context = 'e'.repeat(64)
      await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [ws])
      await db.query("INSERT INTO products(id,workspace_id,platform,remote_product_id,title,stock,sku_count,source) VALUES('product-252',$1,'douyin','product-252','Fixture',1,1,'fixture')", [ws])
      await db.query("INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES('task-252',$1,'product-252','douyin','plan_confirmed')", [ws])
      await db.query("INSERT INTO generation_jobs(id,workspace_id,task_id,idempotency_key,state) VALUES('job-252',$1,'task-252','client-one','queued')", [ws])
      await db.query("INSERT INTO creative_point_operations(id,workspace_id,kind,idempotency_key,status,request,result,completed_at) VALUES('operation-252',$1,'reserve',$2,'completed',$3::jsonb,$4::jsonb,now())", [ws, `commercial.reserve:${action}`, JSON.stringify({ action_key: action, points: 1, rate_card_version: 'rate-v1' }), JSON.stringify({ entity_id: 'reservation-252' })])
      await db.query("INSERT INTO creative_point_reservations(id,workspace_id,operation_id,action_key,points,status,rate_card_version) VALUES('reservation-252',$1,'operation-252',$2,1,'active','rate-v1')", [ws, action])
      const payload = { job_id: 'job-252', task_id: 'task-252', action_id: action, context_hash: context,
        input: { product: { id: 'product-252' }, knowledgeContext: { documents: [] } },
        commercial_access_snapshot: { access_mode: 'POINT_CHARGED', reservation_id: 'reservation-252', quoted_points: 1 },
        authorization_snapshot: { resource_id: 'job-252', authorized: true } }
      const owner = await actions.claim({ workspaceId: ws, actionKey: action, intentSha256: context, leaseMs: 60_000 })
      await withWorkspaceTransaction(db, ws, async client => {
        await client.query("INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES('event-252',$1,'job-252','generation.requested',1,$2::jsonb)", [ws, JSON.stringify(payload)])
        await actions.bindInTransaction(client, { ...owner, reservationId: 'reservation-252', jobId: 'job-252', eventId: 'event-252' })
      })
      const firstInput = { workspaceId: ws, actionKey: action, eventId: 'event-252', logicalAttempt: 1, transportAttempt: 1, providerAttemptKey: keyA, requestBodySha256: bodyA }
      const race = await Promise.allSettled([dispatch.claim(firstInput), dispatch.claim(firstInput)])
      expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(race.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CHARGED_TEXT_DISPATCH_DENIED' } })
      const first = (race.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof dispatch.claim>>>).value
      await expect(dispatch.claim({ ...firstInput, transportAttempt: 2 })).rejects.toMatchObject({ code: 'CHARGED_TEXT_DISPATCH_DENIED' })
      await dispatch.transition({ workspaceId: ws, id: first.id, ownerToken: first.ownerToken, to: 'provider_started' })
      await expect(db.query("UPDATE creative_point_reservations SET status='released' WHERE id='reservation-252'")).rejects.toMatchObject({ code: '23514' })
      await dispatch.transition({ workspaceId: ws, id: first.id, ownerToken: first.ownerToken, to: 'rejected' })
      const retry = await dispatch.claim({ ...firstInput, transportAttempt: 2 })
      await dispatch.transition({ workspaceId: ws, id: retry.id, ownerToken: retry.ownerToken, to: 'provider_started' })
      await dispatch.transition({ workspaceId: ws, id: retry.id, ownerToken: retry.ownerToken, to: 'response_recorded', providerRequestId: 'relay-retry-252' })
      await expect(dispatch.claim({ ...firstInput, logicalAttempt: 2, transportAttempt: 1, providerAttemptKey: keyB, requestBodySha256: bodyB })).rejects.toMatchObject({ code: 'CHARGED_TEXT_DISPATCH_DENIED' })
      await dispatch.transition({ workspaceId: ws, id: retry.id, ownerToken: retry.ownerToken, to: 'repair_required' })
      const repair = await dispatch.claim({ ...firstInput, logicalAttempt: 2, transportAttempt: 1, providerAttemptKey: keyB, requestBodySha256: bodyB })
      await dispatch.transition({ workspaceId: ws, id: repair.id, ownerToken: repair.ownerToken, to: 'provider_started' })
      await dispatch.transition({ workspaceId: ws, id: repair.id, ownerToken: repair.ownerToken, to: 'outcome_unknown' })
      await expect(dispatch.claim({ ...firstInput, logicalAttempt: 2, transportAttempt: 2, providerAttemptKey: keyB, requestBodySha256: bodyB })).rejects.toMatchObject({ code: 'CHARGED_TEXT_DISPATCH_DENIED' })
      // An ordinary worker cannot resolve an ambiguous provider outcome by
      // asserting success or rejection; this must stay fenced for reconciliation.
      await expect(dispatch.transition({ workspaceId: ws, id: repair.id, ownerToken: repair.ownerToken, to: 'completed', providerRequestId: 'relay-repair-252' }))
        .rejects.toMatchObject({ code: 'CHARGED_TEXT_DISPATCH_TRANSITION_DENIED' })
      await expect(dispatch.transition({ workspaceId: ws, id: repair.id, ownerToken: repair.ownerToken, to: 'rejected' }))
        .rejects.toMatchObject({ code: 'CHARGED_TEXT_DISPATCH_TRANSITION_DENIED' })
      expect((await db.query("SELECT state FROM charged_text_dispatch_attempts ORDER BY logical_attempt,transport_attempt")).rows)
        .toEqual([{ state: 'rejected' }, { state: 'repair_required' }, { state: 'outcome_unknown' }])
    } catch (error) { failure = error; throw error }
    finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end(); await db?.end(); await dropDrainedPostgresFixture(admin, name)
      }, failure, [() => admin.end()])
    }
  }, 240_000)
})
