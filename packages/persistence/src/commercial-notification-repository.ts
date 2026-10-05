import { createHash, randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'
export type CommercialNotificationErrorCode = 'COMMERCIAL_NOTIFICATION_READ_INPUT_INVALID' | 'COMMERCIAL_NOTIFICATION_MEMBERSHIP_REQUIRED' | 'COMMERCIAL_NOTIFICATION_NOT_VISIBLE' | 'COMMERCIAL_NOTIFICATION_IDEMPOTENCY_CONFLICT' | 'COMMERCIAL_NOTIFICATION_READ_RESULT_UNKNOWN' | 'COMMERCIAL_NOTIFICATION_STORAGE_UNAVAILABLE' | 'COMMERCIAL_NOTIFICATION_REDRIVE_INPUT_INVALID' | 'COMMERCIAL_NOTIFICATION_REDRIVE_NOT_FOUND' | 'COMMERCIAL_NOTIFICATION_REDRIVE_NOT_EXHAUSTED'
export class CommercialNotificationError extends Error {
  constructor(public readonly code: CommercialNotificationErrorCode, public readonly status: 400 | 403 | 404 | 409 | 503) { super(code); this.name = 'CommercialNotificationError' }
}
export interface CommercialNotificationLease { eventId: string; token: string }
export interface CommercialNotificationBatch { scanned: number; delivered: number; complete: boolean }

export interface CommercialNotificationRecipient { workspaceId: string; memberId: string; identityId: string | null; role: string }
export interface CommercialNotificationPublication {
  eventId: string; skuCode: string; version: number; visibility: 'public' | 'private'; payload: Record<string, unknown>; publishedAt: string
}
/** Local authorization only; never perform network work while holding this transaction. */
export type CommercialNotificationAuthorizer = (recipient: CommercialNotificationRecipient, publication: CommercialNotificationPublication) => boolean
export type CommercialPurchaseResultState = 'active' | 'scheduled' | 'awaiting_dependency' | 'reconciliation_required'
export interface CommercialNotificationItem {
  notification_kind: 'catalog_publication' | 'purchase_result'; read_at: string | null; order_id?: string; result_state?: CommercialPurchaseResultState;
  id: string; event_id: string; sku_code: string; version: number; title: string; body: string; published_at: string; payload: Record<string, unknown>
}
export interface CommercialNotificationCursor { published_at: string; event_id: string }
export interface CommercialNotificationPage { items: CommercialNotificationItem[]; next_cursor: CommercialNotificationCursor | null }
interface PublicationRow { notification_kind?: 'catalog_publication' | 'purchase_result'; notification_key?: string; notification_id?: string; read_at?: Date | string | null; order_id?: string; result_state?: CommercialPurchaseResultState; beneficiary_member_id?: string | null; event_id: string; sku_code: string; version: number; visibility: 'public' | 'private'; payload: Record<string, unknown>; created_at: Date | string; cursor_member_id: string; audience_workspace_id: string | null }
interface MemberRow { id: string; workspace_id: string; identity_id: string | null; role: string }
export interface CommercialPurchaseResultSource {
 source_event_id: string; event_type: string; order_id: string; beneficiary_member_id?: string | null; created_at: string | Date;
 event_payload: Record<string, unknown>; sku: Record<string, unknown>; amount_fen: number | string; payment_fact_present: boolean;
}
const resultLabels: Record<CommercialPurchaseResultState, string> = { active: '立即生效', scheduled: '未来待生效', awaiting_dependency: '待依赖', reconciliation_required: '已收款待处置' }
export function deriveCommercialPurchaseResultNotification(source: CommercialPurchaseResultSource) {
 const state = source.event_payload.grant_status as CommercialPurchaseResultState
 const paidAt = source.event_payload.paid_at
 const verifiedAt = source.event_payload.verified_at
 const version = Number(source.sku.version)
 const amountFen = Number(source.amount_fen)
 if (!Object.hasOwn(resultLabels, state) || source.event_type !== `commercial.payment.${state}` || source.event_payload.order_id !== source.order_id || !source.payment_fact_present || typeof paidAt !== 'string' || !Number.isFinite(Date.parse(paidAt)) || typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt)) || typeof source.sku.code !== 'string' || !source.sku.code || !Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(amountFen) || amountFen <= 0 || !['public','private'].includes(String(source.sku.visibility)) || !['onboarding','monthly','point_pack','private_trial'].includes(String(source.sku.kind))) throw new Error('COMMERCIAL_RESULT_NOTIFICATION_EVIDENCE_INVALID')
 const skuPayload = source.sku.payload && typeof source.sku.payload === 'object' ? source.sku.payload as Record<string, unknown> : {}
 const label = source.sku.kind === 'onboarding' ? '账户开通' : source.sku.kind === 'point_pack' ? '权益包购买' : '套餐购买'
 return { state, skuCode: source.sku.code, version, visibility: source.sku.visibility as 'public'|'private', payload: {
   notification_kind: 'purchase_result', title: `${label}核验结果：${resultLabels[state]}`,
   body: state === 'awaiting_dependency' ? '该笔已收款，权益仍等待开通款等依赖；请查看订单明细，勿重复付款。' : state === 'reconciliation_required' ? '已确认收款，但尚不能按原意图授予；请查看订单处置入口，勿重复付款。' : state === 'scheduled' ? '该笔已核验，合同按已购有效期未来生效；当前不会提前发放可消耗权益。' : '该笔核验事务已完成权益授予；当前有效期、额度及后续变更请查看已购明细。',
   name: typeof skuPayload.name === 'string' ? skuPayload.name : source.sku.code,
   sku_kind: source.sku.kind, order_id: source.order_id, grant_status: state,
   amount_fen: amountFen, currency: 'CNY', paid_at: paidAt, verified_at: verifiedAt,
   ...(typeof source.event_payload.grant_id === 'string' ? { grant_id: source.event_payload.grant_id } : {}),
   ...(typeof source.sku.requiredCapability === 'string' ? { required_capability: source.sku.requiredCapability } : {}),
 } }
}
const commercialNotificationFeed = `SELECT n.event_id::text AS event_id,n.sku_code,n.version,n.visibility,n.payload,n.published_at AS created_at,'catalog_publication'::text AS notification_kind,'publication:'||n.event_id::text AS notification_key,n.event_id::text||':'||n.member_id::text AS notification_id,NULL::text AS order_id,NULL::text AS result_state FROM workspace_commercial_notifications n WHERE n.workspace_id=$1 AND n.member_id=$2
 UNION ALL SELECT n.source_event_id AS event_id,n.sku_code,n.version,n.visibility,n.payload,n.published_at AS created_at,'purchase_result'::text AS notification_kind,'result:'||n.source_event_id AS notification_key,'result:'||n.source_event_id||':'||n.member_id::text AS notification_id,n.order_id,n.result_state FROM workspace_commercial_result_notifications n WHERE n.workspace_id=$1 AND n.member_id=$2`
const iso = (value: Date | string) => new Date(value).toISOString()
const merchantReadRoles = new Set(['workspace_owner','merchant_admin','workspace_admin','operator','merchant_operator','support','finance'])
const publicOnly: CommercialNotificationAuthorizer = (recipient, publication) => merchantReadRoles.has(recipient.role) && publication.visibility === 'public'
function pageLimit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('COMMERCIAL_NOTIFICATION_LIMIT_INVALID')
  return Math.min(value, max)
}
function publication(row: PublicationRow): CommercialNotificationPublication {
  return { eventId: row.event_id, skuCode: row.sku_code, version: row.version, visibility: row.visibility, payload: row.payload, publishedAt: iso(row.created_at) }
}
function recipient(row: MemberRow): CommercialNotificationRecipient {
  return { workspaceId: row.workspace_id, memberId: row.id, identityId: row.identity_id, role: row.role }
}
export class PostgresCommercialNotificationRepository {
  constructor(private readonly pool: SqlPool, private readonly authorize: CommercialNotificationAuthorizer = publicOnly) {}
  private async transaction<T>(run: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release?.() }
  }
  async claim(leaseSeconds = 60): Promise<CommercialNotificationLease | undefined> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error('COMMERCIAL_NOTIFICATION_LEASE_INVALID')
    return this.transaction(async client => {
      const token = randomUUID()
      const result = await client.query<{ event_id: string }>(`UPDATE commercial_catalog_publish_outbox SET lease_token=$1, lease_until=clock_timestamp()+make_interval(secs=>$2), attempts=attempts+1 WHERE event_id=(SELECT event_id FROM commercial_catalog_publish_outbox WHERE completed_at IS NULL AND attempts<8 AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING event_id`, [token, leaseSeconds])
      return result.rows[0] ? { eventId: result.rows[0].event_id, token } : undefined
    })
  }
  async fanout(lease: CommercialNotificationLease, limit = 200): Promise<CommercialNotificationBatch> {
    limit = pageLimit(limit, 200)
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.platform_scope','platform_ops',true)`)
      const events = await client.query<PublicationRow>(`SELECT * FROM commercial_catalog_publish_outbox WHERE event_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND completed_at IS NULL FOR UPDATE`, [lease.eventId, lease.token])
      const event = events.rows[0]
      if (!event) throw new Error('COMMERCIAL_NOTIFICATION_LEASE_LOST')
      const page = await client.query<MemberRow>(`SELECT m.id,m.workspace_id,m.identity_id,m.role FROM workspace_members m LEFT JOIN platform_identities i ON i.id=m.identity_id WHERE m.id::text>$1 AND m.created_at<=$2 AND m.status='active' AND (m.identity_id IS NULL OR i.access_status='active') AND ($3::text IS NULL OR m.workspace_id=$3) ORDER BY m.id::text LIMIT $4`, [event.cursor_member_id, event.created_at, event.audience_workspace_id, limit])
      let delivered = 0
      const snapshot = publication(event)
      for (const member of page.rows) {
        if (!this.authorize(recipient(member), snapshot)) continue
        await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [member.workspace_id])
        // Recheck the membership at the insertion boundary. Unique event/member
        // makes crash replay and repeated scheduling harmless.
        const inserted = await client.query(`INSERT INTO workspace_commercial_notifications(workspace_id,member_id,event_id,sku_code,version,visibility,payload,published_at) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8 FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active' ON CONFLICT(event_id,member_id) DO NOTHING`, [member.workspace_id, member.id, event.event_id, event.sku_code, event.version, event.visibility, JSON.stringify(event.payload), event.created_at])
        delivered += inserted.rowCount ?? inserted.rows.length
      }
      const complete = page.rows.length < limit
      await client.query(`UPDATE commercial_catalog_publish_outbox SET cursor_member_id=$3,completed_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,attempts=0,lease_token=NULL,lease_until=NULL WHERE event_id=$1 AND lease_token=$2`, [lease.eventId, lease.token, page.rows.at(-1)?.id ?? event.cursor_member_id, complete])
      return { scanned: page.rows.length, delivered, complete }
    })
  }
  /** Derive delivery work only from an already committed payment/outbox fact.
   * No new money, qualification or entitlement is written here. */
  async seedPurchaseResults(workspaceId: string, limit = 200): Promise<number> {
    limit = pageLimit(limit, 200)
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
      const result = await client.query<CommercialPurchaseResultSource>(`SELECT e.id AS source_event_id,e.event_type,e.aggregate_id AS order_id,e.created_at,e.payload AS event_payload,s.snapshot->'sku' AS sku,o.amount_fen,
        public.merchant_commercial_order_beneficiary(e.aggregate_id) AS beneficiary_member_id,
        EXISTS(SELECT 1 FROM commercial_payment_events_v2 p WHERE p.workspace_id=e.workspace_id AND p.order_id=e.aggregate_id AND p.provider_event_id=e.payload->>'payment_event_id' AND p.verified AND p.event_type='paid' AND p.amount_fen=o.amount_fen AND p.currency=o.currency) AS payment_fact_present
        FROM outbox_events e JOIN commercial_orders_v2 o ON o.workspace_id=e.workspace_id AND o.id=e.aggregate_id JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
        WHERE e.workspace_id=$1 AND e.event_type IN ('commercial.payment.active','commercial.payment.scheduled','commercial.payment.awaiting_dependency','commercial.payment.reconciliation_required')
        AND NOT EXISTS(SELECT 1 FROM commercial_purchase_result_notification_outbox n WHERE n.workspace_id=e.workspace_id AND n.source_event_id=e.id)
        ORDER BY e.created_at,e.id LIMIT $2`, [workspaceId, limit])
      let seeded = 0
      for (const source of result.rows) {
        const projected = deriveCommercialPurchaseResultNotification(source)
        const inserted = await client.query(`INSERT INTO commercial_purchase_result_notification_outbox(workspace_id,source_event_id,order_id,result_state,sku_code,version,visibility,payload,created_at,beneficiary_member_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT(workspace_id,source_event_id) DO NOTHING`, [workspaceId, source.source_event_id, source.order_id, projected.state, projected.skuCode, projected.version, projected.visibility, JSON.stringify(projected.payload), source.created_at, source.beneficiary_member_id ?? null])
        seeded += inserted.rowCount ?? 0
      }
      return seeded
    })
  }
  async claimPurchaseResult(workspaceId: string, leaseSeconds = 60): Promise<CommercialNotificationLease | undefined> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error('COMMERCIAL_NOTIFICATION_LEASE_INVALID')
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
      const token = randomUUID()
      const result = await client.query<{ source_event_id: string }>(`UPDATE commercial_purchase_result_notification_outbox SET lease_token=$2,lease_until=clock_timestamp()+make_interval(secs=>$3),attempts=attempts+1 WHERE workspace_id=$1 AND source_event_id=(SELECT source_event_id FROM commercial_purchase_result_notification_outbox WHERE workspace_id=$1 AND completed_at IS NULL AND attempts<8 AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at,source_event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING source_event_id`, [workspaceId, token, leaseSeconds])
      return result.rows[0] ? { eventId: result.rows[0].source_event_id, token } : undefined
    })
  }
  async fanoutPurchaseResult(workspaceId: string, lease: CommercialNotificationLease, limit = 200): Promise<CommercialNotificationBatch> {
    limit = pageLimit(limit, 200)
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
      await client.query(`SELECT set_config('app.platform_scope','platform_ops',true)`)
      const result = await client.query<PublicationRow>(`SELECT source_event_id AS event_id,sku_code,version,visibility,payload,created_at,cursor_member_id,order_id,result_state,beneficiary_member_id FROM commercial_purchase_result_notification_outbox WHERE workspace_id=$1 AND source_event_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND completed_at IS NULL FOR UPDATE`, [workspaceId, lease.eventId, lease.token])
      const event = result.rows[0]
      if (!event) throw new Error('COMMERCIAL_NOTIFICATION_LEASE_LOST')
      const members = event.beneficiary_member_id
        ? await client.query<MemberRow>(`SELECT m.id,m.workspace_id,m.identity_id,m.role FROM workspace_members m LEFT JOIN platform_identities i ON i.id=m.identity_id WHERE m.workspace_id=$1 AND m.id=$2 AND m.created_at<=$3 AND m.status='active' AND (m.identity_id IS NULL OR i.access_status='active') ORDER BY m.id::text LIMIT $4`, [workspaceId, event.beneficiary_member_id, event.created_at, limit])
        : await client.query<MemberRow>(`SELECT m.id,m.workspace_id,m.identity_id,m.role FROM workspace_members m LEFT JOIN platform_identities i ON i.id=m.identity_id WHERE m.workspace_id=$1 AND m.id::text>$2 AND m.created_at<=$3 AND m.status='active' AND (m.identity_id IS NULL OR i.access_status='active') ORDER BY m.id::text LIMIT $4`, [workspaceId, event.cursor_member_id, event.created_at, limit])
      let delivered = 0
      for (const member of members.rows) {
        if (!this.authorize(recipient(member), publication(event))) continue
        const inserted = await client.query(`INSERT INTO workspace_commercial_result_notifications(workspace_id,member_id,source_event_id,order_id,result_state,sku_code,version,visibility,payload,published_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10 FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active' ON CONFLICT(workspace_id,member_id,source_event_id) DO NOTHING`, [workspaceId,member.id,event.event_id,event.order_id,event.result_state,event.sku_code,event.version,event.visibility,JSON.stringify(event.payload),event.created_at])
        delivered += inserted.rowCount ?? 0
      }
      const complete = Boolean(event.beneficiary_member_id) || members.rows.length < limit
      await client.query(`UPDATE commercial_purchase_result_notification_outbox SET cursor_member_id=$4,completed_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,attempts=0,lease_token=NULL,lease_until=NULL WHERE workspace_id=$1 AND source_event_id=$2 AND lease_token=$3`, [workspaceId,lease.eventId,lease.token,members.rows.at(-1)?.id ?? event.cursor_member_id,complete])
      return { scanned: members.rows.length, delivered, complete }
    })
  }
  /** Operations-only tenant scope. Lease tokens and commercial payloads are never exposed. */
  async getPurchaseResultBacklog(workspaceId: string, options: { limit?: number; cursor?: { createdAt: string; eventId: string } } = {}) {
    const limit = pageLimit(options.limit ?? 50, 200)
    if (!workspaceId.trim() || (options.cursor && (!Number.isFinite(Date.parse(options.cursor.createdAt)) || !options.cursor.eventId))) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_REDRIVE_INPUT_INVALID', 400)
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
      const summary = (await client.query<{ pending: number; failed: number; exhausted: number; leased: number }>(`SELECT count(*)::int AS pending,count(*) FILTER(WHERE attempts>0 AND (lease_until IS NULL OR lease_until<=clock_timestamp()))::int AS failed,count(*) FILTER(WHERE attempts>=8 AND (lease_until IS NULL OR lease_until<=clock_timestamp()))::int AS exhausted,count(*) FILTER(WHERE lease_until>clock_timestamp())::int AS leased FROM commercial_purchase_result_notification_outbox WHERE workspace_id=$1 AND completed_at IS NULL`, [workspaceId])).rows[0]!
      const rows = (await client.query<{ source_event_id: string; order_id: string; attempts: number; cursor_member_id: string; created_at: Date|string; status: 'pending'|'failed'|'exhausted'|'leased' }>(`SELECT source_event_id,order_id,attempts,cursor_member_id,created_at,CASE WHEN lease_until>clock_timestamp() THEN 'leased' WHEN attempts>=8 THEN 'exhausted' WHEN attempts>0 THEN 'failed' ELSE 'pending' END AS status FROM commercial_purchase_result_notification_outbox WHERE workspace_id=$1 AND completed_at IS NULL AND ($2::timestamptz IS NULL OR (created_at,source_event_id)>($2::timestamptz,$3::text)) ORDER BY created_at,source_event_id LIMIT $4`, [workspaceId,options.cursor?.createdAt ?? null,options.cursor?.eventId ?? null,limit+1])).rows
      const items = rows.slice(0,limit).map(row=>({eventId:row.source_event_id,orderId:row.order_id,attempts:row.attempts,cursorMemberId:row.cursor_member_id,createdAt:iso(row.created_at),status:row.status}))
      const last=items.at(-1)
      return { ...summary, items, nextCursor: rows.length>limit && last ? {createdAt:last.createdAt,eventId:last.eventId} : null }
    })
  }
  /** Server-only controlled retry. Caller must authorize an Ops mutation first.
   * One durable command permits one bounded page; it never resets progress or
   * attempts. The lease is NOT an API DTO and must not be returned to clients. */
  async claimPurchaseResultRedrive(workspaceId: string, input: { eventId: string; actorId: string; reason: string; idempotencyKey: string }): Promise<{ eventId: string; auditId: string; attempts: number; replayed: boolean; lease?: CommercialNotificationLease }> {
    if (!workspaceId.trim() || !input.eventId?.trim() || input.eventId.length>200 || !input.actorId?.trim() || !input.reason?.trim() || input.reason.length>2000 || !input.idempotencyKey || input.idempotencyKey.length<8 || input.idempotencyKey.length>128) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_REDRIVE_INPUT_INVALID',400)
    const hash=createHash('sha256').update(JSON.stringify(['commercial.notification.purchase_result.redrive',workspaceId,input.idempotencyKey])).digest('hex')
    const auditId=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`,[workspaceId])
      await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`,['commercial_notification_redrive',workspaceId+':'+input.idempotencyKey])
      const prior=(await client.query<{ resource_id:string; actor_id:string; reason:string; after_json:{attempts:number} }>(`SELECT resource_id,actor_id,reason,after_json FROM workspace_operation_audit WHERE workspace_id=$1 AND id=$2 AND action='commercial.notification.purchase_result.redrive'`,[workspaceId,auditId])).rows[0]
      if(prior){
        if(prior.resource_id!==input.eventId || prior.actor_id!==input.actorId || prior.reason!==input.reason) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_IDEMPOTENCY_CONFLICT',409)
        return {eventId:input.eventId,auditId,attempts:prior.after_json.attempts,replayed:true}
      }
      const row=(await client.query<{attempts:number; cursor_member_id:string; completed_at:Date|string|null; live_lease:boolean}>(`SELECT attempts,cursor_member_id,completed_at,coalesce(lease_until>clock_timestamp(),false) AS live_lease FROM commercial_purchase_result_notification_outbox WHERE workspace_id=$1 AND source_event_id=$2 FOR UPDATE`,[workspaceId,input.eventId])).rows[0]
      if(!row) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_REDRIVE_NOT_FOUND',404)
      if(row.completed_at || row.live_lease || row.attempts<8) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_REDRIVE_NOT_EXHAUSTED',409)
      const token=randomUUID(),attempts=row.attempts+1
      await client.query(`UPDATE commercial_purchase_result_notification_outbox SET attempts=attempts+1,lease_token=$3,lease_until=clock_timestamp()+make_interval(secs=>60) WHERE workspace_id=$1 AND source_event_id=$2`,[workspaceId,input.eventId,token])
      await client.query(`INSERT INTO workspace_operation_audit(id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason) VALUES($1,$2,$3,'commercial.notification.purchase_result.redrive','commercial_purchase_result_notification',$4,$5::jsonb,$6::jsonb,$7)`,[auditId,workspaceId,input.actorId,input.eventId,JSON.stringify({attempts:row.attempts,cursor_member_id:row.cursor_member_id,status:'exhausted'}),JSON.stringify({attempts,cursor_member_id:row.cursor_member_id,status:'retry_leased',idempotency_key:input.idempotencyKey}),input.reason])
      return {eventId:input.eventId,auditId,attempts,replayed:false,lease:{eventId:input.eventId,token}}
    })
  }
  async markRead(workspaceId: string, memberId: string, input: { notificationId: string; idempotencyKey: string }): Promise<{ notification_id: string; read_at: string; replayed: boolean }> {
    if (typeof input.notificationId !== 'string' || !input.notificationId || input.notificationId.length > 400 || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_READ_INPUT_INVALID', 400)
    try { return await this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true),set_config('app.member_id',$2,true)`, [workspaceId,memberId])
      await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`, ['commercial_notification_reads',`${workspaceId}:${memberId}`])
      const member = (await client.query<MemberRow>(`SELECT id,workspace_id,identity_id,role FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active'`, [workspaceId,memberId])).rows[0]
      if (!member) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_MEMBERSHIP_REQUIRED', 403)
      const visible = (await client.query<PublicationRow>(`SELECT * FROM (${commercialNotificationFeed}) f WHERE notification_id=$3`, [workspaceId,memberId,input.notificationId])).rows[0]
      if (!visible || !this.authorize(recipient(member),publication(visible))) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_NOT_VISIBLE', 404)
      const request = (await client.query<{ notification_id: string; read_at: Date|string }>(`SELECT notification_id,read_at FROM workspace_commercial_notification_read_requests WHERE workspace_id=$1 AND member_id=$2 AND idempotency_key=$3`, [workspaceId,memberId,input.idempotencyKey])).rows[0]
      if (request) {
        if (request.notification_id !== input.notificationId) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_IDEMPOTENCY_CONFLICT', 409)
        return { notification_id: request.notification_id, read_at: iso(request.read_at), replayed: true }
      }
      const inserted = await client.query<{ read_at: Date|string }>(`INSERT INTO workspace_commercial_notification_reads(workspace_id,member_id,notification_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,member_id,notification_id) DO NOTHING RETURNING read_at`, [workspaceId,memberId,input.notificationId])
      const existing = inserted.rows[0] ?? (await client.query<{ read_at: Date|string }>(`SELECT read_at FROM workspace_commercial_notification_reads WHERE workspace_id=$1 AND member_id=$2 AND notification_id=$3`, [workspaceId,memberId,input.notificationId])).rows[0]
      if (!existing) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_READ_RESULT_UNKNOWN', 503)
      await client.query(`INSERT INTO workspace_commercial_notification_read_requests(workspace_id,member_id,idempotency_key,notification_id,read_at) VALUES($1,$2,$3,$4,$5)`, [workspaceId,memberId,input.idempotencyKey,input.notificationId,existing.read_at])
      return { notification_id: input.notificationId, read_at: iso(existing.read_at), replayed: !inserted.rows[0] }
    }) } catch (error) {
      if (error instanceof CommercialNotificationError) throw error
      throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_STORAGE_UNAVAILABLE', 503)
    }
  }
  async backlog(): Promise<{ pending: number; exhausted: number; oldestPublishedAt: string | null }> {
    return this.transaction(async client => {
      const result = await client.query<{ pending: number; exhausted: number; oldest: Date | string | null }>(`SELECT count(*)::int AS pending,count(*) FILTER(WHERE attempts>=8)::int AS exhausted,min(created_at) AS oldest FROM commercial_catalog_publish_outbox WHERE completed_at IS NULL`)
      const row = result.rows[0]!
      return { pending: row.pending, exhausted: row.exhausted, oldestPublishedAt: row.oldest ? iso(row.oldest) : null }
    })
  }
  async list(workspaceId: string, memberId: string, options: { limit?: number; cursor?: CommercialNotificationCursor } = {}): Promise<CommercialNotificationPage> {
    const limit = pageLimit(options.limit ?? 50, 100)
    if (options.cursor && (!Number.isFinite(Date.parse(options.cursor.published_at)) || !/^(?:publication:|result:)?[a-z0-9_:-]{1,200}$/i.test(options.cursor.event_id))) throw new Error('COMMERCIAL_NOTIFICATION_CURSOR_INVALID')
    return this.transaction(async client => {
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
      await client.query(`SELECT set_config('app.member_id',$1,true)`, [memberId])
      const members = await client.query<MemberRow>(`SELECT id,workspace_id,identity_id,role FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active'`, [workspaceId, memberId])
      const member = members.rows[0]
      if (!member) throw new CommercialNotificationError('COMMERCIAL_NOTIFICATION_MEMBERSHIP_REQUIRED', 403)
      const cursorKey = options.cursor ? (/^[0-9a-f-]{36}$/i.test(options.cursor.event_id) ? `publication:${options.cursor.event_id}` : options.cursor.event_id) : null
      const result = await client.query<PublicationRow>(`SELECT f.*,r.read_at FROM (${commercialNotificationFeed}) f LEFT JOIN workspace_commercial_notification_reads r ON r.workspace_id=$1 AND r.member_id=$2 AND r.notification_id=f.notification_id WHERE ($3::timestamptz IS NULL OR (f.created_at,f.notification_key)<($3::timestamptz,$4::text)) ORDER BY f.created_at DESC,f.notification_key DESC LIMIT $5`, [workspaceId, memberId, options.cursor?.published_at ?? null, cursorKey, limit + 1])
      const scanned = result.rows.slice(0, limit)
      const items = scanned.filter(row => this.authorize(recipient(member), publication(row))).map(row => ({
        notification_kind: row.notification_kind ?? 'catalog_publication', read_at: row.read_at ? iso(row.read_at) : null,
        ...(row.order_id ? { order_id: row.order_id } : {}), ...(row.result_state ? { result_state: row.result_state } : {}),
        id: row.notification_id ?? `${row.event_id}:${memberId}`, event_id: row.event_id, sku_code: row.sku_code, version: row.version,
        title: row.notification_kind === 'purchase_result' && typeof row.payload.title === 'string' ? row.payload.title : `${typeof row.payload.name === 'string' ? row.payload.name : row.sku_code}已上架`,
        body: row.notification_kind === 'purchase_result' && typeof row.payload.body === 'string' ? row.payload.body : '查看当前价格、周期与权益，确认后购买。', published_at: iso(row.created_at), payload: row.payload,
      }))
      const last = scanned.at(-1)
      return { items, next_cursor: result.rows.length > limit && last ? { published_at: iso(last.created_at), event_id: last.notification_key ?? `publication:${last.event_id}` } : null }
    })
  }
}
