import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPublishMediaOrphanRepository } from './publish-media-orphan-repository.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe('Postgres publish media recovery isolation', () => {
  it('applies migration 272 and enforces workspace, job/event, unique key, and safe state boundaries when an isolated PostgreSQL URL is configured', async () => {
    if (!source) { expect(source).toBeUndefined(); return }
    const base = new URL(source!)
    const dbName = `publish_media_272_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString(), max: 4 })
    let database: Pool | undefined
    let app: Pool | undefined
    const wsA = `ws_pmo_a_${randomUUID()}`
    const wsB = `ws_pmo_b_${randomUUID()}`
    const id = (prefix: string) => `${prefix}_${randomUUID()}`
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`)
      const dbUrl = new URL(base); dbUrl.pathname = `/${dbName}`
      database = new Pool({ connectionString: dbUrl.toString(), max: 4 })
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBe(272)
      await new MigrationRunner(database, migrations).run()
      await database.query('INSERT INTO workspaces(id,status) VALUES($1,$3),($2,$3)', [wsA, wsB, 'active'])
      const product = id('product'), task = id('task'), version = id('version'), job = id('job'), event = id('event')
      await database.query('INSERT INTO products(id,workspace_id,platform,remote_product_id,title,source) VALUES($1,$2,$3,$4,$5,$6)', [product,wsA,'taobao',id('remote'),'fixture','fixture'])
      await database.query('INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES($1,$2,$3,$4,$5)', [task,wsA,product,'taobao','publishing'])
      await database.query('INSERT INTO content_versions(id,workspace_id,task_id,version,body,state,created_by) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)', [version,wsA,task,'{}','approved','test'])
      await database.query('INSERT INTO publish_jobs(id,workspace_id,task_id,content_version_id,platform,idempotency_key,confirmation_hash,remote_snapshot_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [job,wsA,task,version,'taobao',id('idem'),'hash','snapshot','submitting'])
      await database.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)', [event,wsA,job,'publish.requested','{}'])
      const wrongJobEvent=id('wrong_job_event'), wrongTypeEvent=id('wrong_type_event')
      await database.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb),($6,$2,$3,$7,2,$5::jsonb)', [wrongJobEvent,wsA,id('other_job'),'publish.requested','{}',wrongTypeEvent,'state.snapshot'])
      const appUrl = new URL(dbUrl)
      appUrl.username = process.env.PERSISTENCE_RELEASE_APP_DATABASE_USER ?? 'merchant_app'
      appUrl.password = process.env.PERSISTENCE_RELEASE_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      const repository = new PostgresPublishMediaOrphanRepository(app)
      const binding = { workspaceId:wsA,publishJobId:job,eventId:event,mediaIdempotencyKey:`${job}:media:visual_a`,platform:'taobao',accountId:'acct_a',visualRef:'visual_a',role:'main' as const,sha256:'a'.repeat(64) }
      await expect(repository.transition({...binding,eventId:wrongJobEvent,mediaIdempotencyKey:`${job}:media:wrong_job`,state:'intent'})).rejects.toMatchObject({ code:'23503' })
      await expect(repository.transition({...binding,eventId:wrongTypeEvent,mediaIdempotencyKey:`${job}:media:wrong_type`,state:'intent'})).rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_event_binding' })
      const intent = await repository.transition({...binding,state:'intent'})
      const uploadedReceipt={mediaId:'remote_media_a',platform:'taobao',visualRef:'visual_a',role:'main',sha256:binding.sha256}
      const uploaded = await repository.transition({...binding,state:'uploaded',receipt:uploadedReceipt})
      expect(uploaded.id).toBe(intent.id)
      await expect(repository.transition({...binding,state:'uploaded',receipt:{mediaId:'remote_media_b'}})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      expect(await repository.getByKey(wsB,job,binding.mediaIdempotencyKey)).toBeUndefined()
      const crossTenant = await app.connect()
      try {
        await crossTenant.query('BEGIN')
        await crossTenant.query("SELECT set_config('app.workspace_id',$1,true)",[wsB])
        await expect(crossTenant.query('INSERT INTO publish_media_orphan_tasks(id,workspace_id,publish_job_id,event_id,media_idempotency_key,platform,account_id,visual_ref,role,sha256,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id('bad'),wsA,job,event,id('key'),'taobao','acct_a','visual_a','main','b'.repeat(64),'intent'])).rejects.toMatchObject({ code:'42501' })
        await crossTenant.query('ROLLBACK')
      } finally { crossTenant.release() }
      await repository.transition({...binding,state:'unknown',reason:'commit_unknown'})
      await expect(repository.transition({...binding,state:'deleted'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      await expect(repository.transition({...binding,mediaIdempotencyKey:`${job}:media:never_uploaded`,state:'deleted',receipt:uploadedReceipt,reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      await repository.transition({...binding,state:'orphaned',receipt:uploadedReceipt,reason:'prewrite_cleanup_pending_manual_recovery_required'})
      await expect(repository.transition({...binding,state:'deleted',receipt:{...uploadedReceipt,mediaId:'wrong_media'},reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      const deleted=await repository.transition({...binding,state:'deleted',receipt:uploadedReceipt,reason:'discard_adapter_confirmed_delete'})
      expect(deleted).toMatchObject({state:'deleted',receipt:uploadedReceipt,reason:'discard_adapter_confirmed_delete'})
    } finally {
      await app?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
      await admin.end()
    }
  }, 120_000)
})
