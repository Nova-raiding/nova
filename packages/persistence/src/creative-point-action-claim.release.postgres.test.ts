import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCreativeActionClaimRepository } from './creative-point-action-claim-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { withWorkspaceTransaction } from './repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const urlFor = (base: URL, name: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${name}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 251 enqueue ownership PostgreSQL', () => {
  postgresIt('binds a no-knowledge, no-brand first charged enqueue atomically and fences replay', async () => {
    const base = new URL(databaseUrl!)
    const name = `release_fresh_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let db: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      db = new Pool({ connectionString: urlFor(base, name) })
      const migrations = [
        ...(await loadMigrations()).filter(migration => migration.version < 251),
        { version: 251, name: 'creative_point_action_claims', sql: await readFile(new URL('./migrations/251_creative_point_action_claims.sql', import.meta.url), 'utf8') },
      ]
      await new MigrationRunner(db, migrations).run()
      const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await db.query(roleSql)
      await db.query(roleSql)
      const privileges = await db.query<{ claim: boolean; bind: boolean; release: boolean; directInsert: boolean; directUpdate: boolean; opsClaim: boolean }>(`
        SELECT has_function_privilege('merchant_app','public.claim_creative_point_action(text,text,text,bigint)','EXECUTE') AS claim,
          has_function_privilege('merchant_app','public.bind_creative_point_action(text,text,text,bigint,text,text,text)','EXECUTE') AS bind,
          has_function_privilege('merchant_app','public.release_unbound_creative_point_action(text,text,text,bigint)','EXECUTE') AS release,
          has_table_privilege('merchant_app','public.creative_point_action_claims','INSERT') AS "directInsert",
          has_table_privilege('merchant_app','public.creative_point_action_claims','UPDATE') AS "directUpdate",
          has_function_privilege('merchant_ops','public.claim_creative_point_action(text,text,text,bigint)','EXECUTE') AS "opsClaim"
      `)
      expect(privileges.rows[0]).toEqual({ claim: true, bind: true, release: true, directInsert: false, directUpdate: false, opsClaim: false })
      app = new Pool({ connectionString: urlFor(base, name, 'merchant_app', 'merchant_app_local_only'), max: 4 })
      const repo = new PostgresCreativeActionClaimRepository(app)
      const workspaceId = 'ws_enqueue_claim'
      const actionKey = 'model:generation:client-one'
      const intentSha256 = 'a'.repeat(64)
      const claimInput = { workspaceId, actionKey, intentSha256, leaseMs: 60_000 }
      await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
      const race = await Promise.allSettled([repo.claim(claimInput), repo.claim(claimInput)])
      expect(race.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      const owner = (race.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.claim>>>).value
      expect(race.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'CREATIVE_ACTION_BUSY' } })
      await expect(repo.claim({ ...claimInput, intentSha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CREATIVE_ACTION_INTENT_MISMATCH' })
      await db.query("INSERT INTO products(id,workspace_id,platform,remote_product_id,title,stock,sku_count,source) VALUES('product-one',$1,'douyin','product-one','No brand or knowledge',1,1,'fixture')", [workspaceId])
      await db.query("INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES('task-one',$1,'product-one','douyin','plan_confirmed')", [workspaceId])
      await db.query("INSERT INTO generation_jobs(id,workspace_id,task_id,idempotency_key,state) VALUES('job-one',$1,'task-one','client-one','queued')", [workspaceId])
      await db.query("INSERT INTO creative_point_operations(id,workspace_id,kind,idempotency_key,status,request,result,completed_at) VALUES('operation-one',$1,'reserve',$2,'completed',$3::jsonb,$4::jsonb,now())", [workspaceId, `commercial.reserve:${actionKey}`, JSON.stringify({ action_key: actionKey, points: 1, rate_card_version: 'rate-v1' }), JSON.stringify({ entity_id: 'reservation-one' })])
      await db.query("INSERT INTO creative_point_reservations(id,workspace_id,operation_id,action_key,points,status,rate_card_version) VALUES('reservation-one',$1,'operation-one',$2,1,'active','rate-v1')", [workspaceId, actionKey])
      const payload = { job_id: 'job-one', task_id: 'task-one', action_id: actionKey, context_hash: intentSha256,
        input: { product: { id: 'product-one' }, knowledgeContext: { documents: [] } },
        commercial_access_snapshot: { access_mode: 'POINT_CHARGED', reservation_id: 'reservation-one', quoted_points: 1 },
        authorization_snapshot: { resource_id: 'job-one', authorized: true } }
      await expect(withWorkspaceTransaction(db, workspaceId, async client => {
        await client.query("INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES('event-one',$1,'job-one','generation.requested',1,$2::jsonb)", [workspaceId, JSON.stringify(payload)])
        await repo.bindInTransaction(client, { ...owner, reservationId: 'reservation-one', jobId: 'job-one', eventId: 'event-one' })
        throw new Error('simulate transaction rollback')
      })).rejects.toThrow('simulate transaction rollback')
      expect(await repo.get(claimInput)).toMatchObject({ phase: 'leased' })
      expect((await db.query("SELECT id FROM outbox_events WHERE id='event-one'")).rows).toHaveLength(0)
      await withWorkspaceTransaction(db, workspaceId, async client => {
        await client.query("INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES('event-one',$1,'job-one','generation.requested',1,$2::jsonb)", [workspaceId, JSON.stringify(payload)])
        expect(await repo.bindInTransaction(client, { ...owner, reservationId: 'reservation-one', jobId: 'job-one', eventId: 'event-one' })).toMatchObject({ phase: 'bound' })
      })
      await expect(repo.claim(claimInput)).rejects.toMatchObject({ code: 'CREATIVE_ACTION_BOUND_RECOVERY_REQUIRED' })
      await expect(repo.releaseUnbound(owner)).rejects.toMatchObject({ code: 'CREATIVE_ACTION_STALE_OWNER' })
      const scoped = await app.query("SELECT count(*)::int AS n FROM creative_point_action_claims")
      expect(scoped.rows[0].n).toBe(0)
    } catch (error) { primaryFailure = error; throw error }
    finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end(); await db?.end(); await dropDrainedPostgresFixture(admin, name)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
