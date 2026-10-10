import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = source ? it : it.skip

describe('publish media lifecycle migration 274', () => {
  postgresIt('downgrades unverified deleted rows to recoverable orphans and blocks future deletion claims', async () => {
    const pool = new Pool({ connectionString: source!, max: 1 })
    const client = await pool.connect()
    const suffix = randomUUID().replaceAll('-', '')
    const workspace = `pml274_ws_${suffix}`
    const product = `pml274_product_${suffix}`
    const task = `pml274_task_${suffix}`
    const version = `pml274_version_${suffix}`
    const job = `pml274_job_${suffix}`
    const event = `pml274_event_${suffix}`
    const mediaTask = `pml274_media_${suffix}`
    const mediaKey = `${job}:media:visual`
    const receipt = {
      mediaId: `remote_${suffix}`, platform: 'taobao', visualRef: 'visual', role: 'main',
      sha256: 'a'.repeat(64), simulated: false,
    }
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO workspaces(id,status) VALUES($1,$2)', [workspace, 'active'])
      await client.query('INSERT INTO products(id,workspace_id,platform,remote_product_id,title,source) VALUES($1,$2,$3,$4,$5,$6)', [product,workspace,'taobao',`remote_product_${suffix}`,'fixture','fixture'])
      await client.query('INSERT INTO tasks(id,workspace_id,product_id,platform,state) VALUES($1,$2,$3,$4,$5)', [task,workspace,product,'taobao','publishing'])
      await client.query('INSERT INTO content_versions(id,workspace_id,task_id,version,body,state,created_by) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)', [version,workspace,task,'{}','approved','migration-test'])
      await client.query('INSERT INTO publish_jobs(id,workspace_id,task_id,content_version_id,platform,idempotency_key,confirmation_hash,remote_snapshot_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [job,workspace,task,version,'taobao',`idem_${suffix}`,'hash','snapshot','submitting'])
      await client.query('INSERT INTO outbox_events(id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)', [event,workspace,job,'publish.requested','{}'])
      await client.query(
        `INSERT INTO publish_media_orphan_tasks
          (id,workspace_id,publish_job_id,event_id,media_idempotency_key,platform,account_id,visual_ref,role,sha256,state,receipt,reason)
         VALUES($1,$2,$3,$4,$5,'taobao','acct','visual','main',$6,'intent',NULL,NULL)`,
        [mediaTask,workspace,job,event,mediaKey,receipt.sha256],
      )
      await client.query(
        "UPDATE publish_media_orphan_tasks SET state='uploaded',receipt=$2::jsonb,reason='cleanup_pending' WHERE id=$1",
        [mediaTask,JSON.stringify(receipt)],
      )

      // Model a valid row left by a 273 deployment before 274 was applied.
      // This fixture already has migration 275 installed. Disable only its
      // event triggers while recreating the pre-275 history: 273 did not append
      // task events and 274 performs a direct legacy backfill INSERT.
      await client.query('ALTER TABLE publish_media_orphan_tasks DISABLE TRIGGER publish_media_orphan_task_event_append')
      await client.query('ALTER TABLE publish_media_orphan_events DISABLE TRIGGER publish_media_orphan_events_insert_guard')
      await client.query('ALTER TABLE publish_media_orphan_tasks DISABLE TRIGGER publish_media_orphan_transition_guard')
      await client.query("UPDATE publish_media_orphan_tasks SET state='deleted',reason='discard_adapter_confirmed_delete' WHERE id=$1", [mediaTask])
      await client.query('ALTER TABLE publish_media_orphan_tasks ENABLE TRIGGER publish_media_orphan_transition_guard')
      const migration = await readFile(new URL('./migrations/274_unverified_publish_media_deletion.sql', import.meta.url), 'utf8')
      await client.query(migration)
      await client.query('ALTER TABLE publish_media_orphan_tasks ENABLE TRIGGER publish_media_orphan_task_event_append')
      await client.query('ALTER TABLE publish_media_orphan_events ENABLE TRIGGER publish_media_orphan_events_insert_guard')

      const migrated = await client.query<{state:string;receipt:typeof receipt;reason:string}>(
        'SELECT state,receipt,reason FROM publish_media_orphan_tasks WHERE id=$1', [mediaTask],
      )
      expect(migrated.rows[0]).toEqual({
        state: 'orphaned', receipt, reason: 'delete_unverified_legacy_recovery_required',
      })
      const history = await client.query<{state:string;detail:Record<string,unknown>}>(
        'SELECT state,detail FROM publish_media_orphan_events WHERE task_id=$1', [mediaTask],
      )
      expect(history.rows).toContainEqual({
        state: 'orphaned',
        detail: { source_state:'deleted', migration_version:274, verification:'unverified', recovery_required:true },
      })
      await client.query('SAVEPOINT reject_unverified_delete')
      await expect(client.query("UPDATE publish_media_orphan_tasks SET state='deleted',reason='discard_adapter_confirmed_delete' WHERE id=$1", [mediaTask]))
        .rejects.toMatchObject({ code:'23514', constraint:'publish_media_orphan_transition' })
      await client.query('ROLLBACK TO SAVEPOINT reject_unverified_delete')
      expect((await client.query('SELECT state,receipt FROM publish_media_orphan_tasks WHERE id=$1', [mediaTask])).rows[0])
        .toEqual({ state:'orphaned', receipt })
      await client.query('ROLLBACK')
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* retain the original failure */ }
      throw error
    } finally {
      client.release()
      await pool.end()
    }
  }, 60_000)
})
