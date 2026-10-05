import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCommercialCatalogRepository, type CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { PostgresCommercialContractRepository, type CommercialOrderV2 } from './commercial-contract-repository.js'
import { MigrationRunner,loadMigrations } from './migration.js'
import { PostgresCommercialNotificationRepository } from './commercial-notification-repository.js'
import { dropDrainedPostgresFixture } from './postgres-scope-fixture-cleanup.js'
const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = source ? it : it.skip
const primaryFailure = undefined

describe('commercial notifications PostgreSQL isolated delivery', () => {
  postgresIt('recovers a bounded fanout and preserves events, while ACL and read authorization reject leakage', async () => {
    const base = new URL(source!)
    const name = `commercial_notify_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: source })
    let db: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      base.pathname = `/${name}`
      db = new Pool({ connectionString: base.toString() })
      // Minimal real prerequisites: this verifies the notification SQL boundary,
      // not a claim that the complete release migration/bootstrap gate passed.
      await db.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE workspaces(id text PRIMARY KEY); CREATE TABLE commercial_catalog_skus(code text PRIMARY KEY); CREATE TABLE platform_identities(id uuid PRIMARY KEY,access_status text); CREATE TABLE workspace_members(id uuid PRIMARY KEY,workspace_id text REFERENCES workspaces(id),external_subject text,display_name text,role text,status text,invited_by text,revision integer DEFAULT 1,identity_id uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(workspace_id,id)); CREATE FUNCTION reject_commercial_catalog_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END; $$;`)
      await db.query(await readFile(new URL('./migrations/262_commercial_catalog_notifications.sql', import.meta.url), 'utf8'))
      await db.query(`CREATE TABLE outbox_events(id text,workspace_id text REFERENCES workspaces(id),event_type text,created_at timestamptz,PRIMARY KEY(id),UNIQUE(id,workspace_id)); CREATE TABLE commercial_orders_v2(id text,workspace_id text REFERENCES workspaces(id),PRIMARY KEY(id),UNIQUE(workspace_id,id)); CREATE TABLE commercial_order_snapshots_v2(id text PRIMARY KEY,workspace_id text,order_id text,snapshot jsonb); CREATE TABLE commercial_payment_events_v2(id text PRIMARY KEY,workspace_id text,order_id text,provider_event_id text);`)
      await db.query(`CREATE TABLE commercial_order_terms_v3(workspace_id text REFERENCES workspaces(id),order_id text,purchase_kind text,expires_at timestamptz,policy_version text,checkout_id text,onboarding_order_id text,upgrade_quote_id text,grant_status text DEFAULT 'pending',granted_at timestamptz,created_at timestamptz,PRIMARY KEY(workspace_id,order_id),FOREIGN KEY(workspace_id,order_id) REFERENCES commercial_orders_v2(workspace_id,id),FOREIGN KEY(workspace_id,onboarding_order_id) REFERENCES commercial_orders_v2(workspace_id,id));`)
      await db.query(await readFile(new URL('./migrations/264_commercial_result_notifications_and_reads.sql', import.meta.url), 'utf8'))
      await db.query(await readFile(new URL('./migrations/266_commercial_order_beneficiaries.sql', import.meta.url), 'utf8'))
      const policy = (await db.query("SELECT qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='workspace_commercial_notifications'")).rows[0]
      expect(policy.qual.replaceAll(' ', '')).toBe("((workspace_id = current_setting('app.workspace_id'::text, true)) AND (((member_id)::text = current_setting('app.member_id'::text, true)) OR (CURRENT_USER = 'merchant_ops'::name)))".replaceAll(' ', ''))
      await db.query(`INSERT INTO workspaces VALUES ('ws-1'),('ws-2'); INSERT INTO commercial_catalog_skus VALUES ('basic'); INSERT INTO workspace_members SELECT gen_random_uuid(),'ws-1','notice-'||g,'','merchant_admin','active','fixture',1,null,now()-interval '1 hour',now()-interval '1 hour' FROM generate_series(1,201) g`)
      const eventId = randomUUID()
      await db.query(`INSERT INTO commercial_catalog_publish_outbox(event_id,sku_code,version,visibility,payload,created_at) VALUES($1,'basic',1,'public','{"name":"基础版","price_fen":200000}',now()-interval '1 minute')`, [eventId])
      const repo = new PostgresCommercialNotificationRepository(db)
      const lease = (await repo.claim())!
      const first = await repo.fanout(lease, 10000)
      expect(first).toEqual({ scanned: 200, delivered: 200, complete: false })
      await expect(repo.fanout(lease)).rejects.toThrow('LEASE_LOST')
      const second = await repo.fanout((await repo.claim())!)
      expect(second).toEqual({ scanned: 1, delivered: 1, complete: true })
      expect(await repo.claim()).toBeUndefined()
      expect((await db.query('SELECT count(*)::int AS n FROM workspace_commercial_notifications')).rows[0].n).toBe(201)
      const member = (await db.query('SELECT id FROM workspace_members ORDER BY id LIMIT 1')).rows[0].id
      expect((await repo.list('ws-1', member)).items).toHaveLength(1)
      const noticeId = (await repo.list('ws-1', member)).items[0]!.id
      const read = await repo.markRead('ws-1', member, { notificationId: noticeId, idempotencyKey: 'notification-read-one' })
      expect(read.replayed).toBe(false)
      expect((await repo.list('ws-1', member)).items[0]!.read_at).toBe(read.read_at)
      expect(await repo.markRead('ws-1', member, { notificationId: noticeId, idempotencyKey: 'notification-read-one' })).toEqual({ ...read, replayed: true })
      await expect(repo.markRead('ws-2', member, { notificationId: noticeId, idempotencyKey: 'notification-read-other' })).rejects.toThrow('MEMBERSHIP_REQUIRED')
      await expect(repo.list('ws-2', member)).rejects.toThrow('MEMBERSHIP_REQUIRED')
      await db.query(`UPDATE workspace_members SET status='suspended' WHERE id=$1`, [member])
      await expect(repo.list('ws-1', member)).rejects.toThrow('MEMBERSHIP_REQUIRED')
      await db.query(`UPDATE workspace_members SET status='active' WHERE id=$1`, [member])
      const privateId = randomUUID()
      await db.query(`INSERT INTO commercial_catalog_publish_outbox(event_id,sku_code,version,visibility,payload) VALUES($1,'basic',1,'private','{"name":"限定包"}')`, [privateId])
      let permitted = true
      const privateRepo = new PostgresCommercialNotificationRepository(db, (_member, event) => event.visibility === 'public' || permitted)
      await privateRepo.fanout((await privateRepo.claim())!)
      await privateRepo.fanout((await privateRepo.claim())!)
      expect((await privateRepo.list('ws-1', member)).items).toHaveLength(2)
      permitted = false
      expect((await privateRepo.list('ws-1', member)).items).toHaveLength(1)
      await expect(db.query(`UPDATE commercial_catalog_publish_outbox SET payload='{}' WHERE event_id=$1`, [eventId])).rejects.toThrow('immutable')
      await expect(db.query('DELETE FROM workspace_commercial_notifications')).rejects.toThrow('immutable')
      const role = (await db.query("SELECT rolname FROM pg_roles WHERE rolname='merchant_app'")).rows[0]
      if (role) {
        expect((await db.query("SELECT has_table_privilege('merchant_app','commercial_catalog_publish_outbox','SELECT') AS allowed")).rows[0].allowed).toBe(false)
        const client = await db.connect()
        try {
          await client.query('BEGIN')
          await client.query('SET LOCAL ROLE merchant_app')
          await client.query("SELECT set_config('app.workspace_id','ws-2',true),set_config('app.member_id',$1,true)", [member])
          expect((await client.query('SELECT count(*)::int n FROM workspace_commercial_notifications')).rows[0].n).toBe(0)
          await client.query("SELECT set_config('app.workspace_id','ws-1',true),set_config('app.member_id','unrelated-member',true)")
          expect((await client.query('SELECT count(*)::int n FROM workspace_commercial_notifications')).rows[0].n).toBe(0)
          await client.query("SELECT set_config('app.member_id',$1,true)", [member])
          expect((await client.query('SELECT count(*)::int n FROM workspace_commercial_notifications')).rows[0].n).toBe(2)
          await expect(client.query('DELETE FROM workspace_commercial_notifications')).rejects.toThrow('permission denied')
        } finally { await client.query('ROLLBACK'); client.release() }
      }
    } finally {
      await db?.end()
      await dropDrainedPostgresFixture(admin, name)
      await admin.end()
    }
  }, 30000)
  postgresIt('projects all four real transaction outcomes without granting again and appends only the trusted recipient read facts', async () => {
    const name = `commercial_notify_result_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: source })
    let db: Pool | undefined, app: Pool | undefined, ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      const connection = new URL(source!); connection.pathname=`/${name}`
      db = new Pool({connectionString:connection.toString()})
      await new MigrationRunner(db,await loadMigrations()).run()
      await db.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql',import.meta.url),'utf8'))
      const role = (name:string) => {const c=new URL(connection);c.username=name;c.password=`${name}_local_only`;return c.toString()}
      app = new Pool({connectionString:role('merchant_app')});ops=new Pool({connectionString:role('merchant_ops')})
      const catalog=new PostgresCommercialCatalogRepository(ops)
      const publish=async(code:string,kind:'onboarding'|'monthly')=>{
        const payload={blockers:[],purchasePolicy:{approved:true,version:'notification-owned-window-v1',expiresInSeconds:604800},
          ...(kind==='onboarding'?{policyRef:{policyId:'commercial.onboarding',version:'v2'},grantSchedule:{policyRef:{policyId:'commercial.onboarding',version:'v2'},grantCount:6,pointsPerGrant:500,cadence:'monthly',timezone:'UTC',startsAt:'payment_verified',grantExpiresAtRule:'next_monthly_anniversary',schedulingStatus:'resolved'}}:{cycle:{unit:'month',count:1},planFamily:'notification-fixture',tierRank:1,upgradePolicy:{approved:true,version:'notification-upgrade-v1'}})}
        await catalog.mutate({action:'create',code,kind,priceFen:kind==='onboarding'?500000:200000,payload,benefits:[{code:kind==='onboarding'?'creative_points':'monthly_creative_points',quantity:kind==='onboarding'?500:5000,normalizedValue:kind==='onboarding'?500:5000,rawValue:null,rawUnit:'point',policyRef:'notification-owned-approved',metadata:{}}],expectedRevision:0,idempotencyKey:`${code}:create`,actorId:'fixture-maker',reason:'owned isolated notification fixture',evidence:{}})
        const approved=await catalog.mutate({action:'approve',code,expectedRevision:1,idempotencyKey:`${code}:approve`,actorId:'fixture-approver',reason:'owned isolated approval',evidence:{fixture_only:true}})
        return catalog.mutate({action:'publish',code,versionId:approved.versionId,expectedRevision:2,idempotencyKey:`${code}:publish`,actorId:'fixture-publisher',reason:'owned isolated publish',evidence:{fixture_only:true}})
      }
      const opening=await publish('notice-opening','onboarding'), basic=await publish('notice-basic','monthly')
      const ws=`notice-ws-${randomUUID()}`, member=randomUUID(), other=randomUUID()
      await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')",[ws])
      await db.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,created_at) VALUES($1,$3,'notice-a','A','merchant_admin','active','fixture','2026-01-01'),($2,$3,'notice-b','B','merchant_admin','active','fixture','2026-01-01')",[member,other,ws])
      const transactions=new PostgresCommercialContractRepository(app)
      const firstAt='2027-01-31T00:00:00.000Z'
      const pay=(order:CommercialOrderV2,at=firstAt)=>transactions.recordVerifiedPaymentAndGrant({workspaceId:ws,orderId:order.id,provider:'manual_transfer',providerOrderId:`bank:${order.id}`,providerEventId:`cash:${order.id}`,nonce:`nonce:${order.id}`,payloadHash:'a'.repeat(64),amountFen:order.amountFen,currency:'CNY',paidAt:at,verifiedAt:at})
      const first=await transactions.createFirstCheckout({workspaceId:ws,actorId:'buyer',onboardingSku:opening,subscriptionSku:basic,paymentProvider:'manual_transfer',idempotencyKey:'notice-first-checkout',reason:'isolated test; no real bank cash',now:firstAt,beneficiaryMemberId:member})
      expect(await pay(first.subscription)).toMatchObject({grantStatus:'awaiting_dependency'})
      expect(await pay(first.onboarding)).toMatchObject({grantStatus:'active'})
      const renew=async(key:string)=>transactions.createOrder({workspaceId:ws,sku:basic as CommercialCatalogSkuSnapshot,purchaseKind:'renewal',paymentProvider:'manual_transfer',createdByActorId:'buyer',idempotencyKey:key,reason:'owned isolated renewal',now:firstAt,beneficiaryMemberId:member})
      const futureRenewal=await renew('notice-future-renewal'), expiredRenewal=await renew('notice-expired-renewal')
      expect(await pay(futureRenewal)).toMatchObject({grantStatus:'scheduled'})
      expect(await pay(expiredRenewal,'2027-02-08T00:00:00.000Z')).toMatchObject({grantStatus:'reconciliation_required'})
      const before=(await db.query('SELECT count(*)::int n FROM creative_point_grants WHERE workspace_id=$1',[ws])).rows[0].n
      const fanout=new PostgresCommercialNotificationRepository(ops)
      expect(await fanout.seedPurchaseResults(ws)).toBeGreaterThanOrEqual(4)
      expect(await fanout.seedPurchaseResults(ws)).toBe(0)
      let lease
      while((lease=await fanout.claimPurchaseResult(ws))) await fanout.fanoutPurchaseResult(ws,lease)
      expect((await db.query('SELECT count(*)::int n FROM creative_point_grants WHERE workspace_id=$1',[ws])).rows[0].n).toBe(before)
      const notices=new PostgresCommercialNotificationRepository(app)
      const page=await notices.list(ws,member)
      expect(new Set(page.items.map(n=>n.result_state))).toEqual(new Set(['active','scheduled','awaiting_dependency','reconciliation_required']))
      expect(new Set(page.items.map(n=>n.order_id))).toEqual(new Set([first.onboarding.id,first.subscription.id,futureRenewal.id,expiredRenewal.id]))
      expect(page.items.every(n=>n.notification_kind==='purchase_result' && n.read_at===null)).toBe(true)
      expect((await notices.list(ws,other)).items).toHaveLength(0)
      expect(page.items.find(n=>n.order_id===first.onboarding.id)!.title).toContain('账户开通')
      const one=page.items[0]!
      const read=await notices.markRead(ws,member,{notificationId:one.id,idempotencyKey:'result-read-owned-one'})
      expect(read.replayed).toBe(false)
      expect((await notices.list(ws,member)).items.find(n=>n.id===one.id)!.read_at).toBe(read.read_at)
      await expect(notices.markRead(ws,other,{notificationId:one.id,idempotencyKey:'result-read-wrong-user'})).rejects.toThrow('NOT_VISIBLE')
      await expect(notices.markRead(ws,member,{notificationId:page.items[1]!.id,idempotencyKey:'result-read-owned-one'})).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    } finally {
      await app?.end();await ops?.end();await db?.end()
      await dropDrainedPostgresFixture(admin, name)
      await admin.end()
    }
  },120000)

})
