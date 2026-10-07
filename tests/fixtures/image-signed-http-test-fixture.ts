/** Test-only real API + tenant-role PostgreSQL fixture. Never imported by production. */
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { vi } from 'vitest'
import { createWorkerRequestProof } from '../../packages/security/src/worker-request-proof.js'

export async function startImageSignedFixture(options: { redis?: boolean } = {}) {
  const raw = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  const runId = process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID
  if (!raw || !runId || !/^[a-f0-9-]{36}$/.test(runId) || new URL(raw).hostname !== '127.0.0.1') throw new Error('OWNED_ISOLATED_PG_REQUIRED')
  for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'MODEL_RELAY_BASE_URL', 'MODEL_RELAY_API_KEY']) if (process.env[key]) throw new Error(`INHERITED_ENV_FORBIDDEN:${key}`)
  if (options.redis) {
    const rawRedis = process.env.MERCHANT_ISOLATED_REDIS_URL
    if (!rawRedis) throw new Error('OWNED_ISOLATED_REDIS_REQUIRED')
    const redis = new URL(rawRedis)
    if (redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' || !redis.password || redis.port !== process.env.MERCHANT_ISOLATED_REDIS_PORT) throw new Error('OWNED_ISOLATED_REDIS_BINDING_MISMATCH')
    vi.stubEnv('REDIS_URL', rawRedis)
  }
  const admin = new Pool({ connectionString: raw, max: 2 })
  const appUrl = new URL(raw); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
  const opsUrl = new URL(raw); opsUrl.username = 'merchant_ops'; opsUrl.password = 'merchant_ops_local_only'
  const credential = { token: `fixture-${randomUUID()}`, signing_secret: `fixture-${randomUUID()}` }
  const reconcileCredential = { token: `fixture-${randomUUID()}`, signing_secret: `fixture-${randomUUID()}` }
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('DATABASE_URL', appUrl.toString()); vi.stubEnv('OPS_DATABASE_URL', opsUrl.toString())
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true'); vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
  vi.stubEnv('PORT', '0'); vi.stubEnv('API_BIND_HOST', '127.0.0.1'); vi.stubEnv('PERSISTENCE_MODE', 'postgres'); vi.stubEnv('RUN_MIGRATIONS_ON_STARTUP', 'false'); vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: credential, reconcile: reconcileCredential })); vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '100000')
  const api = await import('../../apps/api/src/server.js')
  const persistence = await api.persistenceReady
  if (persistence.mode !== 'postgres') throw new Error('REAL_POSTGRES_REQUIRED')
  // Initialization avoids unrelated production deployment gates; tested HTTP
  // handlers use production budget reserve/release and strict real signatures.
  vi.stubEnv('NODE_ENV', 'production')
  if (!api.server.listening) await new Promise<void>((resolve, reject) => { api.server.once('error', reject); api.server.once('listening', resolve) })
  const address = api.server.address(); if (!address || typeof address === 'string') throw new Error('LOOPBACK_BIND_FAILED')
  const base = `http://127.0.0.1:${address.port}`
  const workspaces: string[] = []
  async function seedJob(options: { workspaceId?: string; badBudget?: boolean; badEvent?: boolean; reserve?: boolean; unclaimed?: boolean } = {}) {
    const workspaceId = options.workspaceId ?? `ws_image_${randomUUID().replaceAll('-', '')}`
    const identityId = randomUUID(); const actorId = `fixture-${identityId}`
    if (!workspaces.includes(workspaceId)) { await admin.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId]); workspaces.push(workspaceId) }
    await admin.query('INSERT INTO platform_identities(id,issuer,external_subject,display_name) VALUES($1,$2,$3,$4)', [identityId, 'http://fixture.invalid', actorId, 'Isolated image actor'])
    await admin.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id) VALUES($1,$2,$3,'fixture','workspace_owner','active','fixture',$4)", [randomUUID(), workspaceId, actorId, identityId])
    const productId = `product-${randomUUID()}`; const jobId = `imggen_${randomUUID()}`; const idempotencyKey = `fixture-${jobId}`; const action = `image:${idempotencyKey}`
    const orderId = `order-${randomUUID()}`
    const orderSnapshotId = `order-snapshot-${randomUUID()}`
    const periodId = `period-${randomUUID()}`
    const entitlementId = `entitlement-${randomUUID()}`
    await admin.query(`INSERT INTO commercial_orders_v2
      (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,provider_order_id,paid_at)
      VALUES ($1,$2,'sku-monthly-basic','sku-version-monthly-basic-v2',200000,'CNY','fixture','paid',$3,$4,'image-fixture',$5,now())`,
      [orderId, workspaceId, `image-fixture-entitlement:${jobId}`, 'a'.repeat(64), `image-fixture-${jobId}`])
    await admin.query(`INSERT INTO commercial_order_snapshots_v2
      (id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum)
      VALUES ($1,$2,$3,'sku-monthly-basic','sku-version-monthly-basic-v2',$4,$5::jsonb,$6)`,
      [orderSnapshotId, workspaceId, orderId, 'b'.repeat(64), JSON.stringify({ fixture: 'image-signed-http', simulated: true }), 'c'.repeat(64)])
    await admin.query(`INSERT INTO workspace_subscription_periods_v2
      (id,workspace_id,order_snapshot_id,period_start,period_end,status,revision)
      VALUES ($1,$2,$3,now() - interval '1 day',now() + interval '30 days','active',1)`,
      [periodId, workspaceId, orderSnapshotId])
    await admin.query(`INSERT INTO workspace_entitlement_snapshots_v2
      (id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,rate_card_version_id,resolved_benefits,unresolved_blockers,executable,checksum)
      VALUES ($1,$2,$3,1,'sku-version-monthly-basic-v2',NULL,$4::jsonb,'[]'::jsonb,true,$5)`,
      [entitlementId, workspaceId, periodId, JSON.stringify([{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }, { code: 'monthly_creative_points', quantity: 5000 }]), 'd'.repeat(64)])
    await persistence.business!.save({ workspaceId, entityType: 'product', entityId: productId, entityVersion: 1, payload: { id: productId, workspaceId, title: 'Isolated image', platform: 'jd', source: 'fixture', remoteId: productId, storeName: 'fixture', version: 1, skuCount: 1, stock: 0 } })
    const job = { id: jobId, workspaceId, productId, idempotencyKey, intentHash: 'a'.repeat(64), sourceProductVersion: 1, direction: 'fixture', count: 1, state: 'queued', archiveState: 'pending', revision: 1 }
    await persistence.business!.save({ workspaceId, entityType: 'image_generation_job', entityId: jobId, entityVersion: 1, payload: job })
    api.service.imageGenerationJobs.set(jobId, job as never)
    const revision = await persistence.authorization!.getAuthorizationRevision(identityId)
    const snapshot = { schema_version: 1, decision_id: `decision-${randomUUID()}`, actor_id: actorId, identity_id: identityId, workspace_id: workspaceId, workbench: 'workspace', context_id: `workspace:${workspaceId}`, context_version: '1', policy_version: '1', grant_revision: `membership:${identityId}:${revision}`, grant_ids: [], scope_hash: 'a'.repeat(64), capability: 'image_generation.execute', resource_id: jobId, resource_revision: '1', request_id: randomUUID(), trace_id: randomUUID(), authorized: true, decided_at: new Date().toISOString() }
    const point = await persistence.creativePoints!.grant({ workspaceId, idempotencyKey: `grant-${jobId}`, sourceType: 'fixture', sourceId: jobId, points: 10 })
    const hold = await persistence.creativePoints!.reserve({ workspaceId, idempotencyKey: `hold-${jobId}`, actionKey: action, points: 1, rateCardVersion: 'fixture' })
    const balance = hold.balance
    const fact = { schema_version: 1, workspace_id: workspaceId, balance_state: balance.availablePoints === null ? 'unknown' : 'known', available_points: balance.availablePoints, reserved_points: balance.reservedPoints, settled_points: balance.settledPoints, access_revision: String(balance.revision) }
    const commercial = { schema_version: 1, decision_id: `commercial-${randomUUID()}`, workspace_id: workspaceId, operation: 'image_generation.execute', access_mode: 'POINT_CHARGED', access_revision: String(balance.revision), balance_state: 'known', entitlement_snapshot_id: `creative-point-access:${workspaceId}:${balance.revision}`, entitlement_snapshot_checksum: createHash('sha256').update(JSON.stringify(fact)).digest('hex'), rate_version: hold.value.rateCardVersion, quoted_points: hold.value.points, reservation_id: hold.value.id, decided_at: new Date().toISOString() }
    const event = await persistence.outbox!.append({ workspaceId, aggregateId: jobId, eventType: 'image.generation.requested', sequence: 1, payload: { workspace_id: workspaceId, product_title: 'Isolated image', direction: 'fixture', requested_count: 1, commercial_access_snapshot: commercial, job_id: jobId, product_id: productId, action_id: options.badBudget ? 'image:foreign-action' : action, run_key: action, intent_hash: job.intentHash, authorization_snapshot: snapshot, reservation_id: hold.value.id } })
    await persistence.modelUsage!.reserveDailyBudget({ workspaceId, reservationKey: action, runKey: action, modality: 'image', model: 'fixture-no-provider', estimateCny: 0.2, estimateVersion: 'fixture', dailyLimitCny: 100, runLimitCny: 2 })
    const execution = options.unclaimed ? { ownerToken: '' } : await persistence.imageGenerationExecutions!.claim({ workspaceId, jobId, eventId: options.badEvent ? `wrong-${randomUUID()}` : event.id, leaseMs: 900000 })
    if (!options.unclaimed && options.reserve !== false) await persistence.imageGenerationExecutions!.reserveProviderOperation({ workspaceId, jobId, ownerToken: execution.ownerToken })
    return { workspaceId, jobId, productId, action, event, execution, hold, point, snapshot, identityId, actorId }
  }
  async function fingerprint() {
    const hashes: Record<string, string> = {}
    for (const table of ['image_generation_executions', 'model_cost_budget_reservations', 'creative_point_reservations', 'creative_point_operations', 'outbox_events']) {
      const rows = (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [workspaces])).rows
      hashes[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    }
    return hashes
  }
  function signedHeaders(path: string, workspaceId: string, body: string) {
    return { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...createWorkerRequestProof({ secret: credential.signing_secret, workerId: 'isolated-image-worker', role: 'generation', method: 'POST', requestTarget: path, workspaceId, body }).headers }
  }
  async function request(jobId: string, workspaceId: string, input: Record<string, unknown>, headersOverride?: Record<string, string>) {
    const path = `/v1/internal/image-generation-jobs/${jobId}/execution`; const body = JSON.stringify(input)
    const headers = headersOverride ?? signedHeaders(path, workspaceId, body)
    const response = await fetch(base + path, { method: 'POST', headers, body })
    return { status: response.status, body: await response.json() as { data?: Record<string, any>; error?: { code: string } }, headers }
  }
  async function close() { await new Promise<void>(resolve => api.server.close(() => resolve())); await persistence.close?.(); await admin.end(); vi.unstubAllEnvs() }
  return { api, persistence, admin, appUrl: appUrl.toString(), opsUrl: opsUrl.toString(), credential, reconcileCredential, base, seedJob, fingerprint, signedHeaders, request, close, workspaces }
}
