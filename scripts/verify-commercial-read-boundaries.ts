import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { readOwnCommercialPaymentStatus } from '../apps/api/src/commercial-payment-status-reader.js'
import { PostgresCommercialContractRepository, type CommercialCatalogSkuSnapshot } from '../packages/persistence/src/index.js'
import { createIsolatedOpsFixture, isolatedFixtureSpawnEnvironment, type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'
import { validateCustomerDeliveryScanBindings } from './customer-delivery-scan-fixture.js'
import { opsChildEnvironment } from './run-ops-oidc-e2e.js'

// This executable owns a fresh tmpfs fixture. It never accepts a database URL,
// imports a .env, calls a payment gateway, starts a worker, or grants points.
// Pending orders and checkout URLs below are explicitly synthetic test seeds;
// PostgreSQL/RLS, the API, authentication, and native MCP transport are real.
const parent = resolve('artifacts/commercial-read-boundaries')
await mkdir(parent, { recursive: true, mode: 0o700 })
const evidenceDir = await mkdtemp(join(parent, 'run-'))
const observations: Record<string, unknown>[] = []
const interrupted = new AbortController()
const interrupt = () => interrupted.abort(new Error('COMMERCIAL_READ_VERIFY_INTERRUPTED'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
let fixture: IsolatedOpsFixture | undefined
let admin: Pool | undefined, seed: Pool | undefined, reader: Pool | undefined
let api: ChildProcess | undefined, apiError = false
let passed = false, stage = 'fixture', errorCode: string | undefined
let disposal: unknown, runtimeEvidence: unknown
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

async function reserveLoopbackPort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done) })
  const address = socket.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()))
  return address.port
}

async function stopApi(): Promise<boolean> {
  if (!api) return true
  if (api.exitCode !== null || api.signalCode !== null || apiError) return true
  const closed = new Promise<void>(done => api!.once('exit', () => done()))
  api.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5000) })]).finally(() => clearTimeout(timer))
  if (api.exitCode === null && api.signalCode === null) {
    api.kill('SIGKILL')
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5000) })]).finally(() => clearTimeout(timer))
  }
  return api.exitCode !== null || api.signalCode !== null
}

try {
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  interrupted.signal.throwIfAborted()
  const port = await reserveLoopbackPort()
  const baseUrl = `http://127.0.0.1:${port}`
  validateCustomerDeliveryScanBindings({ fixture, apiBaseUrl: baseUrl, apiPort: port })
  const appUrl = new URL(fixture.databaseUrl), adminUrl = new URL(fixture.adminDatabaseUrl)
  assert.equal(adminUrl.hostname, appUrl.hostname)
  assert.equal(adminUrl.port, appUrl.port)
  assert.equal(adminUrl.pathname, appUrl.pathname)
  assert.equal(adminUrl.username, 'merchant')
  assert(adminUrl.password && !adminUrl.search && !adminUrl.hash)
  const options = { max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000, query_timeout: 6000 }
  admin = new Pool({ ...options, connectionString: fixture.adminDatabaseUrl })
  seed = new Pool({ ...options, connectionString: fixture.databaseUrl })
  reader = new Pool({ ...options, connectionString: fixture.databaseUrl, options: '-c default_transaction_read_only=on' })
  const flags = (await reader.query(`SELECT current_user AS role,current_database() AS database,
    current_setting('default_transaction_read_only') AS read_only,rolsuper,rolbypassrls
    FROM pg_roles WHERE rolname=current_user`)).rows[0]
  assert.deepEqual(flags, { role: 'merchant_app', database: 'merchant', read_only: 'on', rolsuper: false, rolbypassrls: false })
  const workspaceId = fixture.workspaceId, otherWorkspaceId = `ws_commercial_read_${fixture.runId}`
  const creator = fixture.workspaceActorSubject, otherActor = `commercial-read-other-${fixture.runId}`
  const otherIdentity = randomUUID()
  await admin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [otherWorkspaceId])
  await admin.query('INSERT INTO platform_identities(id,issuer,external_subject,display_name) VALUES ($1,$2,$3,$4)', [otherIdentity, fixture.issuer, otherActor, 'Synthetic other merchant'])
  for (const [workspace, actor, identity] of [[workspaceId, otherActor, otherIdentity], [otherWorkspaceId, creator, fixture.subjectIdentityId]]) {
    await admin.query(`INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id)
      VALUES ($1,$2,$3,'Synthetic read-boundary merchant','merchant_admin','active','isolated-commercial-read-seed',$4)`, [randomUUID(), workspace, actor, identity])
  }
  const sku: CommercialCatalogSkuSnapshot = {
    id: `sku_read_${fixture.runId}`, code: `read_${fixture.runId.replaceAll('-', '')}`, kind: 'monthly', visibility: 'public', requiredCapability: null,
    versionId: `skuv_read_${fixture.runId}`, version: 1, lifecycle: 'approved', executable: true,
    priceFen: 12345, currency: 'CNY', priceMode: 'fixed', durationDays: null,
    payload: { blockers: [], synthetic_read_boundary_seed: true }, checksum: 'a'.repeat(64),
    effectiveAt: new Date(Date.now() - 60_000).toISOString(), benefits: [],
  }
  stage = 'synthetic-pending-orders'
  await admin.query("INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')", [sku.id, sku.code])
  await admin.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at)
    VALUES ($1,$2,1,'approved',true,$3,'CNY','fixed',$4::jsonb,$5,$6)`, [sku.versionId, sku.id, sku.priceFen, JSON.stringify(sku.payload), sku.checksum, sku.effectiveAt])
  const seedRepository = new PostgresCommercialContractRepository(seed)
  const repository = new PostgresCommercialContractRepository(reader)
  const newOrder = (workspace: string, actor: string, key: string) => seedRepository.createOrder({ workspaceId: workspace, sku,
    paymentProvider: 'alipay', createdByActorId: actor, idempotencyKey: key, reason: 'synthetic isolated read-boundary seed; no payment requested' })
  const own = await newOrder(workspaceId, creator, 'own')
  const others = await newOrder(workspaceId, otherActor, 'other')
  const cross = await newOrder(otherWorkspaceId, creator, 'cross')
  const checkout = `https://payments.invalid/synthetic/${fixture.runId}?secret=synthetic-checkout-only`
  const providerOrderId = `synthetic-provider-order-${fixture.runId}`
  await seedRepository.attachCheckout({ workspaceId, orderId: own.id, channel: 'alipay', idempotencyKey: 'synthetic-checkout',
    paymentUrl: checkout, providerOrderId, expiresAt: new Date(Date.now() + 900_000).toISOString() })
  const blankId = `cor_blank_${fixture.runId}`, nullId = `cor_null_${fixture.runId}`
  const clone = (id: string, actor: string | null) => admin!.query(`INSERT INTO commercial_orders_v2
    (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,checkout_url)
    SELECT $3,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,'pending',$3,request_hash,$4,checkout_url
    FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2`, [workspaceId, own.id, id, actor])
  await clone(blankId, '')
  await admin.query(`INSERT INTO commercial_order_snapshots_v2(id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum)
    SELECT $3,workspace_id,$4,sku_id,sku_version_id,catalog_checksum,snapshot,checksum FROM commercial_order_snapshots_v2
    WHERE workspace_id=$1 AND order_id=$2`, [workspaceId, own.id, `cos_blank_${fixture.runId}`, blankId])
  await assert.rejects(clone(nullId, null), { code: '23502' })
  observations.push({ surface: 'postgres-schema', case: 'null-creator', result: 'insert-rejected', sqlState: '23502', schemaNotWeakened: true })
  const workspaceIds = [workspaceId, otherWorkspaceId]
  const immutableState = async () => (await admin!.query(`SELECT
    (SELECT md5(COALESCE(jsonb_agg(to_jsonb(o) ORDER BY workspace_id,id)::text,'[]')) FROM commercial_orders_v2 o WHERE workspace_id=ANY($1::text[])) AS orders,
    (SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY workspace_id,id)::text,'[]')) FROM commercial_order_snapshots_v2 s WHERE workspace_id=ANY($1::text[])) AS snapshots`, [workspaceIds])).rows[0]
  const stateBefore = await immutableState()
  stage = 'real-postgres-reader'
  const ownStatus = await readOwnCommercialPaymentStatus(repository, { workspaceId, orderId: own.id, actorId: creator })
  assert.equal(ownStatus?.order.checkoutUrl, checkout)
  assert.equal(ownStatus?.order.providerOrderId, providerOrderId)
  assert.equal(ownStatus?.order.amountFen, 12345)
  assert.equal(ownStatus?.skuCode, sku.code)
  assert.equal(ownStatus?.accessRevision, null)
  observations.push({ surface: 'postgres-reader', case: 'creator', result: 'allowed', syntheticCheckoutRecovered: true })
  const denied = [
    { name: 'same-workspace-other-actor', workspaceId, orderId: own.id, actorId: otherActor },
    { name: 'other-actor-order', workspaceId, orderId: others.id, actorId: creator },
    { name: 'cross-workspace-order', workspaceId, orderId: cross.id, actorId: creator },
    { name: 'wrong-workspace', workspaceId: otherWorkspaceId, orderId: own.id, actorId: creator },
    { name: 'wrong-id', workspaceId, orderId: `missing_${fixture.runId}`, actorId: creator },
    { name: 'missing-actor', workspaceId, orderId: own.id },
    { name: 'null-actor', workspaceId, orderId: own.id, actorId: null },
    { name: 'empty-actor', workspaceId, orderId: own.id, actorId: '' },
    { name: 'whitespace-actor', workspaceId, orderId: own.id, actorId: ` ${creator} ` },
    { name: 'blank-persisted-creator', workspaceId, orderId: blankId, actorId: creator },
    { name: 'null-creator-not-stored', workspaceId, orderId: nullId, actorId: creator },
  ]
  for (const test of denied) {
    assert.equal(await readOwnCommercialPaymentStatus(repository, test), null)
    observations.push({ surface: 'postgres-reader', case: test.name, result: 'denied', checkoutDisclosed: false })
  }
  assert.deepEqual(await immutableState(), stateBefore)
  const rls = await reader.connect()
  try {
    await rls.query('BEGIN READ ONLY')
    await rls.query("SELECT set_config('app.workspace_id',$1,true)", [otherWorkspaceId])
    assert.equal((await rls.query('SELECT id FROM commercial_orders_v2 WHERE id=$1', [own.id])).rowCount, 0)
    await rls.query('COMMIT')
  } finally { await rls.query('ROLLBACK').catch(() => undefined); rls.release() }
  observations.push({ surface: 'postgres-rls', case: 'cross-workspace-without-explicit-workspace-predicate', result: 'hidden' })

  stage = 'real-api-startup'
  interrupted.signal.throwIfAborted()
  const oidcSecret = randomBytes(32).toString('hex')
  const environment = opsChildEnvironment(isolatedFixtureSpawnEnvironment(), {
    NODE_ENV: 'development', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres', PORT: String(port), API_BIND_HOST: '127.0.0.1',
    OPS_AUTH_MODE: 'oidc', OIDC_PROXY_SIGNING_SECRET: oidcSecret, SESSION_ID_HASH_SECRET: randomBytes(32).toString('hex'),
    DATABASE_URL: fixture.databaseUrl, OPS_DATABASE_URL: fixture.opsDatabaseUrl, REDIS_URL: fixture.redisUrl,
    RUN_MIGRATIONS_ON_STARTUP: 'false', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
    CONNECTOR_FIXTURE_MODE: 'false', REQUEST_OBSERVABILITY_LOGS: 'false', ASSET_STORAGE_ROOT: join(evidenceDir, 'local-objects'),
  })
  // Do not collect raw API logs: bounded chunks can bisect credentials before
  // redaction. Responses are asserted in memory; evidence stores safe facts.
  api = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], { env: environment, stdio: 'ignore' })
  api.once('error', () => { apiError = true })
  const deadline = Date.now() + 60_000
  let health: any
  while (Date.now() < deadline) {
    interrupted.signal.throwIfAborted()
    assert(!apiError && api.exitCode === null && api.signalCode === null, 'isolated API exited before readiness')
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
      if (response.ok) { health = await response.json(); break }
    } catch { /* bounded readiness polling */ }
    await new Promise(done => setTimeout(done, 250))
  }
  assert.equal(health?.data?.persistence?.mode, 'postgres')
  assert.equal(health?.data?.persistence?.ready, true)
  assert.equal(health?.data?.redis?.ready, true)
  runtimeEvidence = { runId: fixture.runId, postgres: 'real-17', redis: 'ready', api: 'loopback-real-server',
    auth: 'strict-signed-oidc', authorization: 'enforce-durable', role: flags, sharedContainersTouched: false }
  const sessions = new Map<string, string>()
  const authTime = String(Math.floor(Date.now() / 1000) - 1), expires = String(Number(authTime) + 900)
  const call = async (surface: 'http' | 'mcp', test: { workspaceId: string; orderId: string; actorId?: string | null }) => {
    interrupted.signal.throwIfAborted()
    const method = surface === 'http' ? 'GET' : 'POST'
    const target = surface === 'http' ? `/v1/commercial/orders/${encodeURIComponent(test.orderId)}/payment` : '/mcp'
    const nonce = randomUUID(), timestamp = String(Math.floor(Date.now() / 1000))
    const body = surface === 'http' ? '' : JSON.stringify({ jsonrpc: '2.0', id: nonce, method: 'tools/call', params: {
      name: 'commercial.order.payment.get', arguments: { order_id: test.orderId },
    } })
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-workspace-id': test.workspaceId }
    if (test.actorId) {
      const sid = sessions.get(test.actorId) ?? randomBytes(24).toString('base64url'); sessions.set(test.actorId, sid)
      const digest = hash(body), roles = 'merchant_admin', amr = 'mfa,pwd'
      const canonical = [method, target, test.workspaceId, 'workspace', fixture!.issuer, test.actorId, sid, roles, amr,
        authTime, expires, timestamp, digest, nonce].join('\n')
      Object.assign(headers, { 'x-oidc-workbench': 'workspace', 'x-oidc-workspace': test.workspaceId, 'x-oidc-issuer': fixture!.issuer,
        'x-oidc-sub': test.actorId, 'x-oidc-sid': sid, 'x-oidc-roles': roles, 'x-oidc-amr': amr,
        'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': expires, 'x-oidc-timestamp': timestamp,
        'x-oidc-body-sha256': digest, 'x-oidc-nonce': nonce, 'x-oidc-signature': createHmac('sha256', oidcSecret).update(canonical).digest('hex') })
    }
    const response = await fetch(`${baseUrl}${target}`, { method, headers, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(10_000) })
    return { status: response.status, body: await response.json() as any }
  }
  for (const surface of ['http', 'mcp'] as const) {
    stage = `${surface}-creator`
    const result = await call(surface, { workspaceId, orderId: own.id, actorId: creator })
    const data = surface === 'http' ? result.body.data : result.body.result?.structuredContent
    assert.equal(result.status, 200)
    assert.equal(data?.order_id, own.id)
    assert.equal(data?.payment_url, checkout)
    assert.equal(data?.provider_order_id, providerOrderId)
    assert.equal(data?.status, 'pending')
    if (surface === 'mcp') assert.deepEqual(JSON.parse(result.body.result.content[0].text), data)
    observations.push({ surface, case: 'creator', result: 'allowed', status: result.status, syntheticCheckoutRecovered: true })
    for (const test of denied.filter(test => !['null-actor', 'empty-actor', 'whitespace-actor'].includes(test.name))) {
      stage = `${surface}-${test.name}`
      const result = await call(surface, test)
      const code = surface === 'mcp' && result.status === 200 ? result.body.error?.data?.code : result.body.error?.code
      if (test.actorId) {
        assert.equal(result.status, surface === 'http' ? 404 : 200)
        assert.equal(code, 'COMMERCIAL_ORDER_NOT_FOUND')
      } else assert.equal(result.status, 401)
      assert(!result.body.result && !result.body.data)
      const serialized = JSON.stringify(result.body)
      assert(!serialized.includes(checkout) && !serialized.includes(providerOrderId))
      observations.push({ surface, case: test.name, result: 'denied', status: result.status, code, checkoutDisclosed: false })
    }
  }
  stage = 'read-only-commercial-state'
  assert.deepEqual(await immutableState(), stateBefore)
  const totals = (await admin.query(`SELECT
    (SELECT count(*)::integer FROM commercial_payment_events_v2 WHERE workspace_id=ANY($1::text[])) AS payment_events,
    (SELECT count(*)::integer FROM creative_point_grants WHERE workspace_id=ANY($1::text[])) AS point_grants,
    (SELECT count(*)::integer FROM creative_point_operations WHERE workspace_id=ANY($1::text[])) AS point_operations,
    (SELECT count(*)::integer FROM creative_point_ledger_events WHERE workspace_id=ANY($1::text[])) AS point_ledger_events`, [workspaceIds])).rows[0]
  assert.deepEqual(totals, { payment_events: 0, point_grants: 0, point_operations: 0, point_ledger_events: 0 })
  observations.push({ surface: 'postgres-after-http-and-mcp', commercialOrdersAndSnapshotsUnchanged: true, ...totals })
  passed = true
} catch (error) {
  // Do not expose native assertions (which may contain response/checkout URLs),
  // connection strings, generated OIDC secrets, or raw child-process errors.
  const code = (error as { code?: unknown })?.code
  errorCode = typeof code === 'string' && /^[A-Z0-9_]{2,80}$/u.test(code) ? code : 'COMMERCIAL_READ_RUNTIME_ASSERTION_FAILED'
} finally {
  try { if (!await stopApi()) { passed = false; errorCode = 'COMMERCIAL_READ_API_CLEANUP_UNCONFIRMED' } }
  catch { passed = false; errorCode = 'COMMERCIAL_READ_API_CLEANUP_FAILED' }
  await Promise.allSettled([reader?.end(), seed?.end(), admin?.end()])
  if (fixture) {
    try {
      disposal = await fixture.dispose()
      if ((disposal as { leftRunning: unknown[] }).leftRunning.length) { passed = false; errorCode = 'COMMERCIAL_READ_FIXTURE_CLEANUP_UNCONFIRMED' }
    } catch { passed = false; errorCode = 'COMMERCIAL_READ_FIXTURE_CLEANUP_FAILED' }
  }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
  await writeFile(join(evidenceDir, 'api-process.json'), JSON.stringify({ launched: Boolean(api), launchFailed: apiError,
    exitCode: api?.exitCode ?? null, signalCode: api?.signalCode ?? null, rawLogsCollected: false }, null, 2), { mode: 0o600, flag: 'wx' })
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ status: passed ? 'passed' : 'failed', stage, errorCode,
    at: new Date().toISOString(), evidenceDir, runtime: runtimeEvidence, syntheticCommercialSeed: true, realPaymentsCalled: false,
    modelCalls: 0, sharedContainersTouched: false, nullCreatorScope: 'Real PostgreSQL NOT NULL constraint rejects storage; schema unchanged; no fabricated NULL repository result.',
    observations, disposal }, null, 2), { mode: 0o600, flag: 'wx' })
}
console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', stage, errorCode, observations, evidenceDir }, null, 2))
process.exitCode = passed ? 0 : 1
