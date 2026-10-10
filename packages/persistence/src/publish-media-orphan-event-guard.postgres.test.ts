import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPublishMediaOrphanRepository } from './publish-media-orphan-repository.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe('publish media orphan event insert guard', () => {
  const postgresIt = source ? it : it.skip
  postgresIt('keeps repository events valid and rejects merchant_app forged terminal history', async () => {
    const base = new URL(source!)
    const databaseName = `release_pmedia_event_guard_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString(), max: 2 })
    const suffix = randomUUID().replaceAll('-', '')
    const id = (prefix: string) => `${prefix}_${suffix}`
    const workspace = id('pmoeg_ws')
    let database: Pool | undefined
    let app: Pool | undefined
    let databaseCreated = false
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      databaseCreated = true
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 2 })
      const migrations = await loadMigrations()
      expect(migrations.find(migration => migration.version === 275)).toMatchObject({ name: 'publish_media_orphan_event_guard' })
      const roleBootstrap = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await database.query(roleBootstrap)
      const through276 = migrations.filter(migration => migration.version <= 276)
      expect(through276.at(-1)).toMatchObject({ version: 276, name: 'outbox_execution_reservation' })
      await new MigrationRunner(database, through276).run()
      const appliedBefore277 = await database.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      )
      expect(appliedBefore277.rows[0]?.version).toBe(276)
      const functionSecurityBefore277 = await database.query<{
        owner: string
        acl: string | null
        security_definer: boolean
        config: string[] | null
        trigger_function_oid: string
      }>(`
        SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner,
          p.proacl::text AS acl,p.prosecdef AS security_definer,p.proconfig AS config,
          t.tgfoid::text AS trigger_function_oid
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_catalog.pg_trigger t ON t.tgfoid=p.oid
        WHERE n.nspname='public' AND p.proname='append_publish_media_orphan_event_from_task'
          AND t.tgname='publish_media_orphan_task_event_append'
      `)
      expect(functionSecurityBefore277.rows).toHaveLength(1)
      expect(functionSecurityBefore277.rows[0]).toMatchObject({
        owner: 'merchant_schema_owner',
        security_definer: true,
        config: ['search_path=pg_catalog'],
      })
      const migration277 = migrations.find(migration => migration.version === 277)!
      expect(await new MigrationRunner(database, [migration277]).run()).toEqual([277])
      const appliedAfter277 = await database.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      )
      expect(appliedAfter277.rows[0]?.version).toBe(277)
      const functionSecurityAfter277 = await database.query<{
        owner: string
        acl: string | null
        security_definer: boolean
        config: string[] | null
        trigger_function_oid: string
      }>(`
        SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner,
          p.proacl::text AS acl,p.prosecdef AS security_definer,p.proconfig AS config,
          t.tgfoid::text AS trigger_function_oid
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_catalog.pg_trigger t ON t.tgfoid=p.oid
        WHERE n.nspname='public' AND p.proname='append_publish_media_orphan_event_from_task'
          AND t.tgname='publish_media_orphan_task_event_append'
      `)
      expect(functionSecurityAfter277.rows).toEqual(functionSecurityBefore277.rows)
      // Exercise the same post-migration bootstrap pass used by deployment:
      // broad compatibility grants must not reopen the append-only ledger.
      await database.query(roleBootstrap)
      const ownerAndPrivileges = await database.query<{ event_owner: string; owner_login: boolean; owner_super: boolean; owner_bypass: boolean; owner_schema_usage: boolean; owner_schema_create: boolean; app_is_member: boolean; ops_is_member: boolean; owner_has_app: boolean; owner_has_ops: boolean; task_select: boolean; task_rls: boolean; task_force_rls: boolean; task_workspace_policy: boolean; app_insert: boolean; ops_insert: boolean; app_execute: boolean; ops_execute: boolean }>(`
        SELECT pg_catalog.pg_get_userbyid(c.relowner) AS event_owner,
          r.rolcanlogin AS owner_login,r.rolsuper AS owner_super,r.rolbypassrls AS owner_bypass,
          has_schema_privilege('merchant_schema_owner','public','USAGE') AS owner_schema_usage,
          has_schema_privilege('merchant_schema_owner','public','CREATE') AS owner_schema_create,
          pg_catalog.pg_has_role('merchant_app',r.rolname,'MEMBER') AS app_is_member,
          pg_catalog.pg_has_role('merchant_ops',r.rolname,'MEMBER') AS ops_is_member,
          pg_catalog.pg_has_role(r.rolname,'merchant_app','MEMBER') AS owner_has_app,
          pg_catalog.pg_has_role(r.rolname,'merchant_ops','MEMBER') AS owner_has_ops,
          has_table_privilege('merchant_schema_owner','public.publish_media_orphan_tasks','SELECT') AS task_select,
          task.relrowsecurity AS task_rls,task.relforcerowsecurity AS task_force_rls,
          EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=task.oid AND p.polname='publish_media_orphan_tasks_workspace_isolation'
            AND pg_catalog.pg_get_expr(p.polqual,p.polrelid) LIKE '%app.workspace_id%') AS task_workspace_policy,
          has_table_privilege('merchant_app','public.publish_media_orphan_events','INSERT') AS app_insert,
          has_table_privilege('merchant_ops','public.publish_media_orphan_events','INSERT') AS ops_insert,
          has_function_privilege('merchant_app','public.append_publish_media_orphan_event_from_task()','EXECUTE') AS app_execute,
          has_function_privilege('merchant_ops','public.append_publish_media_orphan_event_from_task()','EXECUTE') AS ops_execute
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
        CROSS JOIN pg_catalog.pg_class task
        WHERE c.oid='public.publish_media_orphan_events'::regclass
          AND task.oid='public.publish_media_orphan_tasks'::regclass
      `)
      expect(ownerAndPrivileges.rows).toEqual([{ event_owner: 'merchant_schema_owner', owner_login: false, owner_super: false, owner_bypass: false, owner_schema_usage: true, owner_schema_create: false, app_is_member: false, ops_is_member: false, owner_has_app: false, owner_has_ops: false, task_select: true, task_rls: true, task_force_rls: true, task_workspace_policy: true, app_insert: false, ops_insert: false, app_execute: false, ops_execute: false }])
      await database.query('INSERT INTO workspaces(id,status) VALUES($1,$2)', [workspace, 'active'])
      const product=id('product'), task=id('task'), version=id('version'), job=id('job'), event=id('event')
      await database.query('INSERT INTO products(id,workspace_id,platform,remote_product_id,title,source) VALUES($1,$2,$3,$4,$5,$6)', [product,workspace,'taobao',id('remote'),'fixture','fixture'])
      await database.query('INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES($1,$2,$3,$4,$5)', [task,workspace,product,'taobao','publishing'])
      await database.query('INSERT INTO content_versions(id,workspace_id,task_id,version,body,state,created_by) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)', [version,workspace,task,'{}','approved','event-guard-test'])
      await database.query('INSERT INTO publish_jobs(id,workspace_id,task_id,content_version_id,platform,idempotency_key,confirmation_hash,remote_snapshot_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [job,workspace,task,version,'taobao',id('idem'),'hash','snapshot','submitting'])
      await database.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)', [event,workspace,job,'publish.requested','{}'])

      const appUrl = new URL(isolated)
      appUrl.username = process.env.PERSISTENCE_RELEASE_APP_DATABASE_USER ?? 'merchant_app'
      appUrl.password = process.env.PERSISTENCE_RELEASE_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const repository = new PostgresPublishMediaOrphanRepository(app)
      const binding = { workspaceId:workspace,publishJobId:job,eventId:event,mediaIdempotencyKey:`${job}:media:main`,platform:'taobao',accountId:'acct',visualRef:'visual',role:'main' as const,sha256:'a'.repeat(64) }
      await repository.transition({...binding,state:'intent'})
      const receipt={mediaId:'remote_media',platform:'taobao',visualRef:'visual',role:'main',sha256:binding.sha256,simulated:false}
      await repository.transition({...binding,state:'uploaded',receipt})
      // The task trigger derives receipt presence from the persisted row, so
      // the inherited receipt remains visible in retained-state history.
      await repository.transition({...binding,state:'retained',reason:'platform_write_confirmed'})
      const mediaTaskId = (await repository.getByKey(workspace,job,binding.mediaIdempotencyKey))?.id
      expect(mediaTaskId).toBeTruthy()
      const rows = await database.query<{state:string;detail:Record<string,unknown>}>(
        'SELECT state,detail FROM publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2 ORDER BY created_at',
        [workspace, mediaTaskId],
      )
      expect(rows.rows).toHaveLength(3)
      expect(rows.rows).toEqual(expect.arrayContaining([
        {state:'intent',detail:{reason:null,hasReceipt:false}},
        {state:'uploaded',detail:{reason:null,hasReceipt:true}},
        {state:'retained',detail:{reason:'platform_write_confirmed',hasReceipt:true}},
      ]))

      // UPDATE OF fires when a watched column is named in SET, even when its
      // value is unchanged. A workspace-scoped app no-op must not append a
      // duplicate lifecycle event; an actual watched-field change still must.
      const scopedWriter = await app.connect()
      try {
        await scopedWriter.query('BEGIN')
        await scopedWriter.query("SELECT set_config('app.workspace_id',$1,true)", [workspace])
        expect((await scopedWriter.query('SELECT current_user AS role')).rows[0]?.role).toBe('merchant_app')
        await scopedWriter.query('UPDATE publish_media_orphan_tasks SET state=state WHERE workspace_id=$1 AND id=$2', [workspace,mediaTaskId])
        await scopedWriter.query('COMMIT')
        const afterNoop = await database.query<{count:string}>(
          'SELECT count(*)::text AS count FROM publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2',
          [workspace,mediaTaskId],
        )
        expect(afterNoop.rows[0]?.count).toBe('3')

        await scopedWriter.query('BEGIN')
        await scopedWriter.query("SELECT set_config('app.workspace_id',$1,true)", [workspace])
        await scopedWriter.query("UPDATE publish_media_orphan_tasks SET reason='no_op_guard_regression' WHERE workspace_id=$1 AND id=$2", [workspace,mediaTaskId])
        await scopedWriter.query('COMMIT')
      } catch (error) {
        await scopedWriter.query('ROLLBACK')
        throw error
      } finally {
        scopedWriter.release()
      }
      const afterRealChange = await database.query<{state:string;detail:Record<string,unknown>}>(
        `SELECT state,detail FROM publish_media_orphan_events
          WHERE workspace_id=$1 AND task_id=$2 AND detail->>'reason'='no_op_guard_regression'`,
        [workspace,mediaTaskId],
      )
      const afterRealCount = await database.query<{count:string}>(
        'SELECT count(*)::text AS count FROM publish_media_orphan_events WHERE workspace_id=$1 AND task_id=$2',
        [workspace,mediaTaskId],
      )
      expect(afterRealCount.rows[0]?.count).toBe('4')
      expect(afterRealChange.rows).toEqual([{state:'retained',detail:{reason:'no_op_guard_regression',hasReceipt:true}}])

      // Runtime-role probes below prove ACL denial. This admin-path probe also
      // reaches the insert trigger and proves that valid-looking history cannot
      // be appended outside the lifecycle task trigger.
      const triggerProbe = await database.connect()
      try {
        await triggerProbe.query('BEGIN')
        await triggerProbe.query('SET LOCAL ROLE merchant_schema_owner')
        await triggerProbe.query("SELECT set_config('app.workspace_id',$1,true)", [workspace])
        await triggerProbe.query('SAVEPOINT reject_top_level_event')
        await expect(triggerProbe.query(
          `INSERT INTO publish_media_orphan_events(id,workspace_id,task_id,state,detail)
           VALUES($1,$2,$3,'retained',$4::jsonb)`,
          [id('forged_top_level'),workspace,mediaTaskId,JSON.stringify({reason:'platform_write_confirmed',hasReceipt:true})],
        )).rejects.toMatchObject({code:'23514',constraint:'publish_media_orphan_event_state'})
        await triggerProbe.query('ROLLBACK TO SAVEPOINT reject_top_level_event')
        await triggerProbe.query('ROLLBACK')
      } finally {
        triggerProbe.release()
      }

      // Boundary: the database prevents direct ledger INSERT and derives each
      // event from the bound task under workspace RLS. merchant_app still has
      // task UPDATE for lifecycle writes, so this ledger proves what persisted
      // on that row, not which application call supplied its reason.
      const attacker = await app.connect()
      try {
        for (const [suffix, state, detail] of [
          ['forged_deleted','deleted',{reason:'discard_adapter_confirmed_delete',hasReceipt:true}],
          ['forged_duplicate','retained',{reason:'platform_write_confirmed',hasReceipt:true}],
        ] as const) {
          await attacker.query('BEGIN')
          await attacker.query("SELECT set_config('app.workspace_id',$1,true)", [workspace])
          await expect(attacker.query(
            `INSERT INTO publish_media_orphan_events(id,workspace_id,task_id,state,detail)
             SELECT $1,$2,id,$3,$4::jsonb FROM publish_media_orphan_tasks WHERE workspace_id=$2 AND publish_job_id=$5`,
            [id(suffix),workspace,state,JSON.stringify(detail),job],
          )).rejects.toMatchObject({code:'42501'})
          await attacker.query('ROLLBACK')
        }
      } finally { attacker.release() }
      const finalCount = await database.query<{count:string}>(
        'SELECT count(*)::text AS count FROM publish_media_orphan_events WHERE workspace_id=$1', [workspace],
      )
      expect(finalCount.rows[0]?.count).toBe('4')
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      const finalizers: (() => Promise<unknown>)[] = []
      if (databaseCreated) finalizers.push(() => dropDrainedPostgresFixture(admin, databaseName))
      finalizers.push(() => admin.end())
      await withPostgresFixtureCleanup(async () => {
        const pools = [app, database].filter((pool): pool is Pool => pool !== undefined)
        const closeResults = await Promise.allSettled(pools.map(pool => pool.end()))
        const closeFailures = closeResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (closeFailures.length > 0) throw new AggregateError(closeFailures.map(result => result.reason), 'Publish media event guard PostgreSQL pools failed to close')
      }, primaryFailure, finalizers)
    }
  }, 180_000)
})
