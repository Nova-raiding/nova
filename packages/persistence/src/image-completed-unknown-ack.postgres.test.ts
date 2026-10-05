import { reconcileImageGenerationWorkspace } from '../../../apps/worker/src/main.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresOutboxRepository } from './repository.js'
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

describe('completed image unknown PostgreSQL ACK', () => {
  postgresIt('CAS rejects identity drift and concurrent losers; route guards archive and settlement; ACK/audit commit once', async () => {
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
      const outbox = new PostgresOutboxRepository(app)
      const jobId = `ack-${randomUUID()}`
      const payload = { id:jobId,workspaceId,productId,idempotencyKey:jobId,intentHash:'a'.repeat(64),sourceProductVersion:1,direction:'CAS only fixture',count:1,state:'succeeded',archiveState:'archived',revision:1,outputs:[{ sha256:'fixture-only' }] }
      await business.save({workspaceId,entityType:'image_generation_job',entityId:jobId,entityVersion:1,payload})
      const event = await outbox.append({workspaceId,aggregateId:jobId,eventType:'image.generation.requested',sequence:1,payload:{intent_hash:payload.intentHash}})
      const lease = await repo.claim({workspaceId,jobId,eventId:event.id,leaseMs:60000})
      const owned = {workspaceId,jobId,ownerToken:lease.ownerToken}
      await repo.reserveProviderOperation(owned); await repo.beginProviderDispatch(owned)
      await repo.markProviderStarted({...owned,providerRequestId:'provider-fixture'}); await repo.markCompleted(owned)
      await outbox.markUnknown(workspaceId,event.id,{code:'IMAGE_GENERATION_EXECUTION_LEASE_LOST',message:'fixture',retryable:false,unknown:true})
      const [candidate] = await outbox.listCompletedImageUnknown(workspaceId,10)
      expect(candidate?.id).toBe(event.id)
      const input = {workspaceId,eventId:event.id,jobId,providerRequestId:'provider-fixture',intentHash:payload.intentHash,expectedUnknownAt:candidate!.unknownAt!,expectedAttempt:lease.attempt,expectedJob:payload,expectedEventPayload:event.payload}
      for (const delta of [{workspaceId:otherWorkspaceId},{jobId:'other'},{eventId:'other'},{providerRequestId:'other'},{intentHash:'b'.repeat(64)},{expectedAttempt:999},{expectedUnknownAt:'2000-01-01T00:00:00Z'},{expectedJob:{...payload,revision:2}}]) {
        expect(await outbox.ackCompletedImageUnknown({...input,...delta})).toBe(false)
      }
      await database.query("UPDATE outbox_events SET lease_token='live',lease_until=now()+interval '1 minute' WHERE id=$1",[event.id])
      expect(await outbox.ackCompletedImageUnknown(input)).toBe(false)
      await database.query('UPDATE outbox_events SET lease_token=NULL,lease_until=NULL WHERE id=$1',[event.id])
      await database.query("UPDATE image_generation_executions SET state='outcome_unknown',error_code='FIXTURE',error_message='fixture' WHERE workspace_id=$1 AND job_id=$2",[workspaceId,jobId])
      expect(await outbox.ackCompletedImageUnknown(input)).toBe(false)
      await database.query("UPDATE image_generation_executions SET state='completed',error_code=NULL,error_message=NULL WHERE workspace_id=$1 AND job_id=$2",[workspaceId,jobId])
      // Storage itself forbids payload mutation. The ACK additionally rejects
      // a stale/different authorization snapshot even when intent is unchanged.
      const drift = {action_id:'drifted-action',run_key:'drifted-run',commercial_access_snapshot:{reservation_id:'other-reservation'}}
      await expect(database.query("UPDATE outbox_events SET payload=payload || $2::jsonb WHERE id=$1",[event.id,JSON.stringify(drift)])).rejects.toThrow('outbox event identity and payload are immutable')
      expect(await outbox.ackCompletedImageUnknown({...input,expectedEventPayload:{...event.payload,...drift}})).toBe(false)
      expect((await database.query('SELECT published_at FROM outbox_events WHERE id=$1',[event.id])).rows[0].published_at).toBeNull()
      const archive = vi.fn().mockRejectedValue(new Error('archive digest mismatch'))
      const settlement = vi.fn()
      const context = {req:{method:'POST'},res:{},path:'/v1/internal/image-generation-jobs/reconciliation',
        requireWorkerAuthorization:vi.fn(),headerRequired:()=>workspaceId,hydrateWorkspace:vi.fn(),body:async()=>({limit:10}),
        persistence:{outbox,business,imageGenerationExecutions:repo},service:{hydrateSnapshot:vi.fn()},
        readArchivedGeneratedImages:archive,requireChargedImageDeliveryEvidence:settlement,imageJobOutputsAreClean:()=>true,send:vi.fn()
      } as unknown as InternalRuntimeContext
      await handleInternalRuntimeRoute(context)
      expect(archive).toHaveBeenCalledOnce(); expect(settlement).not.toHaveBeenCalled()
      expect(await outbox.listCompletedImageUnknown(workspaceId,10)).toHaveLength(1)
      archive.mockResolvedValue([]); settlement.mockRejectedValueOnce(new Error('settlement pending'))
      await handleInternalRuntimeRoute(context)
      expect(await outbox.listCompletedImageUnknown(workspaceId,10)).toHaveLength(1)
      // Hold the original row lock while two independent app connections queue
      // their guarded ACKs. Only one may publish and append audit.
      const blocker = await database.connect()
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM outbox_events WHERE id=$1 FOR UPDATE',[event.id])
      const first = outbox.ackCompletedImageUnknown(input); const second = outbox.ackCompletedImageUnknown(input)
      await blocker.query('COMMIT'); blocker.release()
      expect((await Promise.all([first,second])).sort()).toEqual([false,true])
      expect(await outbox.ackCompletedImageUnknown(input)).toBe(false)
      expect(await outbox.listCompletedImageUnknown(workspaceId,10)).toEqual([])
      const audits = (await database.query("SELECT after_json FROM workspace_operation_audit WHERE resource_id=$1 AND action='image.completed_unknown.ack'",[event.id])).rows
      expect(audits).toHaveLength(1)
      expect(audits[0].after_json).toMatchObject({event_id:event.id,job_id:jobId,provider_request_id:'provider-fixture',provider_called:false})
      const final = (await outbox.listAggregateEvents(workspaceId,jobId))[0]!
      expect(final.publishedAt).toBeTruthy(); expect(final.unknownAt).toBeTruthy()
      expect(final.lastError?.code).toBe('IMAGE_GENERATION_EXECUTION_LEASE_LOST')
      // A second synthetic terminal fixture exercises the successful API path
      // with archive and billing adapters resolved; provider is absent entirely.
      const job2 = `${jobId}-route`
      await business.save({workspaceId,entityType:'image_generation_job',entityId:job2,entityVersion:1,payload:{...payload,id:job2,idempotencyKey:job2}})
      const event2 = await outbox.append({workspaceId,aggregateId:job2,eventType:'image.generation.requested',sequence:1,payload:{intent_hash:payload.intentHash}})
      const lease2 = await repo.claim({workspaceId,jobId:job2,eventId:event2.id,leaseMs:60000})
      const owned2 = {workspaceId,jobId:job2,ownerToken:lease2.ownerToken}
      await repo.reserveProviderOperation(owned2); await repo.beginProviderDispatch(owned2)
      await repo.markProviderStarted({...owned2,providerRequestId:'provider-fixture-2'}); await repo.markCompleted(owned2)
      await outbox.markUnknown(workspaceId,event2.id,{code:'IMAGE_GENERATION_EXECUTION_LEASE_LOST',message:'fixture',retryable:false,unknown:true})
      await handleInternalRuntimeRoute(context)
      expect((await outbox.listAggregateEvents(workspaceId,job2))[0]!.publishedAt).toBeTruthy()
      expect(await outbox.listCompletedImageUnknown(otherWorkspaceId,10)).toEqual([])
      // Actual worker + API + PostgreSQL: a bad oldest item must not starve
      // a later verified completion when each page contains only one item.
      const queued: string[] = []
      for (const suffix of ['missing-snapshot','bad-oldest','good-later']) {
        const id = `${jobId}-${suffix}`; queued.push(id)
        await business.save({workspaceId,entityType:'image_generation_job',entityId:id,entityVersion:1,payload:{...payload,id,idempotencyKey:id}})
        const e = await outbox.append({workspaceId,aggregateId:id,eventType:'image.generation.requested',sequence:1,payload:{intent_hash:payload.intentHash}})
        const l = await repo.claim({workspaceId,jobId:id,eventId:e.id,leaseMs:60000})
        const o = {workspaceId,jobId:id,ownerToken:l.ownerToken}
        await repo.reserveProviderOperation(o); await repo.beginProviderDispatch(o)
        await repo.markProviderStarted({...o,providerRequestId:`provider-${suffix}`}); await repo.markCompleted(o)
        await outbox.markUnknown(workspaceId,e.id,{code:'IMAGE_GENERATION_EXECUTION_LEASE_LOST',message:'fixture',retryable:false,unknown:true})
      }
      await database.query("DELETE FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='image_generation_job' AND entity_id=$2",[workspaceId,queued[0]])
      archive.mockImplementation(async (_workspace:string,job:{id:string}) => { if (job.id===queued[1]) throw new Error('missing archive'); return [] })
      const queryStatus = vi.fn()
      const requests: Record<string,unknown>[] = []
      const fetcher: typeof fetch = async (_url,init) => {
        const request = JSON.parse(String(init?.body)); requests.push(request)
        let response: Response | undefined
        await handleInternalRuntimeRoute({...context,body:async()=>request,
          send:(_res:unknown,status:number,_workspace:string,data:unknown)=>{ response=Response.json({data},{status}) }
        } as unknown as InternalRuntimeContext)
        return response!
      }
      const firstSweep = await reconcileImageGenerationWorkspace({apiBaseUrl:'https://fixture.test',apiToken:'fixture',workspaceId,limit:1,maxPages:1,fetcher,queryStatus})
      expect(firstSweep.completed).toBe(false)
      expect((firstSweep.results[0] as {page:unknown}).page).toMatchObject({has_more:true,completion_ack_has_more:true})
      const sweep = await reconcileImageGenerationWorkspace({apiBaseUrl:'https://fixture.test',apiToken:'fixture',workspaceId,limit:1,fetcher,queryStatus,...firstSweep.continuation})
      expect((await outbox.listAggregateEvents(workspaceId,queued[2]!))[0]!.publishedAt).toBeTruthy()
      expect((await outbox.listAggregateEvents(workspaceId,queued[0]!))[0]!.publishedAt).toBeUndefined()
      expect(sweep.completed).toBe(true); expect(requests.length).toBe(3)
      expect(requests[1]?.execution_scan_done).toBe(true)
      expect(requests[1]?.completion_ack_cursor).toBeTruthy()
      expect(queryStatus).not.toHaveBeenCalled()


    } finally {
      await app?.end(); await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  },300_000)
})
