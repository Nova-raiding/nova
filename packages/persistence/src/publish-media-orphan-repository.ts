import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type PublishMediaState = 'intent' | 'uploaded' | 'orphaned' | 'retained' | 'unknown' | 'deleted'
export interface PublishMediaLifecycleInput {
  workspaceId: string; publishJobId: string; eventId: string; mediaIdempotencyKey: string
  platform: string; accountId: string; visualRef: string; role: 'main' | 'secondary'; sha256: string
}
export interface PublishMediaLifecycleRecord extends PublishMediaLifecycleInput {
  id: string; state: PublishMediaState; receipt?: Record<string, unknown>; reason?: string; createdAt: string; updatedAt: string
}
export interface PublishMediaOrphanRepository {
  transition(input: PublishMediaLifecycleInput & { state: PublishMediaState; receipt?: Record<string, unknown>; reason?: string }): Promise<PublishMediaLifecycleRecord>
  getByKey(workspaceId: string, publishJobId: string, mediaIdempotencyKey: string): Promise<PublishMediaLifecycleRecord | undefined>
}
const safe = (value: string, code: string) => { if (!value?.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code); return value }
function validate(input: PublishMediaLifecycleInput) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  for (const [value, code] of [[input.publishJobId,'PUBLISH_JOB_REQUIRED'],[input.eventId,'PUBLISH_EVENT_REQUIRED'],[input.mediaIdempotencyKey,'MEDIA_KEY_REQUIRED'],[input.platform,'PLATFORM_REQUIRED'],[input.accountId,'ACCOUNT_REQUIRED'],[input.visualRef,'VISUAL_REF_REQUIRED']] as const) safe(value, code)
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error('MEDIA_SHA256_INVALID')
  return { ...input, workspaceId }
}
type Row = { id:string; workspace_id:string; publish_job_id:string; event_id:string; media_idempotency_key:string; platform:string; account_id:string; visual_ref:string; role:'main'|'secondary'; sha256:string; state:PublishMediaState; receipt:Record<string,unknown>|null; reason:string|null; created_at:string|Date; updated_at:string|Date }
const projection='id,workspace_id,publish_job_id,event_id,media_idempotency_key,platform,account_id,visual_ref,role,sha256,state,receipt,reason,created_at,updated_at'
const iso=(x:string|Date)=>x instanceof Date?x.toISOString():String(x)
const map=(r:Row):PublishMediaLifecycleRecord=>({id:r.id,workspaceId:r.workspace_id,publishJobId:r.publish_job_id,eventId:r.event_id,mediaIdempotencyKey:r.media_idempotency_key,platform:r.platform,accountId:r.account_id,visualRef:r.visual_ref,role:r.role,sha256:r.sha256,state:r.state,...(r.receipt?{receipt:r.receipt}:{}),...(r.reason?{reason:r.reason}:{}),createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)})
const allowed:Record<PublishMediaState,PublishMediaState[]>={intent:['uploaded','unknown'],uploaded:['uploaded','orphaned','retained','unknown','deleted'],orphaned:['orphaned','deleted'],retained:['retained'],unknown:['unknown','uploaded','orphaned','retained'],deleted:['deleted']}
export class PublishMediaLifecycleConflictError extends Error { constructor(){super('PUBLISH_MEDIA_LIFECYCLE_CONFLICT');this.name='PublishMediaLifecycleConflictError'} }
export class PostgresPublishMediaOrphanRepository implements PublishMediaOrphanRepository {
  constructor(private readonly pool:SqlPool){}
  async transition(raw:PublishMediaLifecycleInput & {state:PublishMediaState;receipt?:Record<string,unknown>;reason?:string}) {
    const input=validate(raw)
    return withWorkspaceTransaction(this.pool,input.workspaceId,async client=>{
      await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('publish_media_orphan_v1'),pg_catalog.hashtext($1))",[`${input.workspaceId}/${input.publishJobId}/${input.mediaIdempotencyKey}`])
      const found=await client.query<Row>(`SELECT ${projection} FROM publish_media_orphan_tasks WHERE workspace_id=$1 AND publish_job_id=$2 AND media_idempotency_key=$3 FOR UPDATE`,[input.workspaceId,input.publishJobId,input.mediaIdempotencyKey])
      const current=found.rows[0]
      if(current && (current.event_id!==input.eventId||current.platform!==input.platform||current.account_id!==input.accountId||current.visual_ref!==input.visualRef||current.role!==input.role||current.sha256!==input.sha256)) throw new PublishMediaLifecycleConflictError()
      if(raw.state==='deleted') {
        const confirmedReplay=current?.state==='deleted'&&current.reason==='discard_adapter_confirmed_delete'&&current.receipt&&raw.receipt&&isDeepStrictEqual(current.receipt,raw.receipt)&&raw.reason===current.reason
        const confirmedDelete=current&&['uploaded','orphaned'].includes(current.state)&&current.receipt&&raw.receipt&&isDeepStrictEqual(current.receipt,raw.receipt)&&raw.reason==='discard_adapter_confirmed_delete'
        if(!confirmedReplay&&!confirmedDelete) throw new PublishMediaLifecycleConflictError()
      }
      if(current && !allowed[current.state].includes(raw.state)) throw new PublishMediaLifecycleConflictError()
      if(current?.state==='uploaded' && raw.state==='uploaded' && raw.receipt && current.receipt && !isDeepStrictEqual(current.receipt,raw.receipt)) throw new PublishMediaLifecycleConflictError()
      const id=current?.id??`pmo_${randomUUID()}`
      const row=current
        ? await client.query<Row>(`UPDATE publish_media_orphan_tasks SET state=$1,receipt=COALESCE($2::jsonb,receipt),reason=$3,updated_at=now() WHERE id=$4 RETURNING ${projection}`,[raw.state,raw.receipt?JSON.stringify(raw.receipt):null,raw.reason??null,current.id])
        : await client.query<Row>(`INSERT INTO publish_media_orphan_tasks(id,workspace_id,publish_job_id,event_id,media_idempotency_key,platform,account_id,visual_ref,role,sha256,state,receipt,reason)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING ${projection}`,[id,input.workspaceId,input.publishJobId,input.eventId,input.mediaIdempotencyKey,input.platform,input.accountId,input.visualRef,input.role,input.sha256,raw.state,raw.receipt?JSON.stringify(raw.receipt):null,raw.reason??null])
      const result=row.rows[0]!
      await client.query(`INSERT INTO publish_media_orphan_events(id,workspace_id,task_id,state,detail) VALUES($1,$2,$3,$4,$5::jsonb)`,[`pmoe_${randomUUID()}`,input.workspaceId,result.id,raw.state,JSON.stringify({reason:raw.reason??null,hasReceipt:Boolean(raw.receipt)})])
      return map(result)
    })
  }
  async getByKey(workspaceId:string,publishJobId:string,key:string){const scope=requireWorkspaceScope(workspaceId);return withWorkspaceTransaction(this.pool,scope,async c=>{const r=await c.query<Row>(`SELECT ${projection} FROM publish_media_orphan_tasks WHERE workspace_id=$1 AND publish_job_id=$2 AND media_idempotency_key=$3`,[scope,publishJobId,key]);return r.rows[0]?map(r.rows[0]):undefined})}
}
export class MemoryPublishMediaOrphanRepository implements PublishMediaOrphanRepository {
  private rows=new Map<string,PublishMediaLifecycleRecord>();
  async transition(raw:PublishMediaLifecycleInput & {state:PublishMediaState;receipt?:Record<string,unknown>;reason?:string}) {const i=validate(raw),key=`${i.workspaceId}/${i.publishJobId}/${i.mediaIdempotencyKey}`,old=this.rows.get(key);if(raw.state==='deleted'){const confirmedReplay=old?.state==='deleted'&&old.reason==='discard_adapter_confirmed_delete'&&Boolean(old.receipt&&raw.receipt&&isDeepStrictEqual(old.receipt,raw.receipt)&&raw.reason===old.reason);const confirmedDelete=Boolean(old&&['uploaded','orphaned'].includes(old.state)&&old.receipt&&raw.receipt&&isDeepStrictEqual(old.receipt,raw.receipt)&&raw.reason==='discard_adapter_confirmed_delete');if(!confirmedReplay&&!confirmedDelete)throw new PublishMediaLifecycleConflictError()}if(old&&(old.eventId!==i.eventId||old.platform!==i.platform||old.accountId!==i.accountId||old.visualRef!==i.visualRef||old.role!==i.role||old.sha256!==i.sha256||!allowed[old.state].includes(raw.state)||(old.state==='uploaded'&&raw.state==='uploaded'&&raw.receipt&&old.receipt&&!isDeepStrictEqual(old.receipt,raw.receipt))))throw new PublishMediaLifecycleConflictError();const now=new Date().toISOString(),r:PublishMediaLifecycleRecord={...(old??{} as PublishMediaLifecycleRecord),...i,id:old?.id??`pmo_${randomUUID()}`,state:raw.state,...(raw.receipt?{receipt:structuredClone(raw.receipt)}:{}),...(raw.reason?{reason:raw.reason}:{}),createdAt:old?.createdAt??now,updatedAt:now};this.rows.set(key,r);return structuredClone(r)}
  async getByKey(workspaceId:string,publishJobId:string,key:string){const r=this.rows.get(`${requireWorkspaceScope(workspaceId)}/${publishJobId}/${key}`);return r?structuredClone(r):undefined}
}
