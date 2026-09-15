/** Real HTTP + isolated PostgreSQL/Redis acceptance. No real payment/model calls.
 * Run: node --import tsx scripts/verify-payment-reconciliation.ts
 * No environment URLs, credentials, Docker contexts, or shared services are reused.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import { createClient } from 'redis'
import type { PaymentRefundStatusResult, PaymentStatusResult } from '../packages/billing/src/payment-provider.js'
import { PostgresBillingRepository } from '../packages/persistence/src/billing-repository.js'
import { PostgresOutboxRepository } from '../packages/persistence/src/repository.js'
import { createWorkerRequestProof, type WorkerRequestRole } from '../packages/security/src/worker-request-proof.js'
import { createIsolatedOpsFixture, type IsolatedFixtureDisposal, type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptFile = fileURLToPath(import.meta.url)
const route = '/v1/internal/billing/reconciliation'
const sourceFiles = [
  'apps/api/src/server.ts', 'apps/worker/src/main.ts',
  'packages/persistence/src/billing-repository.ts', 'packages/persistence/src/repository.ts',
  'packages/billing/src/payment-provider.ts', 'packages/security/src/worker-request-proof.ts',
  'tests/isolated-ops-fixture.ts', 'scripts/verify-payment-reconciliation.ts', 'release-metadata.json',
]
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const fingerprint = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(join(projectRoot, file)))])))
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
type Envelope = { data?: Record<string, unknown>; error?: { code?: string } | null }

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise })
  return { promise, release }
}
type Gate = { entered: ReturnType<typeof deferred>; completion: ReturnType<typeof deferred> }
type ProviderPlan = { response: PaymentStatusResult | PaymentRefundStatusResult; gate?: Gate; refundRequestId?: string }

function assertOwnBindings(fixture: IsolatedOpsFixture) {
  const postgres = fixture.containerEvidence.find(item => item.kind === 'postgres')
  const redis = fixture.containerEvidence.find(item => item.kind === 'redis')
  assert(postgres && redis && fixture.containerEvidence.length === 2, 'VERIFY_PAYMENT_FIXTURE_CONTAINER_MISMATCH')
  for (const [value, role] of [[fixture.databaseUrl, 'merchant_app'], [fixture.opsDatabaseUrl, 'merchant_ops'], [fixture.adminDatabaseUrl, 'merchant']] as const) {
    const url = new URL(value)
    assert(url.protocol === 'postgres:' && url.hostname === '127.0.0.1' && url.username === role && url.password
      && url.pathname === '/merchant' && !url.search && !url.hash && Number(url.port) === postgres.hostPort
      && postgres.runId === fixture.runId, 'VERIFY_PAYMENT_DATABASE_BINDING_MISMATCH')
  }
  const url = new URL(fixture.redisUrl)
  assert(url.protocol === 'redis:' && url.hostname === '127.0.0.1' && url.password && url.pathname === '/0'
    && !url.search && !url.hash && Number(url.port) === redis.hostPort && redis.runId === fixture.runId, 'VERIFY_PAYMENT_REDIS_BINDING_MISMATCH')
}

// This child starts the real API normally; the only replaced boundary is the
// external payment provider. Its responses travel over a fresh localhost socket.
async function apiChild() {
  assert(process.send && process.env.VERIFY_PAYMENT_CHILD === 'isolated-fixture', 'VERIFY_PAYMENT_CHILD_NOT_OWNED')
  const stubUrl = new URL(process.env.VERIFY_PAYMENT_STUB_URL ?? '')
  assert(stubUrl.protocol === 'http:' && stubUrl.hostname === '127.0.0.1' && stubUrl.port && !stubUrl.username && !stubUrl.password, 'VERIFY_PAYMENT_STUB_BINDING_INVALID')
  const call = async (path: string, input: unknown) => {
    const response = await fetch(new URL(path, stubUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VERIFY_PAYMENT_STUB_TOKEN}` },
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    assert(response.ok, 'VERIFY_PAYMENT_STUB_REQUEST_FAILED')
    return response.json()
  }
  const api = await import('../apps/api/src/server.js')
  api.setPaymentProviderForTests({
    createCheckout: async () => { throw new Error('VERIFY_PAYMENT_UNEXPECTED_CHECKOUT') },
    refund: async () => { throw new Error('VERIFY_PAYMENT_UNEXPECTED_REFUND_DISPATCH') },
    queryStatus: async input => await call('/status', input) as PaymentStatusResult,
    queryRefundStatus: async input => await call('/refund-status', input) as PaymentRefundStatusResult,
  })
  await api.persistenceReady
  if (!api.server.listening) await once(api.server, 'listening')
  const address = api.server.address()
  assert(address && typeof address !== 'string' && address.address === '127.0.0.1', 'VERIFY_PAYMENT_API_BINDING_INVALID')
  process.send!({ kind: 'ready', port: address.port })
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([closed, new Promise<void>(resolveTimer => { timer = setTimeout(resolveTimer, 4_000) })])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
  } finally { if (timer) clearTimeout(timer) }
}

async function main() {
  assert(process.argv.length === 2, 'VERIFY_PAYMENT_ARGUMENTS_NOT_SUPPORTED')
  const parent = join(projectRoot, 'artifacts/payment-reconciliation')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidenceDir = await mkdtemp(join(parent, 'run-'))
  const startedAt = new Date().toISOString()
  const before = await fingerprint()
  const abort = new AbortController()
  const interrupt = () => abort.abort(new Error('VERIFY_PAYMENT_INTERRUPTED'))
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let fixture: IsolatedOpsFixture | undefined
  let pool: Pool | undefined
  let appPool: Pool | undefined
  let redis: ReturnType<typeof createClient> | undefined
  let child: ChildProcess | undefined
  let disposal: IsolatedFixtureDisposal | undefined
  const checks: Record<string, unknown>[] = []
  const errors: string[] = []
  const plans = new Map<string, ProviderPlan>()
  const calls: { kind: string; workspaceId: string; orderId: string; refundRequestId?: string }[] = []
  const gates: Gate[] = []
  const stubToken = randomBytes(32).toString('hex')
  const credentials = {
    reconcile: { token: randomBytes(32).toString('hex'), signing_secret: randomBytes(32).toString('hex') },
    generation: { token: randomBytes(32).toString('hex'), signing_secret: randomBytes(32).toString('hex') },
  }
  const stub = createServer((req, res) => {
    void (async () => {
      assert(req.method === 'POST' && req.headers.authorization === `Bearer ${stubToken}`, 'VERIFY_PAYMENT_STUB_UNAUTHORIZED')
      assert(req.url === '/status' || req.url === '/refund-status', 'VERIFY_PAYMENT_STUB_PATH_INVALID')
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; assert(size <= 16_384, 'VERIFY_PAYMENT_STUB_BODY_TOO_LARGE'); chunks.push(data) }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert(object(input) && typeof input.workspaceId === 'string' && typeof input.orderId === 'string', 'VERIFY_PAYMENT_STUB_INPUT_INVALID')
      const plan = plans.get(`${req.url}:${input.workspaceId}:${input.orderId}`)
      assert(plan, 'VERIFY_PAYMENT_UNPLANNED_PROVIDER_QUERY')
      if (plan.refundRequestId) assert.equal(input.refundRequestId, plan.refundRequestId, 'VERIFY_PAYMENT_REFUND_REQUEST_ID_MISMATCH')
      calls.push({ kind: req.url.slice(1), workspaceId: input.workspaceId, orderId: input.orderId, ...(typeof input.refundRequestId === 'string' ? { refundRequestId: input.refundRequestId } : {}) })
      if (plan.gate) { plan.gate.entered.release(); await plan.gate.completion.promise }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(plan.response))
    })().catch(() => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"fixture provider rejected request"}') })
  })
  let stage = 'fixture_setup'
  try {
    fixture = await createIsolatedOpsFixture({ evidenceDir }); assertOwnBindings(fixture); abort.signal.throwIfAborted()
    pool = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 2, connectionTimeoutMillis: 1_000 })
    appPool = new Pool({ connectionString: fixture.databaseUrl, max: 2, connectionTimeoutMillis: 1_000 })
    redis = createClient({ url: fixture.redisUrl, socket: { reconnectStrategy: false, connectTimeout: 2_000 } })
    redis.on('error', () => undefined)
    await redis.connect()
    await new Promise<void>((resolveListen, reject) => { stub.once('error', reject); stub.listen(0, '127.0.0.1', resolveListen) })
    const stubAddress = stub.address(); assert(stubAddress && typeof stubAddress !== 'string', 'VERIFY_PAYMENT_STUB_BIND_FAILED')
    const wsA = fixture.workspaceId
    const wsB = `ws_payment_b_${fixture.runId.replaceAll('-', '')}`
    const wsConcurrent = `ws_payment_c_${fixture.runId.replaceAll('-', '')}`
    const wsLost = `ws_payment_d_${fixture.runId.replaceAll('-', '')}`
    for (const workspace of [wsB, wsConcurrent, wsLost]) await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [workspace])
    const seed = async (workspace: string, id: string, amount: number, hold?: 'succeeded' | 'failed' | 'unknown') => {
      await pool!.query("INSERT INTO billing_orders (id,workspace_id,channel,amount_fen,state,payment_mode,idempotency_key,provider_trade_id) VALUES ($1,$2,'alipay',$3,$4,'provider',$5,$6)", [id, workspace, amount, hold ? 'paid' : 'pending', `verify:${id}`, hold ? `fixture-trade:${id}` : null])
      if (hold) {
        await pool!.query("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,'recharge',$3,$4,'fixture-seed','Synthetic paid order')", [`credit_${id}`, workspace, amount, id])
        await pool!.query("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,'debit',$3,$4,'fixture-seed','Synthetic unresolved provider refund hold')", [`hold_${id}`, workspace, amount, `recharge-refund:${id}:1`])
        plans.set(`/refund-status:${workspace}:${id}`, { response: { state: hold, amountFen: amount, ...(hold === 'succeeded' ? { providerRefundId: `fixture-refund:${id}` } : {}) }, refundRequestId: `hold_${id}` })
      } else plans.set(`/status:${workspace}:${id}`, { response: { state: 'paid', amountFen: amount, providerTradeId: `fixture-trade:${id}` } })
    }
    await seed(wsA, 'payment_a', 10_000)
    await seed(wsB, 'payment_b', 12_000)
    await seed(wsA, 'refund_success', 7_000, 'succeeded')
    await seed(wsA, 'refund_failed', 5_000, 'failed')
    await seed(wsA, 'refund_unknown', 3_000, 'unknown')
    const snapshot = async (workspace: string) => {
      const orders = (await pool!.query('SELECT id,state,amount_fen::text,provider_trade_id FROM billing_orders WHERE workspace_id=$1 ORDER BY id', [workspace])).rows
      const ledger = (await pool!.query('SELECT id,type,amount_fen::text,order_id FROM billing_transactions WHERE workspace_id=$1 ORDER BY id', [workspace])).rows
      const balance = Number((await pool!.query("SELECT COALESCE(SUM(CASE WHEN type='debit' THEN -amount_fen ELSE amount_fen END),0)::text AS value FROM billing_transactions WHERE workspace_id=$1", [workspace])).rows[0]?.value)
      return { orders, ledger, balanceFen: balance }
    }
    const initialA = await snapshot(wsA); const initialB = await snapshot(wsB)
    assert.equal(initialA.balanceFen, 0, 'VERIFY_PAYMENT_INITIAL_BALANCE_INVALID')
    stage = 'api_startup'
    const environment: NodeJS.ProcessEnv = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8',
      NODE_ENV: 'development', VITEST: 'true', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres',
      PORT: '0', API_BIND_HOST: '127.0.0.1', DATABASE_URL: fixture.databaseUrl, OPS_DATABASE_URL: fixture.opsDatabaseUrl,
      REDIS_URL: fixture.redisUrl, RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false',
      SESSION_ID_HASH_SECRET: randomBytes(32).toString('hex'), REQUEST_OBSERVABILITY_LOGS: 'false',
      WORKER_API_CREDENTIALS: JSON.stringify(credentials), PAYMENT_RECONCILIATION_ENABLED: 'true',
      ASSET_STORAGE_ROOT: join(evidenceDir, 'local-objects'), MCP_AUTHZ_MODE: 'enforce',
      VERIFY_PAYMENT_CHILD: 'isolated-fixture', VERIFY_PAYMENT_STUB_URL: `http://127.0.0.1:${stubAddress.port}`,
      VERIFY_PAYMENT_STUB_TOKEN: stubToken,
    }
    child = spawn(process.execPath, ['--import', 'tsx', scriptFile, '--api-child'], { cwd: projectRoot, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const apiPort = await new Promise<number>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('VERIFY_PAYMENT_API_STARTUP_TIMEOUT')), 60_000)
      child!.once('error', () => { clearTimeout(timer); reject(new Error('VERIFY_PAYMENT_API_SPAWN_FAILED')) })
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('VERIFY_PAYMENT_API_EXITED')) })
      child!.on('message', message => {
        if (object(message) && message.kind === 'ready' && Number.isInteger(message.port) && Number(message.port) > 0 && Number(message.port) <= 65535) { clearTimeout(timer); resolveReady(Number(message.port)) }
      })
    })
    const base = `http://127.0.0.1:${apiPort}`
    const post = async (workspace: string, options: { bodyWorkspace?: string; limit?: unknown; unsigned?: boolean; role?: WorkerRequestRole } = {}) => {
      const body = JSON.stringify({ workspace_id: options.bodyWorkspace ?? workspace, limit: options.limit ?? 10 })
      const role = options.role === 'generation' ? 'generation' : 'reconcile'
      const credential = credentials[role]
      const proof = createWorkerRequestProof({ secret: credential.signing_secret, workerId: 'isolated-payment-reconcile', role, method: 'POST', requestTarget: route, workspaceId: workspace, body })
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}`, 'x-workspace-id': workspace, ...(!options.unsigned ? proof.headers : {}) }, body, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]) })
      const envelope = await response.json() as Envelope
      checks.push({ stage, status: response.status, body: envelope })
      return { status: response.status, envelope }
    }
    stage = 'signed_worker_boundary'
    assert.equal((await post(wsA, { unsigned: true })).status, 403, 'VERIFY_PAYMENT_UNSIGNED_ACCEPTED')
    assert.equal((await post(wsA, { role: 'generation' })).status, 403, 'VERIFY_PAYMENT_WRONG_ROLE_ACCEPTED')
    const cross = await post(wsA, { bodyWorkspace: wsB })
    assert.equal(cross.status, 403, 'VERIFY_PAYMENT_CROSS_TENANT_ACCEPTED')
    assert.equal(cross.envelope.error?.code, 'TENANT_SCOPE_DENIED', 'VERIFY_PAYMENT_CROSS_TENANT_CODE_INVALID')
    for (const limit of [true, [1], 0, 21]) assert.equal((await post(wsA, { limit })).status, 400, 'VERIFY_PAYMENT_INVALID_LIMIT_ACCEPTED')
    assert.equal(calls.length, 0, 'VERIFY_PAYMENT_DENIED_REQUEST_CALLED_PROVIDER')
    assert.deepEqual(await snapshot(wsA), initialA, 'VERIFY_PAYMENT_DENIED_REQUEST_CHANGED_LEDGER')
    stage = 'settlement_and_refund_idempotency'
    const settled = await post(wsA)
    assert.equal(settled.status, 200, 'VERIFY_PAYMENT_SETTLEMENT_HTTP_FAILED')
    assert.equal(settled.envelope.data?.state, 'attention_required', 'VERIFY_PAYMENT_PENDING_REFUND_HIDDEN')
    assert.equal(settled.envelope.data?.checked, 4, 'VERIFY_PAYMENT_QUERY_COUNT_INVALID')
    const afterA = await snapshot(wsA)
    assert.equal(afterA.balanceFen, 15_000, 'VERIFY_PAYMENT_BALANCE_MISMATCH')
    assert.equal(afterA.ledger.filter(row => row.order_id === 'payment_a' && row.type === 'recharge').length, 1, 'VERIFY_PAYMENT_SETTLEMENT_NOT_ONCE')
    assert.equal(afterA.ledger.filter(row => row.order_id === 'release:recharge-refund:refund_failed:1').length, 1, 'VERIFY_PAYMENT_REFUND_RELEASE_NOT_ONCE')
    assert.equal(afterA.ledger.filter(row => row.order_id === 'release:recharge-refund:refund_unknown:1').length, 0, 'VERIFY_PAYMENT_UNKNOWN_REFUND_RELEASED')
    assert.equal(afterA.orders.find(row => row.id === 'refund_success')?.state, 'closed', 'VERIFY_PAYMENT_REFUND_NOT_COMPLETED')
    assert.equal((await post(wsA)).status, 200, 'VERIFY_PAYMENT_REPLAY_HTTP_FAILED')
    assert.deepEqual(await snapshot(wsA), afterA, 'VERIFY_PAYMENT_REPLAY_CHANGED_LEDGER')
    assert.deepEqual(await snapshot(wsB), initialB, 'VERIFY_PAYMENT_OTHER_TENANT_CHANGED')
    assert(!calls.some(call => call.workspaceId === wsB), 'VERIFY_PAYMENT_OTHER_TENANT_QUERIED')
    checks.push({ stage, initial: initialA, final: afterA, otherTenantUnchanged: true, refundHolds: 'synthetic-seeded-not-refund-dispatch-proof' })
    const makeGate = () => { const gate = { entered: deferred(), completion: deferred() }; gates.push(gate); return gate }
    const waitEntered = async (gate: Gate) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([gate.entered.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('VERIFY_PAYMENT_PROVIDER_NOT_REACHED')), 15_000) })]) } finally { if (timer) clearTimeout(timer) }
    }
    stage = 'limit_one_oldest_queue_fairness'
    const wsLimitOne = `ws_limit_one_${fixture.runId.replaceAll('-', '')}`
    await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [wsLimitOne])
    await seed(wsLimitOne, 'limit_refund', 1_000, 'unknown')
    await seed(wsLimitOne, 'limit_payment', 1_000)
    plans.set(`/status:${wsLimitOne}:limit_payment`, { response: { state: 'pending' } })
    const limitOneBefore = await snapshot(wsLimitOne)
    const limitOneCallStart = calls.length
    const firstLimitOne = await post(wsLimitOne, { limit: 1 })
    const secondLimitOne = await post(wsLimitOne, { limit: 1 })
    const limitOneCalls = calls.slice(limitOneCallStart)
    const limitOneAfter = await snapshot(wsLimitOne)
    checks.push({ stage, first: firstLimitOne, second: secondLimitOne, providerCalls: limitOneCalls, before: limitOneBefore, after: limitOneAfter })
    assert.equal(firstLimitOne.status, 200, 'VERIFY_PAYMENT_LIMIT_ONE_FIRST_HTTP_FAILED')
    assert.equal(secondLimitOne.status, 200, 'VERIFY_PAYMENT_LIMIT_ONE_SECOND_HTTP_FAILED')
    assert.equal(firstLimitOne.envelope.data?.refund_checked, 1, 'VERIFY_PAYMENT_LIMIT_ONE_REFUND_NOT_FIRST')
    assert.equal(firstLimitOne.envelope.data?.payment_checked, 0, 'VERIFY_PAYMENT_LIMIT_ONE_PAYMENT_CHECKED_TOO_EARLY')
    assert.equal(firstLimitOne.envelope.data?.deferred, 1, 'VERIFY_PAYMENT_LIMIT_ONE_DEFERRED_MISSING')
    assert.equal(secondLimitOne.envelope.data?.payment_checked, 1, 'VERIFY_PAYMENT_LIMIT_ONE_PAYMENT_STARVED')
    assert.equal(secondLimitOne.envelope.data?.refund_checked, 0, 'VERIFY_PAYMENT_LIMIT_ONE_REFUND_RECHECKED')
    assert.deepEqual(limitOneCalls.map(call => `${call.kind}:${call.orderId}`), ['refund-status:limit_refund', 'status:limit_payment'], 'VERIFY_PAYMENT_LIMIT_ONE_PROVIDER_ORDER_INVALID')
    assert.equal(limitOneAfter.balanceFen, limitOneBefore.balanceFen, 'VERIFY_PAYMENT_LIMIT_ONE_BALANCE_CHANGED')
    assert.deepEqual(limitOneAfter.ledger, limitOneBefore.ledger, 'VERIFY_PAYMENT_LIMIT_ONE_LEDGER_CHANGED')
    stage = 'concurrent_repo_refund_completion_during_failed_query'
    const wsRepoComplete = `ws_repo_complete_${fixture.runId.replaceAll('-', '')}`
    const repoCompleteOrder = 'repo_complete_refund'
    await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [wsRepoComplete])
    await seed(wsRepoComplete, repoCompleteOrder, 1_300, 'unknown')
    const repoCompleteBefore = await snapshot(wsRepoComplete)
    const repoCompleteGate = makeGate()
    plans.set(`/refund-status:${wsRepoComplete}:${repoCompleteOrder}`, { response: { state: 'failed', providerRefundId: 'fixture-failed-after-repo-complete', amountFen: 1_300 }, refundRequestId: `hold_${repoCompleteOrder}`, gate: repoCompleteGate })
    const repoCompleteRun = post(wsRepoComplete)
    void repoCompleteRun.catch(() => undefined)
    await waitEntered(repoCompleteGate)
    const outbox = new PostgresOutboxRepository(appPool!)
    const billing = new PostgresBillingRepository(appPool!, (client, event) => outbox.appendInTransaction(client, event))
    await billing.completeRechargeRefund({ workspaceId: wsRepoComplete, orderId: repoCompleteOrder, reservationKey: `recharge-refund:${repoCompleteOrder}:1`, actorId: 'fixture-repo-complete', reason: '真实仓储并发完成退款', providerRefundId: 'fixture-repo-complete-refund' })
    const repoCompletedSnapshot = await snapshot(wsRepoComplete)
    repoCompleteGate.completion.release()
    const repoCompleteResponse = await repoCompleteRun
    const repoCompleteAfter = await snapshot(wsRepoComplete)
    const repoOutbox: Array<{ event_type: string; aggregate_id: string; payload: Record<string, unknown> }> = (await pool.query('SELECT event_type,aggregate_id,payload FROM outbox_events WHERE workspace_id=$1 ORDER BY created_at,id', [wsRepoComplete])).rows
    const repoAudits: Array<{ action: string; resource_id: string; after_json: Record<string, unknown> }> = (await pool.query("SELECT action,resource_id,after_json FROM workspace_operation_audit WHERE workspace_id=$1 ORDER BY created_at,id", [wsRepoComplete])).rows
    checks.push({ stage, before: repoCompleteBefore, afterConcurrentRepositoryComplete: repoCompletedSnapshot, response: repoCompleteResponse, final: repoCompleteAfter, transactionalOutboxFacts: repoOutbox, audits: repoAudits })
    assert.equal(repoCompleteResponse.status, 200, 'VERIFY_PAYMENT_REPO_COMPLETE_HTTP_FAILED')
    assert.equal(repoCompleteResponse.envelope.data?.state, 'attention_required', 'VERIFY_PAYMENT_REPO_COMPLETE_ATTENTION_MISSING')
    const repoRefundFailures = repoCompleteResponse.envelope.data?.refund_failed
    assert(Array.isArray(repoRefundFailures) && repoRefundFailures.length === 1 && object(repoRefundFailures[0]) && repoRefundFailures[0].code === 'PAYMENT_REFUND_CONCURRENT_STATE_CHANGE' && repoRefundFailures[0].reservation_released === false, 'VERIFY_PAYMENT_REPO_COMPLETE_CONCURRENT_FAILURE_INVALID')
    assert.equal(repoCompleteAfter.orders.find(row => row.id === repoCompleteOrder)?.state, 'closed', 'VERIFY_PAYMENT_REPO_COMPLETE_ORDER_NOT_CLOSED')
    assert.equal(repoCompleteAfter.balanceFen, 0, 'VERIFY_PAYMENT_REPO_COMPLETE_BALANCE_CHANGED')
    assert.equal(repoCompleteAfter.balanceFen, repoCompletedSnapshot.balanceFen, 'VERIFY_PAYMENT_REPO_COMPLETE_RECONCILIATION_BALANCE_CHANGED')
    assert.deepEqual(repoCompleteAfter.ledger, repoCompletedSnapshot.ledger, 'VERIFY_PAYMENT_REPO_COMPLETE_RECONCILIATION_LEDGER_CHANGED')
    assert.equal(repoCompleteAfter.ledger.filter(row => row.order_id === `release:recharge-refund:${repoCompleteOrder}:1`).length, 0, 'VERIFY_PAYMENT_REPO_COMPLETE_RELEASE_INSERTED')
    assert.equal(repoOutbox.filter(row => row.event_type === 'billing.recharge.refunded' && row.payload.provider_refund_id === 'fixture-repo-complete-refund').length, 1, 'VERIFY_PAYMENT_REPO_COMPLETE_REFUND_OUTBOX_MISSING')
    assert.equal(repoOutbox.filter(row => row.event_type === 'billing.recharge.refund_reservation_released').length, 0, 'VERIFY_PAYMENT_REPO_COMPLETE_RELEASE_OUTBOX_FABRICATED')
    assert.equal(repoAudits.filter(row => row.action === 'billing.reconciliation.run' && row.resource_id === repoCompleteOrder).length, 0, 'VERIFY_PAYMENT_REPO_COMPLETE_FALSE_COMMITTED_AUDIT')
    stage = 'redis_concurrency'
    await seed(wsConcurrent, 'concurrent_1', 100); await seed(wsConcurrent, 'concurrent_2', 100)
    const concurrentGate = makeGate(); plans.get(`/status:${wsConcurrent}:concurrent_1`)!.gate = concurrentGate
    const first = post(wsConcurrent)
    // A failed gate wait still reaches finally; do not leave a rejected fetch
    // unobserved while the owned child and fixtures are being disposed.
    void first.catch(() => undefined)
    await waitEntered(concurrentGate)
    const held = await post(wsConcurrent)
    assert.equal(held.status, 409, 'VERIFY_PAYMENT_CONCURRENT_REQUEST_NOT_BLOCKED')
    assert.equal(held.envelope.error?.code, 'PAYMENT_RECONCILIATION_IN_PROGRESS', 'VERIFY_PAYMENT_CONCURRENT_CODE_INVALID')
    concurrentGate.completion.release()
    assert.equal((await first).status, 200, 'VERIFY_PAYMENT_FIRST_CONCURRENT_RUN_FAILED')
    assert.equal((await snapshot(wsConcurrent)).balanceFen, 200, 'VERIFY_PAYMENT_CONCURRENT_BALANCE_MISMATCH')
    stage = 'redis_lease_replacement'
    await seed(wsLost, 'lost_1', 100); await seed(wsLost, 'lost_2', 100)
    const lostBefore = await snapshot(wsLost)
    const lostGate = makeGate(); plans.get(`/status:${wsLost}:lost_1`)!.gate = lostGate
    const inFlight = post(wsLost)
    void inFlight.catch(() => undefined)
    await waitEntered(lostGate)
    const key = `payment-reconciliation:${digest(wsLost)}`
    assert(await redis.get(key), 'VERIFY_PAYMENT_LEASE_NOT_PRESENT')
    const replacement = randomUUID()
    await redis.set(key, replacement, { XX: true, PX: 420_000 })
    assert.equal(await redis.get(key), replacement, 'VERIFY_PAYMENT_LEASE_REPLACEMENT_FAILED')
    lostGate.completion.release()
    const lost = await inFlight
    assert.equal(lost.status, 503, 'VERIFY_PAYMENT_LOST_LEASE_NOT_BLOCKED')
    assert.equal(lost.envelope.error?.code, 'PAYMENT_RECONCILIATION_LEASE_LOST', 'VERIFY_PAYMENT_LOST_LEASE_CODE_INVALID')
    assert.deepEqual(await snapshot(wsLost), lostBefore, 'VERIFY_PAYMENT_LOST_LEASE_CHANGED_LEDGER')
    assert.equal(calls.filter(call => call.workspaceId === wsLost).length, 1, 'VERIFY_PAYMENT_LOST_LEASE_QUERIED_NEXT_ORDER')
    assert.equal(await redis.get(key), replacement, 'VERIFY_PAYMENT_OLD_OWNER_DELETED_NEW_LEASE')
    checks.push({ stage, snapshotUnchanged: true, providerQueries: 1, replacementLeasePreserved: true })
    // A provider response is not the last asynchronous boundary. A SQL row lock
    // can block after the API's pre-write lease check. Observe that real wait,
    // replace the Redis owner, then unblock SQL and require a full rollback.
    for (const scenario of [
      { name: 'payment_order', table: 'billing_orders', hold: undefined },
      { name: 'refund_complete_reservation', table: 'billing_transactions', hold: 'succeeded' },
      { name: 'refund_release_reservation', table: 'billing_transactions', hold: 'failed' },
    ] as const) {
      stage = `sql_lock_lease_loss_${scenario.name}`
      const workspace: string = `ws_lock_${scenario.name}_${fixture.runId.replaceAll('-', '')}`
      await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [workspace])
      const firstOrder = `${scenario.name}_1`; const secondOrder = `${scenario.name}_2`
      await seed(workspace, firstOrder, 400, scenario.hold)
      await seed(workspace, secondOrder, 600, scenario.hold)
      const beforeLock = await snapshot(workspace)
      const blocker: PoolClient = await pool.connect()
      let blockedRequest: ReturnType<typeof post> | undefined
      let replacementToken: string | undefined
      let observedWait: Record<string, unknown> | undefined
      const leaseKey = `payment-reconciliation:${digest(workspace)}`
      try {
        await blocker.query('BEGIN')
        await blocker.query("SET LOCAL idle_in_transaction_session_timeout='10s'")
        const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
        assert(Number.isSafeInteger(blockerPid) && blockerPid > 0, 'VERIFY_PAYMENT_BLOCKER_PID_INVALID')
        // Table names are fixed literals; values always use SQL parameters.
        // For refunds lock ONLY the reservation, deliberately leaving the first
        // order-row lock available so this probes the second lock boundary.
        const locked: QueryResult<{ id: string }> = scenario.table === 'billing_orders'
          ? await blocker.query('SELECT id FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspace, firstOrder])
          : await blocker.query('SELECT id FROM billing_transactions WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspace, `hold_${firstOrder}`])
        assert.equal(locked.rowCount, 1, 'VERIFY_PAYMENT_SQL_TARGET_LOCK_NOT_ACQUIRED')
        blockedRequest = post(workspace)
        void blockedRequest.catch(() => undefined)
        const waitStartedAt = Date.now()
        const deadline = waitStartedAt + 4_000
        while (Date.now() < deadline) {
          abort.signal.throwIfAborted()
          const waits = (await pool.query(`SELECT a.pid,a.usename,a.state,a.wait_event_type,a.wait_event,
              EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) AS has_ungranted_lock
            FROM pg_stat_activity a
            WHERE a.datname=current_database() AND a.usename='merchant_app'
              AND a.wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(a.pid))
              AND position($2 in a.query)>0 AND position('FOR UPDATE' in a.query)>0`, [blockerPid, scenario.table])).rows
          if (waits.length === 1 && waits[0]?.has_ungranted_lock === true) {
            observedWait = { ...waits[0], blockerPid, table: scenario.table, elapsedMs: Date.now() - waitStartedAt }
            break
          }
          await new Promise(resolveWait => setTimeout(resolveWait, 25))
        }
        assert(observedWait, 'VERIFY_PAYMENT_API_SQL_LOCK_WAIT_NOT_OBSERVED')
        assert.equal(calls.filter(call => call.workspaceId === workspace).length, 1, 'VERIFY_PAYMENT_SQL_WAIT_PROVIDER_QUERY_COUNT_INVALID')
        assert(await redis.get(leaseKey), 'VERIFY_PAYMENT_SQL_WAIT_LEASE_NOT_PRESENT')
        replacementToken = randomUUID()
        assert.equal(await redis.set(leaseKey, replacementToken, { XX: true, PX: 420_000 }), 'OK', 'VERIFY_PAYMENT_SQL_WAIT_LEASE_REPLACEMENT_FAILED')
        assert.equal(await redis.get(leaseKey), replacementToken, 'VERIFY_PAYMENT_SQL_WAIT_NEW_LEASE_NOT_PRESENT')
      } finally {
        // No business changes are committed by this connection. Release just
        // our exact lock even if the wait-observation probe fails.
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      }
      assert(replacementToken && observedWait, 'VERIFY_PAYMENT_SQL_WAIT_PROBE_INCOMPLETE')
      const response = await blockedRequest
      const afterLock = await snapshot(workspace)
      const providerQueries = calls.filter(call => call.workspaceId === workspace).length
      const replacementLeasePreserved = await redis.get(leaseKey) === replacementToken
      const failures: Array<{ after_json: { code?: string; state?: string } }> = (await pool.query("SELECT workspace_id,actor_id,action,resource_type,resource_id,after_json FROM workspace_operation_audit WHERE workspace_id=$1 AND action='billing.reconciliation.worker'", [workspace])).rows
      // Capture observations before asserting them, so a regression's financial
      // side effects remain inspectable after the isolated database is disposed.
      checks.push({ stage, observedWait, before: beforeLock, after: afterLock, providerQueries, replacementLeasePreserved, failureAudits: failures })
      assert.equal(response.status, 503, 'VERIFY_PAYMENT_SQL_WAIT_LOST_LEASE_NOT_BLOCKED')
      assert.equal(response.envelope.error?.code, 'PAYMENT_RECONCILIATION_LEASE_LOST', 'VERIFY_PAYMENT_SQL_WAIT_LOST_LEASE_CODE_INVALID')
      assert.deepEqual(afterLock, beforeLock, 'VERIFY_PAYMENT_SQL_WAIT_LOST_LEASE_CHANGED_LEDGER')
      assert.equal(providerQueries, 1, 'VERIFY_PAYMENT_SQL_WAIT_LOST_LEASE_QUERIED_NEXT_ORDER')
      assert(replacementLeasePreserved, 'VERIFY_PAYMENT_SQL_WAIT_OLD_OWNER_DELETED_NEW_LEASE')
      assert.equal(failures.length, 1, 'VERIFY_PAYMENT_SQL_WAIT_FAILURE_AUDIT_COUNT_INVALID')
      assert.equal(failures[0]?.after_json?.code, 'PAYMENT_RECONCILIATION_LEASE_LOST', 'VERIFY_PAYMENT_SQL_WAIT_FAILURE_AUDIT_CODE_MISSING')
      assert.equal(failures[0]?.after_json?.state, 'failed', 'VERIFY_PAYMENT_SQL_WAIT_FAILURE_AUDIT_STATE_INVALID')
    }
    stage = 'sql_lock_timeout'
    const timeoutWorkspace: string = `ws_lock_timeout_${fixture.runId.replaceAll('-', '')}`
    await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [timeoutWorkspace])
    await seed(timeoutWorkspace, 'timeout_payment', 800)
    const timeoutBefore = await snapshot(timeoutWorkspace)
    const timeoutBlocker: PoolClient = await pool.connect()
    try {
      await timeoutBlocker.query('BEGIN')
      // Longer than the whole probe: automatic expiry of this fixture lock
      // must never be mistaken for the API's own five-second lock timeout.
      await timeoutBlocker.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
      const blockerPid: number = Number((await timeoutBlocker.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const locked: QueryResult<{ id: string }> = await timeoutBlocker.query('SELECT id FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [timeoutWorkspace, 'timeout_payment'])
      assert.equal(locked.rowCount, 1, 'VERIFY_PAYMENT_TIMEOUT_LOCK_NOT_ACQUIRED')
      const startedRequestAt = Date.now()
      const timeoutRequest = post(timeoutWorkspace)
      void timeoutRequest.catch(() => undefined)
      let observedWait: Record<string, unknown> | undefined
      while (Date.now() - startedRequestAt < 4_000) {
        abort.signal.throwIfAborted()
        const waits = (await pool.query(`SELECT a.pid,a.usename,a.state,a.wait_event_type,a.wait_event,
            EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) AS has_ungranted_lock
          FROM pg_stat_activity a
          WHERE a.datname=current_database() AND a.usename='merchant_app'
            AND a.wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(a.pid))
            AND position('billing_orders' in a.query)>0 AND position('FOR UPDATE' in a.query)>0`, [blockerPid])).rows
        if (waits.length === 1 && waits[0]?.has_ungranted_lock === true) { observedWait = { ...waits[0], blockerPid, elapsedMs: Date.now() - startedRequestAt }; break }
        await new Promise(resolveWait => setTimeout(resolveWait, 25))
      }
      assert(observedWait, 'VERIFY_PAYMENT_TIMEOUT_SQL_WAIT_NOT_OBSERVED')
      let responseDeadline: ReturnType<typeof setTimeout> | undefined
      let response: Awaited<ReturnType<typeof post>>
      try {
        response = await Promise.race([timeoutRequest, new Promise<never>((_, reject) => {
          responseDeadline = setTimeout(() => reject(new Error('VERIFY_PAYMENT_SQL_TIMEOUT_NOT_BOUNDED')), Math.max(1, 14_000 - (Date.now() - startedRequestAt)))
        })])
      } finally { if (responseDeadline) clearTimeout(responseDeadline) }
      const elapsedMs = Date.now() - startedRequestAt
      // Observe that OUR transaction and exclusive transaction-ID lock still
      // exist after HTTP returned, before the finally block releases anything.
      const blockerState = (await pool.query(`SELECT a.pid,a.state,a.xact_start,
          EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.granted AND l.locktype='transactionid' AND l.mode='ExclusiveLock') AS holds_transaction_lock
        FROM pg_stat_activity a WHERE a.pid=$1`, [blockerPid])).rows[0]
      const timeoutAfter = await snapshot(timeoutWorkspace)
      const providerQueries = calls.filter(call => call.workspaceId === timeoutWorkspace).length
      checks.push({ stage, response, observedWait, elapsedMs, blockerStillHeldAtResponse: blockerState, before: timeoutBefore, after: timeoutAfter, providerQueries, redisLeaseManuallyReplaced: false })
      assert.equal(response.status, 200, 'VERIFY_PAYMENT_SQL_TIMEOUT_HTTP_STATUS_INVALID')
      assert.equal(response.envelope.data?.state, 'attention_required', 'VERIFY_PAYMENT_SQL_TIMEOUT_ATTENTION_MISSING')
      const failures = response.envelope.data?.failed
      assert(Array.isArray(failures) && failures.length === 1 && object(failures[0]) && failures[0].code === '55P03', 'VERIFY_PAYMENT_SQL_TIMEOUT_CODE_INVALID')
      assert(elapsedMs < 9_000, 'VERIFY_PAYMENT_SQL_TIMEOUT_EXCEEDED_BUDGET')
      assert(Array.isArray(response.envelope.data?.queue_rotation_failures) && response.envelope.data.queue_rotation_failures.length === 1, 'VERIFY_PAYMENT_SQL_TIMEOUT_ROTATION_EVIDENCE_MISSING')
      assert(blockerState?.state === 'idle in transaction' && blockerState.holds_transaction_lock === true, 'VERIFY_PAYMENT_FIXTURE_LOCK_RELEASED_BEFORE_RESPONSE')
      assert.deepEqual(timeoutAfter, timeoutBefore, 'VERIFY_PAYMENT_SQL_TIMEOUT_CHANGED_LEDGER')
      assert.equal(providerQueries, 1, 'VERIFY_PAYMENT_SQL_TIMEOUT_QUERY_COUNT_INVALID')
    } finally {
      try { await timeoutBlocker.query('ROLLBACK') } finally { timeoutBlocker.release() }
    }
    stage = 'sql_lock_timeout_recovery'
    const recovered = await post(timeoutWorkspace)
    assert.equal(recovered.status, 200, 'VERIFY_PAYMENT_SQL_TIMEOUT_RECOVERY_HTTP_FAILED')
    assert.equal(recovered.envelope.data?.state, 'completed', 'VERIFY_PAYMENT_SQL_TIMEOUT_RECOVERY_NOT_COMPLETED')
    const recoveredSnapshot = await snapshot(timeoutWorkspace)
    assert.equal(recoveredSnapshot.balanceFen, 800, 'VERIFY_PAYMENT_SQL_TIMEOUT_RECOVERY_BALANCE_INVALID')
    assert.equal(recoveredSnapshot.ledger.filter(row => row.type === 'recharge' && row.order_id === 'timeout_payment').length, 1, 'VERIFY_PAYMENT_SQL_TIMEOUT_RECOVERY_CREDIT_NOT_ONCE')
    assert.equal((await post(timeoutWorkspace)).status, 200, 'VERIFY_PAYMENT_SQL_TIMEOUT_RECOVERY_REPLAY_FAILED')
    assert.deepEqual(await snapshot(timeoutWorkspace), recoveredSnapshot, 'VERIFY_PAYMENT_SQL_TIMEOUT_RECOVERY_REPLAY_CHANGED_LEDGER')
    checks.push({ stage, recoveredSnapshot, replayUnchanged: true })
    stage = 'post_commit_audit_projection_failure'
    // Fault only the caller-owned isolated audit projection. Business/outbox
    // transactions must remain committed and their response must stay truthful.
    await pool.query(`CREATE FUNCTION verify_payment_reject_audit_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.workspace_id LIKE 'ws_audit_%' AND NEW.action='billing.reconciliation.run')
          OR (NEW.workspace_id LIKE 'ws_worker_audit_%' AND NEW.action='billing.reconciliation.worker') THEN
          RAISE EXCEPTION 'isolated audit projection failure' USING ERRCODE='P0001';
        END IF;
        RETURN NEW;
      END $$`)
    await pool.query('CREATE TRIGGER verify_payment_audit_projection_failure BEFORE INSERT ON workspace_operation_audit FOR EACH ROW EXECUTE FUNCTION verify_payment_reject_audit_projection()')
    for (const scenario of [
      { suffix: 'payment', hold: undefined, eventType: 'billing.recharge.paid', state: 'paid', balanceFen: 900 },
      { suffix: 'refund_success', hold: 'succeeded' as const, eventType: 'billing.recharge.refunded', state: 'closed', balanceFen: 0 },
      { suffix: 'refund_failed', hold: 'failed' as const, eventType: 'billing.recharge.refund_reservation_released', state: 'paid', balanceFen: 900 },
      { suffix: 'worker', hold: undefined, eventType: 'billing.recharge.paid', state: 'paid', balanceFen: 900 },
    ]) {
      const workspace: string = `${scenario.suffix === 'worker' ? 'ws_worker_audit' : 'ws_audit'}_${scenario.suffix}_${fixture.runId.replaceAll('-', '')}`
      const id = `audit_${scenario.suffix}`
      await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [workspace])
      await seed(workspace, id, 900, scenario.hold)
      const response = await post(workspace)
      const committed = await snapshot(workspace)
      const facts: Array<{ aggregate_id: string; event_type: string; payload: Record<string, unknown> }> = (await pool.query('SELECT aggregate_id,event_type,payload FROM outbox_events WHERE workspace_id=$1 ORDER BY created_at,id', [workspace])).rows
      checks.push({ stage, scenario: scenario.suffix, response, committed, transactionalOutboxFacts: facts })
      assert.equal(response.status, 200, 'VERIFY_PAYMENT_AUDIT_PROJECTION_HTTP_INVALID')
      assert.equal(response.envelope.data?.state, 'attention_required', 'VERIFY_PAYMENT_AUDIT_PROJECTION_ATTENTION_MISSING')
      assert(Array.isArray(response.envelope.data?.audit_projection_failures) && response.envelope.data.audit_projection_failures.length === 1, 'VERIFY_PAYMENT_AUDIT_PROJECTION_EVIDENCE_MISSING')
      assert.equal(committed.orders[0]?.state, scenario.state, 'VERIFY_PAYMENT_AUDIT_PROJECTION_BUSINESS_STATE_INVALID')
      assert.equal(committed.balanceFen, scenario.balanceFen, 'VERIFY_PAYMENT_AUDIT_PROJECTION_BALANCE_INVALID')
      assert.equal(facts.filter(row => row.event_type === scenario.eventType && row.payload.order_id === id).length, 1, 'VERIFY_PAYMENT_AUDIT_PROJECTION_OUTBOX_MISSING')
      if (!scenario.hold) {
        assert(Array.isArray(response.envelope.data?.settled) && response.envelope.data.settled.length === 1, 'VERIFY_PAYMENT_AUDIT_PROJECTION_SETTLEMENT_MISREPORTED')
        assert.deepEqual(response.envelope.data?.failed, [], 'VERIFY_PAYMENT_AUDIT_PROJECTION_PROVIDER_FAILURE_FABRICATED')
      } else if (scenario.hold === 'succeeded') {
        assert(Array.isArray(response.envelope.data?.refund_settled) && response.envelope.data.refund_settled.length === 1, 'VERIFY_PAYMENT_AUDIT_PROJECTION_REFUND_MISREPORTED')
        assert.deepEqual(response.envelope.data?.refund_failed, [], 'VERIFY_PAYMENT_AUDIT_PROJECTION_REFUND_FAILURE_FABRICATED')
      } else {
        const failures = response.envelope.data?.refund_failed
        assert(Array.isArray(failures) && failures.length === 1 && object(failures[0]) && failures[0].reservation_released === true, 'VERIFY_PAYMENT_AUDIT_PROJECTION_RELEASE_MISREPORTED')
      }
      assert.equal((await post(workspace)).status, 200, 'VERIFY_PAYMENT_AUDIT_PROJECTION_REPLAY_FAILED')
      assert.deepEqual(await snapshot(workspace), committed, 'VERIFY_PAYMENT_AUDIT_PROJECTION_REPLAY_CHANGED_LEDGER')
    }
    stage = 'durable_audits'
    const audits = (await pool.query("SELECT workspace_id,actor_id,action,resource_type,resource_id,after_json FROM workspace_operation_audit WHERE action='billing.reconciliation.worker' ORDER BY created_at,id")).rows
    assert(audits.length >= 3 && audits.every(row => row.actor_id === 'worker:isolated-payment-reconcile' && row.resource_type === 'billing_reconciliation'), 'VERIFY_PAYMENT_DURABLE_AUDIT_MISSING')
    assert(!audits.some(row => row.workspace_id === wsB), 'VERIFY_PAYMENT_OTHER_TENANT_AUDIT_WRITTEN')
    checks.push({ stage, audits })
    abort.signal.throwIfAborted()
  } catch (error) {
    errors.push(error instanceof Error && /^VERIFY_PAYMENT_[A-Z_]+$/u.test(error.message) ? error.message : `VERIFY_PAYMENT_FAILED_AT_${stage.toUpperCase()}`)
  } finally {
    for (const gate of gates) gate.completion.release()
    await stopChild(child).catch(() => errors.push('VERIFY_PAYMENT_CHILD_DISPOSAL_FAILED'))
    if (stub.listening) { stub.closeAllConnections(); await new Promise<void>(resolveClose => stub.close(() => resolveClose())) }
    if (redis?.isOpen) await redis.quit().catch(() => { redis?.destroy(); errors.push('VERIFY_PAYMENT_REDIS_DISCONNECT_FAILED') })
    await pool?.end().catch(() => errors.push('VERIFY_PAYMENT_DATABASE_DISCONNECT_FAILED'))
    await appPool?.end().catch(() => errors.push('VERIFY_PAYMENT_APP_DATABASE_DISCONNECT_FAILED'))
    if (fixture) {
      try { disposal = await fixture.dispose(); if (disposal.leftRunning.length) errors.push('VERIFY_PAYMENT_FIXTURE_DISPOSAL_INCOMPLETE') } catch { errors.push('VERIFY_PAYMENT_FIXTURE_DISPOSAL_FAILED') }
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
  const after = await fingerprint()
  if (JSON.stringify(before) !== JSON.stringify(after)) errors.push('VERIFY_PAYMENT_SOURCE_CHANGED_DURING_RUN')
  if (abort.signal.aborted) errors.push('VERIFY_PAYMENT_INTERRUPTED')
  const report = {
    schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), runId: fixture?.runId ?? null,
    status: errors.length ? 'failed' : 'passed', errors: [...new Set(errors)], stage,
    surface: 'real API HTTP, signed worker proof, PostgreSQL application-role writes and Redis leases',
    fixtureOnly: true, provider: 'new localhost synthetic status stub; no real payment or refund dispatch',
    seededRefundHolds: true, realPaymentCalls: 0, realModelCalls: 0, inheritedBusinessEnvironment: false,
    sharedContainersTouched: false, fingerprintsBefore: before, fingerprintsAfter: after, providerQueries: calls, checks, disposal,
    apiChild: child ? { pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode, exited: child.exitCode !== null || child.signalCode !== null } : null,
  }
  const reportPath = join(evidenceDir, 'run-result.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(`Payment reconciliation acceptance ${report.status}; report: ${reportPath}`)
  process.exitCode = errors.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  if (process.argv[2] === '--api-child') {
    apiChild().catch(() => { process.send?.({ kind: 'failed', code: 'VERIFY_PAYMENT_API_STARTUP_FAILED' }); process.exit(1) })
  } else main().catch(() => { console.error('Payment reconciliation verification entrypoint failed; no inherited business configuration was used.'); process.exitCode = 1 })
}
