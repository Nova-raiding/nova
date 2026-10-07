import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import { Pool } from 'pg'
import { PostgresCreativePointLifecycleRepository } from '../../../packages/persistence/src/creative-point-lifecycle-repository.js'
import { PostgresOutboxRepository } from '../../../packages/persistence/src/repository.js'
import type { SqlPool } from '../../../packages/persistence/src/repository.js'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { startImageSignedFixture } from '../../../tests/fixtures/image-signed-http-test-fixture.js'
import { evaluatePlatformModelRelayGate, startPlatformRelayTokenQuotaMonitor } from '../../../packages/ai/src/platform-model-gate.js'

let f: Awaited<ReturnType<typeof startImageSignedFixture>>
let provider: Server
let providerBase: string
let stopQuota: (() => Promise<void>) | undefined
let providerCalls = 0
const evidence: unknown[] = []
type Job = Awaited<ReturnType<Awaited<ReturnType<typeof startImageSignedFixture>>['seedJob']>>
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('LOOPBACK_REQUIRED')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
beforeAll(async () => {
  f = await startImageSignedFixture({ redis: true })
  provider = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/usage/token/') { res.end(JSON.stringify({ code: true, data: { object: 'token_usage', total_granted: 1000000, total_used: 0, total_available: 1000000, expires_at: 0, unlimited_quota: false } })); return }
    providerCalls++; res.statusCode = 500; res.end(JSON.stringify({ error: 'UNEXPECTED_LOCAL_PROVIDER_DISPATCH' }))
  })
  providerBase = await listen(provider)
  for (const [key, value] of Object.entries({ MODEL_RELAY_BASE_URL: 'https://provider.fixture.invalid', MODEL_RELAY_ALLOWED_HOSTS: 'provider.fixture.invalid', MODEL_RELAY_API_KEY: randomUUID(), IMAGE_MODEL: 'fixture-no-provider', MODEL_RPM_LIMIT: '100', MODEL_TPM_LIMIT: '10000', MODEL_DAILY_CNY_LIMIT: '100', MODEL_MAX_TASK_COST_CNY: '2', MODEL_IMAGE_MAX_REQUEST_CNY: '0.2', MODEL_COST_ESTIMATE_VERSION: 'fixture', MODEL_RELAY_IMAGE_COST_EVIDENCE: 'true', DEPLOYMENT_PROFILE: 'ecs', ASSET_SCANNER_MODE: 'deferred', DEMO_UNSCANNED_ASSETS_ENABLED: 'true' })) vi.stubEnv(key, value)
  // The quota evidence is from this isolated HTTP service, never a supplier receipt.
  stopQuota = startPlatformRelayTokenQuotaMonitor(process.env, async (input, init) => {
    const url = new URL(String(input)); if (url.hostname !== 'provider.fixture.invalid') throw Error('TEST_EXTERNAL_NETWORK_FORBIDDEN')
    return fetch(new URL(url.pathname + url.search, providerBase), init)
  })
  await vi.waitFor(() => expect(evaluatePlatformModelRelayGate(process.env, 'model').ready).toBe(true), { timeout: 10000 })
}, 90000)
afterAll(async () => {
  console.info('PRE_DISPATCH_RECOVERY_EVIDENCE', JSON.stringify({ providerCalls, cases: evidence }))
  await stopQuota?.(); if (provider) await close(provider); await f?.close()
}, 30000)

async function runWorker(workspaceId: string, base: string) {
  // Test bootstrap only: real PG/Redis readiness in development, then business
  // requests in production. This suite does not attest deployment readiness.
  vi.stubEnv('NODE_ENV', 'development')
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/image-signed-worker-child.ts'], {
    cwd: process.cwd(), env: {
      PATH: process.env.PATH, NODE_ENV: 'development', DATABASE_URL: f.appUrl,
      MERCHANT_ISOLATED_POSTGRES_RUN_ID: process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID,
      WORKER_ROLE: 'generation', WORKER_WORKSPACES: workspaceId, WORKER_ONCE: 'true', WORKER_METRICS_PORT: '0', WORKER_DB_POOL_MAX: '2', WORKER_READY_FILE: join(tmpdir(), `image-worker-${randomUUID()}.ready`),
      WORKER_API_BASE_URL: base, WORKER_API_TOKEN: f.credential.token, WORKER_API_SIGNING_SECRET: f.credential.signing_secret,
      MODEL_RELAY_BASE_URL: 'https://provider.fixture.invalid', MODEL_RELAY_ALLOWED_HOSTS: 'provider.fixture.invalid', MODEL_RELAY_API_KEY: randomUUID(), IMAGE_MODEL: 'fixture-no-provider', ISOLATED_PROVIDER_URL: providerBase,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 45000)
  try { const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }); expect(code, output).toBe(0); return output } finally { clearTimeout(timeout) }
}

async function request(path: string, workspaceId: string, body: Record<string, unknown>, role: 'generation' | 'reconcile' = 'reconcile') {
  const raw = JSON.stringify(body); const credential = role === 'generation' ? f.credential : f.reconcileCredential
  const proof = createWorkerRequestProof({ secret: credential.signing_secret, workerId: 'isolated-recovery', role, method: 'POST', requestTarget: path, workspaceId, body: raw })
  const response = await fetch(f.base + path, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...proof.headers }, body: raw })
  return { status: response.status, body: await response.json() as any }
}
async function sweep(job: Job) {
  expect(process.env.NODE_ENV).toBe('production')
  return request('/v1/internal/image-generation-jobs/reconciliation', job.workspaceId, { workspace_id: job.workspaceId, limit: 100 })
}
async function sweepChild(job: Job) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/image-reconcile-child.ts'], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: 'development', MERCHANT_ISOLATED_POSTGRES_RUN_ID: process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID, WORKER_API_BASE_URL: f.base, WORKER_API_TOKEN: f.reconcileCredential.token, WORKER_API_SIGNING_SECRET: f.reconcileCredential.signing_secret, WORKER_WORKSPACES: job.workspaceId }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d })
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000)
  try { const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }); expect(code, output).toBe(0); return JSON.parse(output.trim()) } finally { clearTimeout(timer) }
}
async function zeroDispatch() {
  const job = await f.seedJob({ unclaimed: true }); vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '0.1')
  const apiResponses: Array<{ method?: string; path?: string; status: number; body: string }> = []
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString(); const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
      expect(req.headers['x-internal-worker-signing-secret']).toBeUndefined()
      if (req.url !== '/readyz') expect(process.env.NODE_ENV).toBe('production')
      const response = await fetch(f.base + req.url, { method: req.method, headers: headers as Record<string,string>, ...(body ? { body } : {}) }); const text = await response.text()
      if (req.url !== '/readyz') apiResponses.push({ method: req.method, path: req.url, status: response.status, body: text.slice(0, 1500) })
      if (req.url === '/readyz') { expect(response.status, text).toBe(200); const value=JSON.parse(text); expect(value.data.persistence.ready && value.data.redis.ready).toBe(true); vi.stubEnv('NODE_ENV','production') }
      res.statusCode=response.status;res.setHeader('content-type','application/json');res.end(text)
    } catch (error) { res.statusCode=500;res.end(JSON.stringify({error:String(error)})) }
  })
  let workerOutput = ''
  try { workerOutput = await runWorker(job.workspaceId, await listen(proxy)) } finally { await close(proxy) }
  const execution = await f.persistence.imageGenerationExecutions!.get({workspaceId:job.workspaceId,jobId:job.jobId})
  expect(execution?.state, JSON.stringify({ apiResponses, workerOutput: workerOutput.slice(-3000) })).toBe('failed'); expect(execution?.providerStartedAt).toBeUndefined()
  expect(await f.persistence.imageGenerationExecutions!.hasPreProviderFailureProof!({workspaceId:job.workspaceId,jobId:job.jobId,eventId:job.event.id})).toBe(true)
  const proof=(await f.admin.query("SELECT count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id=$1 AND action='image.dispatch.closed_before_provider'",[job.workspaceId])).rows[0]
  expect(proof.count).toBe(1);expect((await facts(job)).point).toBe('active')
  return job
}
async function facts(job: Job) {
  const point=await f.persistence.creativePoints!.getReservation(job.workspaceId,job.hold.value.id)
  const snapshot=await f.persistence.business!.get(job.workspaceId,'image_generation_job',job.jobId)
  const budget=(await f.admin.query('SELECT status FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2',[job.workspaceId,job.action])).rows[0]
  const events=(await f.admin.query("SELECT count(*)::int AS count FROM outbox_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='image.generation.failed'",[job.workspaceId,job.jobId])).rows[0]
  const releases=(await f.admin.query("SELECT count(*)::int AS count FROM creative_point_operations WHERE workspace_id=$1 AND kind='release'",[job.workspaceId])).rows[0]
  return {point:point?.status,job:snapshot.payload.state,revision:snapshot.entityVersion,budget:budget.status,failedEvents:events.count,releases:releases.count}
}
const receipt = (job: Job) => ({workspaceId:job.workspaceId,operationId:job.hold.value.operationId,provider:'isolated-fixture',providerRequestId:`request-${randomUUID()}`,outcome:'unknown' as const,at:new Date().toISOString(),receiptHash:'b'.repeat(64)})

it('closes a proven zero-dispatch hold through concurrent natural sweeps exactly once',async()=>{
  const job=await zeroDispatch(); const responses=await Promise.all([sweepChild(job),sweepChild(job)])
  expect(responses.every(r=>r && typeof r==='object')).toBe(true)
  await sweepChild(job)
  expect(await facts(job)).toMatchObject({point:'released',job:'failed',budget:'released',failedEvents:1,releases:1})
  const before=await f.fingerprint();await sweepChild(job);expect(await f.fingerprint()).toEqual(before)
  expect(providerCalls).toBe(0);evidence.push({case:'double-sweep-and-replay',...(await facts(job)),providerCalls})
},120000)

it('recovers after release committed but the durable failed projection transaction aborted',async()=>{
  const job=await zeroDispatch(); const fn=`fail_projection_${randomUUID().replaceAll('-','')}`
  await f.admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${job.workspaceId}' AND NEW.entity_type='image_generation_job' AND NEW.payload->>'state'='failed' THEN RAISE EXCEPTION 'ISOLATED_PROJECTION_FAILURE'; END IF; RETURN NEW; END $$`)
  await f.admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON business_entity_snapshots FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  try { await sweepChild(job);expect(await facts(job)).toMatchObject({point:'released',job:'queued',failedEvents:0,releases:1}) }
  finally {await f.admin.query(`DROP TRIGGER ${fn} ON business_entity_snapshots`);await f.admin.query(`DROP FUNCTION ${fn}()`)}
  await sweepChild(job);expect(await facts(job)).toMatchObject({point:'released',job:'failed',failedEvents:1,releases:1})
  evidence.push({case:'release-then-projection-crash-new-process-recovery',...(await facts(job)),providerCalls})
},120000)

it('keeps holds frozen for existing provider receipt, usage, and failed-without-CAS-proof',async()=>{
  const received=await zeroDispatch();await f.persistence.creativePointLifecycle!.recordProviderReceipt(receipt(received));await sweep(received)
  expect(await facts(received)).toMatchObject({point:'active',job:'queued',releases:0})
  const used=await zeroDispatch()
  await f.persistence.actionLedger!.record({workspaceId:used.workspaceId,actionKey:used.action,actionKind:'model_image',settlement:'included_quota',units:1,amountFen:0,actorId:'isolated-fixture',description:'negative evidence fixture',settlementStatus:'authorized'})
  await f.persistence.modelUsage!.record({workspaceId:used.workspaceId,actionId:used.action,modality:'image',model:'fixture-no-provider',providerRequestId:`usage-${randomUUID()}`,settlementStatus:'pending_cost'})
  await sweep(used);expect(await facts(used)).toMatchObject({point:'active',job:'queued',releases:0})
  const unknown=await f.seedJob();const repo=f.persistence.imageGenerationExecutions!
  await repo.beginProviderDispatch({workspaceId:unknown.workspaceId,jobId:unknown.jobId,ownerToken:unknown.execution.ownerToken})
  await repo.markOutcomeUnknown({workspaceId:unknown.workspaceId,jobId:unknown.jobId,ownerToken:unknown.execution.ownerToken,errorCode:'UNKNOWN',errorMessage:'transport outcome unknown'})
  await repo.reconcileFailed({workspaceId:unknown.workspaceId,jobId:unknown.jobId,errorCode:'MODEL_TASK_COST_LIMIT_EXCEEDED',errorMessage:'historical ambiguous projection'})
  const outboxPool=new Pool({connectionString:f.appUrl,max:1})
  try { await new PostgresOutboxRepository(outboxPool).deadLetter(unknown.workspaceId,unknown.event.id,{code:'MODEL_TASK_COST_LIMIT_EXCEEDED',message:'synthetic ambiguous history',retryable:false,unknown:false}) } finally {await outboxPool.end()}
  await f.persistence.modelUsage!.releaseDailyBudget({workspaceId:unknown.workspaceId,reservationKey:unknown.action})
  expect(await repo.hasPreProviderFailureProof!({workspaceId:unknown.workspaceId,jobId:unknown.jobId,eventId:unknown.event.id})).toBe(false)
  await sweep(unknown);expect(await facts(unknown)).toMatchObject({point:'active',job:'queued',releases:0})
  const mismatch=await zeroDispatch();const execution=await repo.get({workspaceId:mismatch.workspaceId,jobId:mismatch.jobId})
  const valid={workspaceId:mismatch.workspaceId,reservationId:mismatch.hold.value.id,actionKey:mismatch.action,sourceEventId:mismatch.event.id,preProvider:true,idempotencyKey:`guard-${randomUUID()}`,imagePreDispatch:{jobId:mismatch.jobId,eventId:mismatch.event.id,intentHash:'a'.repeat(64),attempt:execution!.attempt,providerOperationKey:execution!.providerOperationKey!}}
  const before=await f.fingerprint()
  for(const bad of [
    {...valid,sourceEventId:'wrong',imagePreDispatch:{...valid.imagePreDispatch,eventId:'wrong'}},
    {...valid,actionKey:received.action}, {...valid,reservationId:received.hold.value.id},
    {...valid,imagePreDispatch:{...valid.imagePreDispatch,jobId:received.jobId}},
    {...valid,imagePreDispatch:{...valid.imagePreDispatch,intentHash:'c'.repeat(64)}},
    {...valid,imagePreDispatch:{...valid.imagePreDispatch,attempt:execution!.attempt+1}},
    {...valid,imagePreDispatch:{...valid.imagePreDispatch,providerOperationKey:'wrong-operation'}},
  ]) await expect(f.persistence.creativePoints!.releaseFailedProviderReservation!(bad)).rejects.toBeDefined()
  expect(await f.fingerprint()).toEqual(before)
  evidence.push({case:'receipt-usage-ambiguous-failed-and-seven-binding-mismatches-denied',holds:4,bindingRejections:7,providerCalls})
},120000)

it('serializes real provider-receipt writers with release in both lock orders',async()=>{
  const first=await zeroDispatch(); const pool=new Pool({connectionString:f.appUrl,max:1})
  let inserted!:()=>void;const reached=new Promise<void>(resolve=>{inserted=resolve});let commit!:()=>void;const gate=new Promise<void>(resolve=>{commit=resolve})
  const timingPool={connect:async()=>{const client=await pool.connect();return{query:async(sql:string,params?:unknown[])=>{if(sql==='COMMIT'){inserted();await gate}return client.query(sql,params)},release:()=>client.release()}}} as unknown as SqlPool
  const lifecycle=new PostgresCreativePointLifecycleRepository(timingPool)
  const writing=lifecycle.recordProviderReceipt(receipt(first));await reached
  let sweepFinished=false;const pending=sweep(first).then(r=>{sweepFinished=true;return r})
  try {
    await vi.waitFor(async()=>{const locks=(await f.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM creative_point_operations%'")).rows[0];expect(locks.count).toBeGreaterThan(0)},{timeout:10000})
    expect(sweepFinished).toBe(false)
  } finally {commit();await writing;await pending;await pool.end()}
  expect(await facts(first)).toMatchObject({point:'active',releases:0})
  const second=await zeroDispatch();const blocker=await f.admin.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM creative_point_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[second.workspaceId,second.hold.value.operationId])
  const release=sweep(second)
  let recording:Promise<{recorded:boolean;code?:string}>|undefined
  try {
    await vi.waitFor(async()=>{const locks=(await f.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM creative_point_operations%'")).rows[0];expect(locks.count).toBeGreaterThan(0)},{timeout:10000})
    recording=f.persistence.creativePointLifecycle!.recordProviderReceipt(receipt(second)).then(()=>({recorded:true}),error=>({recorded:false,code:error.code}))
  } finally {await blocker.query('COMMIT');blocker.release()}
  await release;expect(await recording).toMatchObject({recorded:false,code:'CREATIVE_POINT_RESERVATION_FINALIZED'})
  expect(await facts(second)).toMatchObject({point:'released',releases:1});evidence.push({case:'receipt-versus-release-both-lock-orders',providerCalls})
},120000)

it('serializes production signed pending and priced usage callbacks with the recovery budget fence',async()=>{
  const job=await zeroDispatch();const blocker=await f.admin.connect()
  await blocker.query('BEGIN');await blocker.query('SELECT reservation_key FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE',[job.workspaceId,job.action])
  const recovery=sweep(job)
  const callbacks:Array<Promise<{status:number;body:any}>>=[]
  try {
    await vi.waitFor(async()=>{const locks=(await f.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT 1 FROM model_cost_budget_reservations%'")).rows[0];expect(locks.count).toBeGreaterThan(0)},{timeout:10000})
    for(const priced of [false,true]) callbacks.push(request('/v1/internal/model-usage',job.workspaceId,{workspaceId:job.workspaceId,modality:'image',model:'fixture-no-provider',actionId:job.action,runKey:job.action,providerRequestId:`fixture-${randomUUID()}`,totalTokens:1,...(priced?{costCny:0.02}:{})},'generation'))
    await vi.waitFor(async()=>{const locks=(await f.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%model-cost-run:%'")).rows[0];expect(locks.count).toBeGreaterThanOrEqual(2)},{timeout:10000})
  } finally {await blocker.query('ROLLBACK');blocker.release()}
  await recovery;const results=await Promise.all(callbacks);expect(results).toHaveLength(2);expect(results.every(r=>r.status>=400)).toBe(true)
  expect((await f.admin.query('SELECT count(*)::int AS count FROM model_usage_ledger WHERE workspace_id=$1',[job.workspaceId])).rows[0].count).toBe(0)
  expect(await facts(job)).toMatchObject({point:'released',budget:'released',releases:1});evidence.push({case:'production-usage-pending-and-priced-concurrent-budget-lock-fence',callbacks:2,usageRows:0,providerCalls})
},120000)
