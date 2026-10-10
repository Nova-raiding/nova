import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPublishMediaOrphanRepository } from './publish-media-orphan-repository.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe('Postgres publish media recovery isolation', () => {
  it('enforces workspace, job/event, unique key, and safe state boundaries in an isolated migrated PostgreSQL database', async () => {
    if (!source) { expect(source).toBeUndefined(); return }
    const base = new URL(source)
    const databaseName = `release_pmedia_repo_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString(), max: 2 })
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    let databaseCreated = false
    const wsA = `ws_pmo_a_${randomUUID()}`
    const wsB = `ws_pmo_b_${randomUUID()}`
    const id = (prefix: string) => `${prefix}_${randomUUID()}`
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      databaseCreated = true
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 4 })
      const scratch = database
      const migrations = await loadMigrations()
      expect(migrations.at(-1)).toMatchObject({ version: 275, name: 'publish_media_orphan_event_guard' })
      const roleBootstrap = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await scratch.query(roleBootstrap)
      await new MigrationRunner(scratch, migrations).run()
      await scratch.query(roleBootstrap)
      await scratch.query('INSERT INTO workspaces(id,status) VALUES($1,$3),($2,$3)', [wsA, wsB, 'active'])
      const product = id('product'), task = id('task'), version = id('version'), job = id('job'), event = id('event')
      await scratch.query('INSERT INTO products(id,workspace_id,platform,remote_product_id,title,source) VALUES($1,$2,$3,$4,$5,$6)', [product,wsA,'taobao',id('remote'),'fixture','fixture'])
      await scratch.query('INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES($1,$2,$3,$4,$5)', [task,wsA,product,'taobao','publishing'])
      await scratch.query('INSERT INTO content_versions(id,workspace_id,task_id,version,body,state,created_by) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)', [version,wsA,task,'{}','approved','test'])
      await scratch.query('INSERT INTO publish_jobs(id,workspace_id,task_id,content_version_id,platform,idempotency_key,confirmation_hash,remote_snapshot_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [job,wsA,task,version,'taobao',id('idem'),'hash','snapshot','submitting'])
      await scratch.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)', [event,wsA,job,'publish.requested','{}'])
      const wrongJobEvent=id('wrong_job_event'), wrongTypeEvent=id('wrong_type_event')
      await scratch.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb),($6,$2,$3,$7,2,$5::jsonb)', [wrongJobEvent,wsA,id('other_job'),'publish.requested','{}',wrongTypeEvent,'state.snapshot'])
      const appUrl = new URL(isolated)
      appUrl.username = process.env.PERSISTENCE_RELEASE_APP_DATABASE_USER ?? 'merchant_app'
      appUrl.password = process.env.PERSISTENCE_RELEASE_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      const repository = new PostgresPublishMediaOrphanRepository(app)
      const binding = { workspaceId:wsA,publishJobId:job,eventId:event,mediaIdempotencyKey:`${job}:media:visual_a`,platform:'taobao',accountId:'acct_a',visualRef:'visual_a',role:'main' as const,sha256:'a'.repeat(64) }
      await expect(repository.transition({...binding,eventId:wrongJobEvent,mediaIdempotencyKey:`${job}:media:wrong_job`,state:'intent'})).rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_event_binding' })
      await expect(repository.transition({...binding,eventId:wrongTypeEvent,mediaIdempotencyKey:`${job}:media:wrong_type`,state:'intent'})).rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_event_binding' })
      const intent = await repository.transition({...binding,state:'intent'})
      await expect(repository.transition({...binding,state:'intent'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      const uploadedReceipt={mediaId:'remote_media_a',platform:'taobao',visualRef:'visual_a',role:'main',sha256:binding.sha256,simulated:false}
      for (const [suffix, invalidReceipt] of [
        ['number_media_id', {...uploadedReceipt, mediaId: 123}],
        ['string_simulated', {...uploadedReceipt, simulated: 'false'}],
        ['number_platform', {...uploadedReceipt, platform: 123}],
      ] as const) {
        const malformedBinding = {...binding, mediaIdempotencyKey:`${job}:media:${suffix}`}
        const malformedIntent = await repository.transition({...malformedBinding,state:'intent'})
        const malformedClient = await app.connect()
        try {
          await malformedClient.query('BEGIN')
          await malformedClient.query("SELECT set_config('app.workspace_id',$1,true)",[wsA])
          await expect(malformedClient.query(
            'UPDATE publish_media_orphan_tasks SET state=$1, receipt=$2::jsonb WHERE workspace_id=$3 AND id=$4',
            ['uploaded',JSON.stringify(invalidReceipt),wsA,malformedIntent.id],
          )).rejects.toMatchObject({code:'23514',constraint:'publish_media_orphan_transition'})
          await malformedClient.query('ROLLBACK')
        } finally { malformedClient.release() }
      }
      const uploaded = await repository.transition({...binding,state:'uploaded',receipt:uploadedReceipt})
      expect(uploaded.id).toBe(intent.id)
      await expect(repository.transition({...binding,state:'uploaded',receipt:{mediaId:'remote_media_b'}})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      const eventsBeforeExactReplay = await scratch.query<{count:string}>('SELECT count(*)::text AS count FROM publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2',[wsA,uploaded.id])
      await expect(repository.transition({...binding,state:'uploaded',receipt:uploadedReceipt})).resolves.toEqual(uploaded)
      await expect(repository.transition({...binding,state:'uploaded',receipt:uploadedReceipt,reason:'different_same_state_reason'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      const eventsAfterExactReplay = await scratch.query<{count:string}>('SELECT count(*)::text AS count FROM publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2',[wsA,uploaded.id])
      expect(eventsAfterExactReplay.rows[0]?.count).toBe(eventsBeforeExactReplay.rows[0]?.count)
      const interruptedUpload = {...binding,mediaIdempotencyKey:`${job}:media:interrupted_upload`}
      await repository.transition({...interruptedUpload,state:'intent'})
      const recoveredOrphan = await repository.transition({...interruptedUpload,state:'orphaned',receipt:{...uploadedReceipt,visualRef:interruptedUpload.visualRef},reason:'upload_receipt_persist_retry'})
      expect(recoveredOrphan).toMatchObject({state:'orphaned',reason:'upload_receipt_persist_retry',receipt:{mediaId:'remote_media_a'}})
      const directClient = await app.connect()
      try {
        await directClient.query('BEGIN')
        await directClient.query("SELECT set_config('app.workspace_id',$1,true)",[wsA])
        await expect(directClient.query('UPDATE publish_media_orphan_tasks SET state=$1 WHERE workspace_id=$2 AND id=$3',['deleted',wsA,uploaded.id])).rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_transition' })
        await directClient.query('ROLLBACK')
        await directClient.query('BEGIN')
        await directClient.query("SELECT set_config('app.workspace_id',$1,true)",[wsA])
        await expect(directClient.query('UPDATE publish_media_orphan_tasks SET visual_ref=$1 WHERE workspace_id=$2 AND id=$3',['other_visual',wsA,uploaded.id])).rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_transition' })
        await directClient.query('ROLLBACK')
      } finally { directClient.release() }
      expect(await repository.getByKey(wsB,job,binding.mediaIdempotencyKey)).toBeUndefined()
      const crossTenant = await app.connect()
      try {
        await crossTenant.query('BEGIN')
        await crossTenant.query("SELECT set_config('app.workspace_id',$1,true)",[wsB])
        await expect(crossTenant.query('INSERT INTO publish_media_orphan_tasks(id,workspace_id,publish_job_id,event_id,media_idempotency_key,platform,account_id,visual_ref,role,sha256,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id('bad'),wsA,job,event,id('key'),'taobao','acct_a','visual_a','main','b'.repeat(64),'intent'])).rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_event_binding' })
        await crossTenant.query('ROLLBACK')
      } finally { crossTenant.release() }
      await repository.transition({...binding,state:'unknown',reason:'commit_unknown'})
      await expect(repository.transition({...binding,state:'deleted'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      await expect(repository.transition({...binding,mediaIdempotencyKey:`${job}:media:never_uploaded`,state:'deleted',receipt:uploadedReceipt,reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      await repository.transition({...binding,state:'orphaned',receipt:uploadedReceipt,reason:'prewrite_cleanup_pending_manual_recovery_required'})
      await expect(repository.transition({...binding,state:'deleted',receipt:{...uploadedReceipt,mediaId:'wrong_media'},reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      await expect(repository.transition({...binding,state:'deleted',receipt:uploadedReceipt,reason:'discard_adapter_confirmed_delete'})).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
      expect(await repository.getByKey(wsA,job,binding.mediaIdempotencyKey)).toMatchObject({state:'orphaned',receipt:uploadedReceipt})

      // Simulate a legacy row during a rolling upgrade. Replaying its exact
      // deletion callback must return the durable row without another audit
      // event or updated_at write; migration 274 normally downgrades these.
      // Keep the simulation and repository replay inside one outer transaction
      // and roll it back so no invalid legacy row escapes into the shared DB.
      const preLegacySimulation = await repository.getByKey(wsA,job,binding.mediaIdempotencyKey)
      expect(preLegacySimulation).toBeDefined()
      const legacyClient = await scratch.connect()
      try {
        await legacyClient.query('BEGIN')
        await legacyClient.query('ALTER TABLE public.publish_media_orphan_tasks DISABLE TRIGGER publish_media_orphan_transition_guard')
        await legacyClient.query('ALTER TABLE public.publish_media_orphan_tasks DISABLE TRIGGER publish_media_orphan_task_event_append')
        await legacyClient.query("UPDATE publish_media_orphan_tasks SET state='deleted',reason='discard_adapter_confirmed_delete' WHERE workspace_id=$1 AND id=$2",[wsA,uploaded.id])
        await legacyClient.query('ALTER TABLE public.publish_media_orphan_tasks ENABLE TRIGGER publish_media_orphan_task_event_append')
        await legacyClient.query('ALTER TABLE public.publish_media_orphan_tasks ENABLE TRIGGER publish_media_orphan_transition_guard')
        const nestedRepository = new PostgresPublishMediaOrphanRepository({
          connect: async () => ({
            query: async (text: string, values?: readonly unknown[]) => {
              if (text === 'BEGIN') return legacyClient.query('SAVEPOINT publish_media_repository_replay')
              if (text === 'COMMIT') return legacyClient.query('RELEASE SAVEPOINT publish_media_repository_replay')
              if (text === 'ROLLBACK') return legacyClient.query('ROLLBACK TO SAVEPOINT publish_media_repository_replay')
              return legacyClient.query(text, values as unknown[] | undefined)
            },
            release: () => {},
          }),
        } as ConstructorParameters<typeof PostgresPublishMediaOrphanRepository>[0])
        const fixtureTriggers = await legacyClient.query<{name:string;enabled:string}>(
          `SELECT tgname AS name,tgenabled AS enabled FROM pg_catalog.pg_trigger
            WHERE tgrelid='public.publish_media_orphan_tasks'::regclass
              AND tgname IN ('publish_media_orphan_transition_guard','publish_media_orphan_task_event_append')
            ORDER BY tgname`,
        )
        expect(fixtureTriggers.rows).toEqual([
          {name:'publish_media_orphan_task_event_append',enabled:'O'},
          {name:'publish_media_orphan_transition_guard',enabled:'O'},
        ])
        const legacyDeleted = await nestedRepository.getByKey(wsA,job,binding.mediaIdempotencyKey)
        const eventsBeforeReplay = await legacyClient.query<{count:string}>('SELECT count(*)::text AS count FROM public.publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2',[wsA,uploaded.id])
        const replay = await nestedRepository.transition({...binding,state:'deleted',receipt:uploadedReceipt,reason:'discard_adapter_confirmed_delete'})
        const eventsAfterReplay = await legacyClient.query<{count:string}>('SELECT count(*)::text AS count FROM public.publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2',[wsA,uploaded.id])
        expect(replay).toEqual(legacyDeleted)
        expect(eventsAfterReplay.rows[0]?.count).toBe(eventsBeforeReplay.rows[0]?.count)
        await legacyClient.query('ROLLBACK')
      } catch (error) {
        await legacyClient.query('ROLLBACK')
        throw error
      } finally {
        legacyClient.release()
      }
      await expect(repository.getByKey(wsA,job,binding.mediaIdempotencyKey)).resolves.toEqual(preLegacySimulation)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        const pools = [app, database].filter((pool): pool is Pool => pool !== undefined)
        const closeResults = await Promise.allSettled(pools.map(pool => pool.end()))
        const closeFailures = closeResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (closeFailures.length > 0) throw new AggregateError(closeFailures.map(result => result.reason), 'Publish media isolated PostgreSQL pools failed to close')
      }, primaryFailure, [
        ...(databaseCreated ? [() => dropDrainedPostgresFixture(admin, databaseName)] : []),
        () => admin.end(),
      ])
    }
  }, 120_000)
})
