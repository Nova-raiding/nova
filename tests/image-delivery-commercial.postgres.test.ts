import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Pool, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkerRequestProof } from '../packages/security/src/worker-request-proof.js'
import { createIsolatedOpsFixture, type IsolatedOpsFixture } from './isolated-ops-fixture.js'

type Api = typeof import('../apps/api/src/server.js')
type Envelope = { data: any; error: { code: string; message: string } | null }

const evidenceDir = join(process.cwd(), 'artifacts', 'image-delivery-commercial')
const merchantToken = 'disposable-image-commercial-merchant-token'
const workerToken = 'disposable-image-commercial-worker-token'
const workerSecret = 'disposable-image-commercial-worker-secret'
let fixture: IsolatedOpsFixture | undefined
let api: Api | undefined
let persistence: Awaited<Api['persistenceReady']> | undefined
let appPool: Pool | undefined
let base = ''

async function scopedRead<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
  if (!fixture || !appPool) throw new Error('isolated fixture not initialized')
  const client = await appPool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [fixture.workspaceId])
    const rows = (await client.query<T>(sql, values)).rows
    await client.query('COMMIT')
    return rows
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function signedPost(path: string, input: Record<string, unknown>) {
  if (!fixture) throw new Error('isolated fixture not initialized')
  const body = JSON.stringify(input)
  const proof = createWorkerRequestProof({ secret: workerSecret, role: 'generation', workerId: 'image-commercial-fixture', method: 'POST', requestTarget: path, workspaceId: fixture.workspaceId, body })
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json', 'x-workspace-id': fixture.workspaceId, ...proof.headers }, body })
  return { status: response.status, body: await response.json() as Envelope }
}

async function seedIsolatedEntitlement(workspaceId: string) {
  // Pure disposable PG fixture to admit a merchant status read. This is not
  // payment-provider, callback, or commercial-order acceptance evidence.
  if (!appPool) throw new Error('isolated app pool not initialized')
  const suffix = crypto.randomUUID()
  const orderId = `order-${suffix}`
  const snapshotId = `order-snapshot-${suffix}`
  const periodId = `period-${suffix}`
  const client = await appPool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId])
    await client.query(`INSERT INTO commercial_orders_v2
      (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,provider_order_id,paid_at)
      VALUES ($1,$2,'sku-monthly-basic','sku-version-monthly-basic-v2',200000,'CNY','fixture','paid',$3,$4,'image-commercial-merchant',$5,now())`,
      [orderId, workspaceId, `image-commercial-entitlement:${suffix}`, 'a'.repeat(64), `simulated-order-${suffix}`])
    await client.query(`INSERT INTO commercial_order_snapshots_v2
      (id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum)
      VALUES ($1,$2,$3,'sku-monthly-basic','sku-version-monthly-basic-v2',$4,$5::jsonb,$6)`,
      [snapshotId, workspaceId, orderId, 'b'.repeat(64), JSON.stringify({ fixture: 'image-delivery-commercial', simulated: true }), 'c'.repeat(64)])
    await client.query(`INSERT INTO workspace_subscription_periods_v2
      (id,workspace_id,order_snapshot_id,period_start,period_end,status,revision)
      VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,'active',1)`,
      [periodId, workspaceId, snapshotId, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()])
    await client.query(`INSERT INTO workspace_entitlement_snapshots_v2
      (id,workspace_id,subscription_period_id,subscription_period_revision,catalog_version_id,rate_card_version_id,resolved_benefits,unresolved_blockers,executable,checksum)
      VALUES ($1,$2,$3,1,'sku-version-monthly-basic-v2','rate-card-approved-v2',$4::jsonb,'[]'::jsonb,true,$5)`,
      [`entitlement-${suffix}`, workspaceId, periodId, JSON.stringify([{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }, { code: 'monthly_creative_points', quantity: 5000 }]), 'd'.repeat(64)])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

describe('charged image callback commercial delivery fence (real isolated PG17/RLS and signed API)', () => {
  beforeAll(async () => {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    fixture = await createIsolatedOpsFixture({ evidenceDir })
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('VITEST', 'true')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('PORT', '0')
    vi.stubEnv('API_BIND_HOST', '127.0.0.1')
    vi.stubEnv('DATABASE_URL', fixture.databaseUrl)
    vi.stubEnv('OPS_DATABASE_URL', fixture.opsDatabaseUrl)
    vi.stubEnv('REDIS_URL', fixture.redisUrl)
    vi.stubEnv('PERSISTENCE_MODE', 'postgres')
    vi.stubEnv('MODEL_RELAY_PROVIDER', 'fixture-relay')
    vi.stubEnv('RUN_MIGRATIONS_ON_STARTUP', 'false')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'false')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'false')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'disposable-image-commercial-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [merchantToken]: { workspaces: [fixture.workspaceId], actor_id: 'image-commercial-merchant', roles: ['merchant_admin'] } }))
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: { token: workerToken, signing_secret: workerSecret } }))
    api = await import('../apps/api/src/server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('postgres')
    await persistence.members!.upsert({ workspaceId: fixture.workspaceId, externalSubject: 'image-commercial-merchant', displayName: 'isolated image commercial owner', role: 'merchant_admin', status: 'active', invitedBy: 'isolated-regression' })
    appPool = new Pool({ connectionString: fixture.databaseUrl, max: 2, connectionTimeoutMillis: 1_000 })
    await new Promise<void>((resolve, reject) => {
      if (api!.server.listening) return resolve()
      const timeout = setTimeout(() => reject(new Error('isolated API listen timeout')), 10_000)
      api!.server.once('listening', () => { clearTimeout(timeout); resolve() })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('isolated API did not bind')
    base = `http://127.0.0.1:${address.port}`
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    try { if (api?.server.listening) await new Promise<void>(resolve => api!.server.close(() => resolve())) } catch (error) { failures.push(error) }
    try { await persistence?.close?.() } catch (error) { failures.push(error) }
    try { await appPool?.end() } catch (error) { failures.push(error) }
    let disposal
    try { disposal = await fixture?.dispose() } catch (error) { failures.push(error) }
    if (disposal?.leftRunning.length) failures.push(new Error('isolated image commercial fixture disposal incomplete'))
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (disposal) console.log(JSON.stringify({ image_delivery_commercial_disposal: { runId: fixture?.runId, stopped: disposal.stopped.length, leftRunning: disposal.leftRunning.length, volumeDeleted: false } }))
    if (failures.length) throw new AggregateError(failures, 'charged image callback PG cleanup failed', { cause: failures[0] })
  }, 60_000)

  it('holds the image until a single real PG usage and both receipts settle, then delivers once', async () => {
    if (!fixture || !api || !persistence) throw new Error('isolated fixture not initialized')
    const product = api.service.importProduct({ workspaceId: fixture.workspaceId, platform: 'taobao', title: 'image settlement fixture', category: '服装', storeName: 'fixture', images: ['https://fixture.invalid/original.jpg'] })
    api.service.confirmProductFacts(fixture.workspaceId, product.id)
    await persistence.business!.save({ workspaceId: fixture.workspaceId, entityType: 'product', entityId: product.id, entityVersion: product.version ?? 1, payload: product as unknown as Record<string, unknown> })
    await persistence.creativePoints!.grant({ workspaceId: fixture.workspaceId, idempotencyKey: `image-grant:${fixture.runId}`, sourceType: 'test_fixture', sourceId: fixture.runId, points: 10, metadata: { fixture: 'image-delivery-commercial' } })
    await seedIsolatedEntitlement(fixture.workspaceId)
    const idempotencyKey = `image-${fixture.runId}`
    const actionKey = `image:${idempotencyKey}`
    const reserved = await persistence.creativePoints!.reserve({ workspaceId: fixture.workspaceId, actionKey, idempotencyKey: `commercial.reserve:${actionKey}`, points: 3, rateCardVersion: 'isolated-approved-rate-card' })
    const job = api.service.enqueueImageGeneration({ workspaceId: fixture.workspaceId, productId: product.id, idempotencyKey, imageMode: 'create', count: 1 })
    await persistence.persistSnapshotAndEvent!({ workspaceId: fixture.workspaceId, entityType: 'image_generation_job', entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown>, eventType: 'image.generation.requested', eventPayload: { job_id: job.id, workspace_id: fixture.workspaceId, product_id: product.id, intent_hash: job.intentHash, action_id: actionKey, run_key: actionKey, commercial_access_snapshot: { classification: 'POINT_CHARGED', reservation_id: reserved.value.id, rate_card_version: 'isolated-approved-rate-card' } } })
    const event = (await persistence.outbox!.listAggregateEvents(fixture.workspaceId, job.id, 100)).find(row => row.eventType === 'image.generation.requested')!
    const path = `/v1/internal/image-generation-jobs/${encodeURIComponent(job.id)}/execution`
    const claim = await signedPost(path, { operation: 'claim', event_id: event.id })
    expect(claim.status, JSON.stringify(claim.body)).toBe(200)
    const ownerToken = claim.body.data.execution.ownerToken as string
    // This fixture isolates the commercial delivery fence. Execution
    // authorization has its own PG/API suite; start the leased dispatch using
    // the same durable repository operation after claiming it through API.
    const reservedOperation = await signedPost(path, { operation: 'reserve_provider_operation', owner_token: ownerToken })
    expect(reservedOperation.status, JSON.stringify(reservedOperation.body)).toBe(200)
    await persistence.imageGenerationExecutions!.beginProviderDispatch({ workspaceId: fixture.workspaceId, jobId: job.id, ownerToken })
    const providerRequestId = `provider-${fixture.runId}`
    const started = await signedPost(path, { operation: 'provider_started', owner_token: ownerToken, provider_request_id: providerRequestId })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
    const callbackPath = `/v1/internal/image-generation-jobs/${encodeURIComponent(job.id)}/result`
    const callbackBody = { event_id: event.id, intent_hash: job.intentHash, owner_token: ownerToken, provider_request_id: providerRequestId, images: [png] }
    const blocked = await signedPost(callbackPath, callbackBody)
    expect(blocked.body.error?.code).toBe('IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING')
    expect((await scopedRead('SELECT id FROM model_usage_ledger WHERE workspace_id=$1 AND action_id=$2', [fixture.workspaceId, actionKey]))).toHaveLength(0)
    const observedAt = new Date().toISOString()
    const usage = await signedPost('/v1/internal/model-usage', { modality: 'image', model: 'fixture-image', actionId: actionKey, runKey: actionKey, providerRequestId, inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny: 0.5, observedAt })
    expect(usage.status, JSON.stringify(usage.body)).toBe(200)
    const workerUsage = { modality: 'image', model: 'fixture-image', input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    const workerCost = { currency: 'CNY', actual: 0.5 }
    const workerReceipt = { workspace_id: fixture.workspaceId, operation_id: reserved.value.operationId, provider: 'fixture-relay', provider_request_id: providerRequestId, outcome: 'succeeded', usage: workerUsage, cost: workerCost, verified_at: observedAt }
    await persistence.creativePointLifecycle!.recordProviderReceipt({ workspaceId: fixture.workspaceId, operationId: reserved.value.operationId, provider: 'fixture-relay', providerRequestId, outcome: 'succeeded', usage: workerUsage, cost: workerCost, receiptHash: createHash('sha256').update(JSON.stringify(workerReceipt)).digest('hex'), verifiedAt: observedAt, at: observedAt })
    const settled = await persistence.creativePointLifecycle!.verifyModelUsageDeliverySettlement({ workspaceId: fixture.workspaceId, reservationId: reserved.value.id, actionId: actionKey, providerRequestId, relayProvider: 'fixture-relay' })
    expect(settled).toBe(true)
    const accepted = await signedPost(callbackPath, callbackBody)
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.data?.candidate_count).toBe(1)
    const candidateAssetEvents = await scopedRead<{ asset_id: string }>(
      `SELECT payload->>'asset_id' AS asset_id FROM outbox_events
       WHERE workspace_id=$1 AND event_type LIKE 'asset.generated_%' AND payload->>'job_id'=$2`,
      [fixture.workspaceId, job.id],
    )
    expect(candidateAssetEvents).toHaveLength(1)
    const reservation = await persistence.creativePoints!.getReservation(fixture.workspaceId, reserved.value.id)
    const usages = await scopedRead<{ settlement_status: string; cost_cny: string }>('SELECT settlement_status,cost_cny FROM model_usage_ledger WHERE workspace_id=$1 AND action_id=$2', [fixture.workspaceId, actionKey])
    expect(reservation?.status).toBe('settled')
    expect(usages).toHaveLength(1)
    expect(usages[0]?.settlement_status).toBe('settled')
    expect(Number(usages[0]?.cost_cny)).toBe(0.5)
    const merchant = await fetch(`${base}/v1/image-generation-jobs/${encodeURIComponent(job.id)}`, { headers: { authorization: `Bearer ${merchantToken}`, 'x-workspace-id': fixture.workspaceId } }).then(response => response.json()) as Envelope
    expect(merchant.data?.outputs).toHaveLength(1)
    // Model a second API replica whose in-memory projection predates the
    // accepted callback. The result handler must refresh the durable snapshot
    // before deciding whether this delivery needs a new archive.
    const staleJob = structuredClone(api.service.getImageGenerationJob(fixture.workspaceId, job.id))
    staleJob.outputs = undefined
    staleJob.state = 'running'
    staleJob.archiveState = 'pending'
    staleJob.revision -= 1
    api.service.imageGenerationJobs.set(job.id, staleJob)
    const replay = await signedPost(callbackPath, callbackBody)
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(replay.body.data?.already_completed).toBe(true)
    const durableJob = await persistence.business!.get(fixture.workspaceId, 'image_generation_job', job.id)
    expect((durableJob.payload as { outputs?: unknown[] }).outputs).toHaveLength(1)
    expect((await scopedRead<{ asset_id: string }>(
      `SELECT payload->>'asset_id' AS asset_id FROM outbox_events
       WHERE workspace_id=$1 AND event_type LIKE 'asset.generated_%' AND payload->>'job_id'=$2`,
      [fixture.workspaceId, job.id],
    ))).toEqual(candidateAssetEvents)
    const mismatchedReplay = await signedPost(callbackPath, { ...callbackBody, provider_request_id: 'different-provider-request' })
    expect(mismatchedReplay.status).toBe(409)
    expect(mismatchedReplay.body.error?.code).toBe('IMAGE_GENERATION_CALLBACK_REPLAY_MISMATCH')
    expect((await scopedRead<{ count: number }>("SELECT count(*)::int AS count FROM creative_point_ledger_events WHERE workspace_id=$1 AND event_type='settled' AND metadata->>'reservation_id'=$2", [fixture.workspaceId, reserved.value.id]))[0]?.count).toBe(1)
  }, 120_000)
})
