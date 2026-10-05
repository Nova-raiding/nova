import { describe, expect, it } from 'vitest'
import { PostgresCommercialNotificationRepository } from './commercial-notification-repository.js'
import type { SqlPool, SqlClient } from './repository.js'
const event = { event_id: '11111111-1111-4111-8111-111111111111', sku_code: 'basic', version: 3, visibility: 'public', payload: { name: '基础版', price_fen: 200000 }, created_at: '2026-10-05T00:00:00Z', cursor_member_id: '', audience_workspace_id: null }
function fixture(replies: unknown[][], failAt?: number) {
  const calls: { sql: string; values?: readonly unknown[] }[] = []
  let index = 0
  const client: SqlClient = { async query<Row>(sql: string, values?: readonly unknown[]) {
    calls.push({ sql, values }); if (calls.length === failAt) throw new Error('database interrupted')
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('set_config')) return { rows: [] }
    const rows = (replies[index++] ?? []) as Row[]
    return { rows, rowCount: sql.startsWith('INSERT') ? 1 : rows.length }
  } }
  const pool: SqlPool = { async connect() { return client } }
  return { pool, calls }
}
describe('commercial publication fanout', () => {
  it('claims only unleased pending events with skip-locked and a bounded lease', async () => {
    const f = fixture([[{ event_id: event.event_id }]])
    expect(await new PostgresCommercialNotificationRepository(f.pool).claim()).toMatchObject({ eventId: event.event_id })
    expect(f.calls[1]!.sql).toContain('FOR UPDATE SKIP LOCKED LIMIT 1')
    expect(f.calls[1]!.sql).toContain('attempts<8')
    expect(f.calls[1]!.values?.[1]).toBe(60)
    await expect(new PostgresCommercialNotificationRepository(f.pool).claim(301)).rejects.toThrow('LEASE_INVALID')
  })
  it('hard-caps the page, deduplicates event/member, and advances cursor in the same transaction', async () => {
    const members = [{ id: '22222222-2222-4222-8222-222222222222', workspace_id: 'ws-1', identity_id: null, role: 'merchant_admin' }]
    const f = fixture([[event], members, [], []])
    expect(await new PostgresCommercialNotificationRepository(f.pool).fanout({ eventId: event.event_id, token: 'lease' }, 1000)).toEqual({ scanned: 1, delivered: 1, complete: true })
    const memberQuery = f.calls.find(call => call.sql.startsWith('SELECT m.id'))!
    expect(memberQuery.values?.[3]).toBe(200)
    expect(memberQuery.sql).toContain("m.status='active'")
    expect(memberQuery.sql).toContain('m.created_at<=')
    expect(f.calls.find(call => call.sql.startsWith('INSERT'))!.sql).toContain('ON CONFLICT(event_id,member_id) DO NOTHING')
    expect(f.calls.find(call => call.sql.startsWith('UPDATE'))!.values?.[2]).toBe(members[0]!.id)
    expect(f.calls.at(-1)!.sql).toBe('COMMIT')
  })
  it('does not deliver public purchase information to an unknown membership role', async () => {
    const f = fixture([[event], [{ id: 'm', workspace_id: 'ws', identity_id: null, role: 'unknown_role' }], []])
    expect(await new PostgresCommercialNotificationRepository(f.pool).fanout({ eventId: event.event_id, token: 'lease' })).toEqual({ scanned: 1, delivered: 0, complete: true })
    expect(f.calls.some(call => call.sql.startsWith('INSERT'))).toBe(false)
  })
  it('does not emit private data without a positive per-recipient authorization', async () => {
    const f = fixture([[{ ...event, visibility: 'private' }], [{ id: 'm', workspace_id: 'ws', identity_id: null, role: 'operator' }], []])
    expect(await new PostgresCommercialNotificationRepository(f.pool).fanout({ eventId: event.event_id, token: 'lease' })).toEqual({ scanned: 1, delivered: 0, complete: true })
    expect(f.calls.some(call => call.sql.startsWith('INSERT'))).toBe(false)
  })
  it('rolls back a failed insertion without persisting a cursor, enabling same-page recovery', async () => {
    const f = fixture([[event], [{ id: 'm', workspace_id: 'ws', identity_id: null, role: 'operator' }]], 6)
    await expect(new PostgresCommercialNotificationRepository(f.pool).fanout({ eventId: event.event_id, token: 'lease' })).rejects.toThrow('database interrupted')
    expect(f.calls.at(-1)!.sql).toBe('ROLLBACK')
    expect(f.calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false)
  })
  it('rejects a stale lease before member enumeration', async () => {
    const f = fixture([[]])
    await expect(new PostgresCommercialNotificationRepository(f.pool).fanout({ eventId: event.event_id, token: 'old' })).rejects.toThrow('LEASE_LOST')
    expect(f.calls.some(call => call.sql.startsWith('SELECT m.id'))).toBe(false)
  })
  it('rechecks member and private visibility on read, maintaining cursor even for hidden rows', async () => {
    const hidden = { ...event, visibility: 'private' }
    const f = fixture([[{ id: 'm', workspace_id: 'ws', identity_id: null, role: 'operator' }], [hidden, event]])
    expect(await new PostgresCommercialNotificationRepository(f.pool).list('ws', 'm', { limit: 1 })).toEqual({ items: [], next_cursor: { published_at: '2026-10-05T00:00:00.000Z', event_id: `publication:${event.event_id}` } })
    expect(f.calls.find(call => call.sql.includes('FROM workspace_members'))!.sql).toContain("status='active'")
  })
  it('does not turn suspended or unrelated memberships into an empty success response', async () => {
    const f = fixture([[]])
    await expect(new PostgresCommercialNotificationRepository(f.pool).list('ws', 'other-member')).rejects.toThrow('MEMBERSHIP_REQUIRED')
  })
})

describe('commercial outcome projection and recipient read evidence', () => {
  it('seeds assisted purchase-result notifications with the frozen beneficiary, never an inferred workspace member', async () => {
    const source = { source_event_id:'evt-source',event_type:'commercial.payment.active',order_id:'order',beneficiary_member_id:'member-1',created_at:'2026-10-05T00:00:00Z',event_payload:{order_id:'order',grant_status:'active',paid_at:'2026-10-05T00:00:00Z',verified_at:'2026-10-05T00:00:00Z'},sku:{code:'basic',kind:'monthly',version:1,visibility:'public',payload:{}},amount_fen:200000,payment_fact_present:true }
    const f=fixture([[source],[{rowCount:1}]])
    expect(await new PostgresCommercialNotificationRepository(f.pool).seedPurchaseResults('ws')).toBe(1)
    expect(f.calls.find(call=>call.sql.startsWith('INSERT'))?.sql).toContain('beneficiary_member_id')
    expect(f.calls.find(call=>call.sql.startsWith('INSERT'))?.values?.at(-1)).toBe('member-1')
  })
  it('routes a beneficiary-bound result to one member and completes without workspace fanout', async () => {
    const targeted={...event,order_id:'order',result_state:'active',beneficiary_member_id:'member-1'}
    const member={id:'member-1',workspace_id:'ws',identity_id:null,role:'merchant_admin'}
    const f=fixture([[targeted],[member],[{rowCount:1}],[]])
    expect(await new PostgresCommercialNotificationRepository(f.pool).fanoutPurchaseResult('ws',{eventId:event.event_id,token:'lease'})).toEqual({scanned:1,delivered:1,complete:true})
    expect(f.calls.find(call=>call.sql.startsWith('SELECT m.id'))?.values).toEqual(['ws','',targeted.created_at,200,'member-1'])
    expect(f.calls.find(call=>call.sql.startsWith('SELECT m.id'))?.sql).toContain('m.id=$5')
    expect(f.calls.find(call=>call.sql.startsWith('UPDATE commercial_purchase_result'))?.values?.at(-1)).toBe(true)
  })
  it('authorizes a private purchase result only for its frozen beneficiary', async () => {
    const targeted={...event,visibility:'private',notification_kind:'purchase_result',order_id:'order',result_state:'active',beneficiary_member_id:'member-1'}
    const member={id:'member-1',workspace_id:'ws',identity_id:null,role:'merchant_admin'}
    const authorize=vi.fn((recipient, publication) => publication.visibility === 'public' || (publication.notificationKind === 'purchase_result' && publication.beneficiaryMemberId === recipient.memberId))
    const f=fixture([[targeted],[member],[{rowCount:1}],[]])
    expect(await new PostgresCommercialNotificationRepository(f.pool,authorize).fanoutPurchaseResult('ws',{eventId:event.event_id,token:'lease'})).toEqual({scanned:1,delivered:1,complete:true})
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({memberId:'member-1'}),expect.objectContaining({visibility:'private',notificationKind:'purchase_result',beneficiaryMemberId:'member-1'}))
  })
  it('does not widen an unbound private purchase result to workspace members', async () => {
    const unbound={...event,visibility:'private',order_id:'order',result_state:'active',beneficiary_member_id:null}
    const f=fixture([[unbound],[],[]])
    expect(await new PostgresCommercialNotificationRepository(f.pool).fanoutPurchaseResult('ws',{eventId:event.event_id,token:'lease'})).toEqual({scanned:0,delivered:0,complete:true})
    expect(f.calls.some(call=>call.sql.startsWith('SELECT m.id'))).toBe(false)
    expect(f.calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false)
  })
  it('filters private purchase results at read time unless the frozen beneficiary is the current member', async () => {
    const result={...event,notification_kind:'purchase_result',notification_key:'result:evt',notification_id:'result:evt:member-1',visibility:'private',order_id:'order',result_state:'active',beneficiary_member_id:'member-1',payload:{title:'private purchase'}}
    const authorize=(recipient, publication) => publication.visibility === 'public' || (publication.notificationKind === 'purchase_result' && publication.beneficiaryMemberId === recipient.memberId)
    const owned=fixture([[{id:'member-1',workspace_id:'ws',identity_id:null,role:'merchant_admin'}],[result]])
    expect((await new PostgresCommercialNotificationRepository(owned.pool,authorize).list('ws','member-1')).items).toHaveLength(1)
    const other=fixture([[{id:'member-2',workspace_id:'ws',identity_id:null,role:'merchant_admin'}],[result]])
    expect((await new PostgresCommercialNotificationRepository(other.pool,authorize).list('ws','member-2')).items).toHaveLength(0)
    expect(other.calls.find(call=>call.sql.includes('FROM workspace_commercial_result_notifications'))?.sql).toContain('o.beneficiary_member_id::text')
  })
  it('uses the four committed outcomes rather than calling every paid transaction active', async () => {
    const { deriveCommercialPurchaseResultNotification } = await import('./commercial-notification-repository.js')
    for (const state of ['active','scheduled','awaiting_dependency','reconciliation_required'] as const) {
      const result = deriveCommercialPurchaseResultNotification({ source_event_id:'evt-source',event_type:`commercial.payment.${state}`,order_id:'order',created_at:'2026-10-05T00:00:00Z',event_payload:{order_id:'order',grant_status:state,paid_at:'2026-10-05T00:00:00Z',verified_at:'2026-10-05T00:00:00Z',payment_event_id:'not-exported-bank-ref'},sku:{code:'onboarding',kind:'onboarding',version:1,visibility:'public',payload:{name:'账户开通'}},amount_fen:500000,payment_fact_present:true })
      expect(result.state).toBe(state)
      expect(result.payload.title).toContain('账户开通')
      expect(result.payload).not.toHaveProperty('payment_event_id')
      expect(result.payload.grant_status).toBe(state)
    }
  })
  it('rejects a missing committed payment fact instead of inventing a grant or notification', async () => {
    const { deriveCommercialPurchaseResultNotification } = await import('./commercial-notification-repository.js')
    expect(() => deriveCommercialPurchaseResultNotification({source_event_id:'evt',event_type:'commercial.payment.active',order_id:'o',created_at:'2026-10-05T00:00:00Z',event_payload:{order_id:'o',grant_status:'active',paid_at:'2026-10-05T00:00:00Z',verified_at:'2026-10-05T00:00:00Z'},sku:{code:'basic',kind:'monthly',version:1,visibility:'public'},amount_fen:200000,payment_fact_present:false})).toThrow('EVIDENCE_INVALID')
  })
  it('replays an authorized read fact and rejects same-key different notification intent', async () => {
    const member={id:'m',workspace_id:'ws',identity_id:null,role:'merchant_admin'}
    const notice={...event,notification_id:'notice:m'}
    const prior={notification_id:'notice:m',read_at:'2026-10-05T02:00:00Z'}
    const replay=fixture([[],[member],[notice],[prior]])
    expect(await new PostgresCommercialNotificationRepository(replay.pool).markRead('ws','m',{notificationId:'notice:m',idempotencyKey:'read-key-one'})).toEqual({notification_id:'notice:m',read_at:'2026-10-05T02:00:00.000Z',replayed:true})
    expect(replay.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false)
    const conflict=fixture([[],[member],[{...notice,notification_id:'different:m'}],[prior]])
    await expect(new PostgresCommercialNotificationRepository(conflict.pool).markRead('ws','m',{notificationId:'different:m',idempotencyKey:'read-key-one'})).rejects.toMatchObject({code:'COMMERCIAL_NOTIFICATION_IDEMPOTENCY_CONFLICT',status:409})
  })
  it('reports storage failures using a typed 503 without SQL or backend error text', async () => {
    const pool: SqlPool = { async connect() { throw new Error('SQL secret backend details') } }
    await expect(new PostgresCommercialNotificationRepository(pool).markRead('ws','m',{notificationId:'notice:m',idempotencyKey:'read-key-one'})).rejects.toMatchObject({ code: 'COMMERCIAL_NOTIFICATION_STORAGE_UNAVAILABLE', status: 503, message: 'COMMERCIAL_NOTIFICATION_STORAGE_UNAVAILABLE' })
  })
  it('never appends a read for an invisible or another-member notification', async () => {
    const f=fixture([[],[{id:'m',workspace_id:'ws',identity_id:null,role:'operator'}],[]])
    await expect(new PostgresCommercialNotificationRepository(f.pool).markRead('ws','m',{notificationId:'notice:other',idempotencyKey:'read-key-one'})).rejects.toMatchObject({code:'COMMERCIAL_NOTIFICATION_NOT_VISIBLE',status:404})
    expect(f.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false)
  })
})

describe('durable purchase-result exhaustion and controlled retry', () => {
  const command={eventId:'evt-result',actorId:'verified-ops',reason:'delivery dependency repaired',idempotencyKey:'retry-command-001'}
  it('shows exhausted work and resumes bounded backlog pagination without exposing lease tokens',async()=>{
    const f=fixture([[{pending:2,failed:1,exhausted:1,leased:1}],[{source_event_id:'evt-result',order_id:'order',attempts:8,cursor_member_id:'last-recipient',created_at:'2026-10-05T00:00:00Z',status:'exhausted'},{source_event_id:'evt-next',created_at:'2026-10-06T00:00:00Z'}]])
    const result=await new PostgresCommercialNotificationRepository(f.pool).getPurchaseResultBacklog('ws',{limit:1})
    expect(result.exhausted).toBe(1)
    expect(result.items[0]).toMatchObject({eventId:'evt-result',attempts:8,status:'exhausted',cursorMemberId:'last-recipient'})
    expect(result.nextCursor).toEqual({createdAt:'2026-10-05T00:00:00.000Z',eventId:'evt-result'})
    expect(result.items[0]).not.toHaveProperty('lease_token')
    expect(f.calls.find(c=>c.sql.includes('ORDER BY created_at'))!.values).toEqual(['ws',null,null,2])
  })
  it('does not automatically claim exhausted work',async()=>{
    const f=fixture([[]]);expect(await new PostgresCommercialNotificationRepository(f.pool).claimPurchaseResult('ws')).toBeUndefined()
    expect(f.calls.find(c=>c.sql.startsWith('UPDATE'))!.sql).toContain('attempts<8')
  })
  it('audits one exhausted retry without resetting attempts or recipient progress',async()=>{
    const f=fixture([[],[],[{attempts:8,cursor_member_id:'last-recipient',completed_at:null,live_lease:false}],[],[]])
    const result=await new PostgresCommercialNotificationRepository(f.pool).claimPurchaseResultRedrive('ws',command)
    expect(result).toMatchObject({eventId:command.eventId,attempts:9,replayed:false,lease:{eventId:command.eventId}})
    expect(result.lease!.token).toBeTruthy()
    const update=f.calls.find(c=>c.sql.startsWith('UPDATE'))!
    expect(update.sql).toContain('attempts=attempts+1');expect(update.sql).not.toContain('cursor_member_id=');expect(update.sql).not.toContain('completed_at=')
    const audit=f.calls.find(c=>c.sql.startsWith('INSERT INTO workspace_operation_audit'))!
    expect(JSON.parse(String(audit.values![5]))).toEqual({attempts:9,cursor_member_id:'last-recipient',status:'retry_leased',idempotency_key:command.idempotencyKey})
    expect(JSON.stringify(audit.values)).not.toContain(result.lease!.token)
    expect(f.calls.at(-1)!.sql).toBe('COMMIT')
  })
  it('replays the committed command without leasing or delivering again and rejects a changed intent',async()=>{
    const prior={resource_id:command.eventId,actor_id:command.actorId,reason:command.reason,after_json:{attempts:9}}
    const f=fixture([[],[prior]])
    expect(await new PostgresCommercialNotificationRepository(f.pool).claimPurchaseResultRedrive('ws',command)).toMatchObject({attempts:9,replayed:true})
    expect(f.calls.some(c=>c.sql.startsWith('UPDATE')||c.sql.startsWith('INSERT'))).toBe(false)
    await expect(new PostgresCommercialNotificationRepository(fixture([[],[prior]]).pool).claimPurchaseResultRedrive('ws',{...command,eventId:'different'})).rejects.toMatchObject({code:'COMMERCIAL_NOTIFICATION_IDEMPOTENCY_CONFLICT',status:409})
  })
  it('rejects completed, still leased and non-exhausted work',async()=>{
    for(const row of [{attempts:8,completed_at:'done',live_lease:false},{attempts:8,completed_at:null,live_lease:true},{attempts:7,completed_at:null,live_lease:false}]){
      const f=fixture([[],[],[row]])
      await expect(new PostgresCommercialNotificationRepository(f.pool).claimPurchaseResultRedrive('ws',command)).rejects.toMatchObject({code:'COMMERCIAL_NOTIFICATION_REDRIVE_NOT_EXHAUSTED',status:409})
      expect(f.calls.some(c=>c.sql.startsWith('UPDATE'))).toBe(false)
    }
  })
  it('rolls back the lease if immutable audit append fails',async()=>{
    const f=fixture([[],[],[{attempts:8,cursor_member_id:'m',completed_at:null,live_lease:false}],[]],7)
    await expect(new PostgresCommercialNotificationRepository(f.pool).claimPurchaseResultRedrive('ws',command)).rejects.toThrow('database interrupted')
    expect(f.calls.at(-1)!.sql).toBe('ROLLBACK')
  })
})
