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
  console.info('PRE_DISPATCH_BUDGET_RECOVERY_EVIDENCE', JSON.stringify({ providerCalls, cases: evidence }))
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
async function zeroDispatch(beforeRun?: (job: Job) => Promise<void>) {
  const job = await f.seedJob({ unclaimed: true }); await beforeRun?.(job); vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '0.1')
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString(); const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
      expect(req.headers['x-internal-worker-signing-secret']).toBeUndefined()
      if (req.url !== '/readyz') expect(process.env.NODE_ENV).toBe('production')
      const response = await fetch(f.base + req.url, { method: req.method, headers: headers as Record<string,string>, ...(body ? { body } : {}) }); const text = await response.text()
      if (req.url === '/readyz') { expect(response.status, text).toBe(200); const value=JSON.parse(text); expect(value.data.persistence.ready && value.data.redis.ready).toBe(true); vi.stubEnv('NODE_ENV','production') }
      res.statusCode=response.status;res.setHeader('content-type','application/json');res.end(text)
    } catch (error) { res.statusCode=500;res.end(JSON.stringify({error:String(error)})) }
  })
  try { await runWorker(job.workspaceId, await listen(proxy)) } finally { await close(proxy) }
  const execution = await f.persistence.imageGenerationExecutions!.get({workspaceId:job.workspaceId,jobId:job.jobId})
  expect(execution?.state).toBe('failed'); expect(execution?.providerStartedAt).toBeUndefined()
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

async function failedBudgetClose() {
  const fn=`fail_budget_release_${randomUUID().replaceAll('-','')}`
  let installed=false
  try {
    const job=await zeroDispatch(async item=>{
      await f.admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${item.workspaceId}' AND OLD.status='active' AND NEW.status='released' THEN RAISE EXCEPTION 'ISOLATED_BUDGET_RELEASE_FAILURE'; END IF; RETURN NEW; END $$`)
      await f.admin.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON model_cost_budget_reservations FOR EACH ROW EXECUTE FUNCTION ${fn}()`);installed=true
    })
    expect(await facts(job)).toMatchObject({point:'active',budget:'active',job:'queued',releases:0})
    const row=(await f.admin.query('SELECT last_error,unknown_at FROM outbox_events WHERE workspace_id=$1 AND id=$2',[job.workspaceId,job.event.id])).rows[0]
    expect(row.last_error).toMatchObject({code:'IMAGE_GENERATION_PRE_PROVIDER_CLOSE_UNAVAILABLE',terminal:true,unknown:false});expect(row.unknown_at).toBeNull()
    return job
  } finally {if(installed) await f.admin.query(`DROP TRIGGER ${fn} ON model_cost_budget_reservations`);await f.admin.query(`DROP FUNCTION IF EXISTS ${fn}()`)}
}
it('atomically recovers a proven close whose first budget release failed, and refuses provider evidence or a wrong wrapper',async()=>{
  const valid=await failedBudgetClose();const fn=`fail_point_release_${randomUUID().replaceAll('-','')}`
  await f.admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${valid.workspaceId}' AND NEW.status='released' THEN RAISE EXCEPTION 'ISOLATED_POINT_RELEASE_FAILURE'; END IF; RETURN NEW; END $$`)
  await f.admin.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON creative_point_reservations FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  const beforeFailure=await f.fingerprint()
  try {await sweepChild(valid);expect(await f.fingerprint()).toEqual(beforeFailure);expect(await facts(valid)).toMatchObject({point:'active',budget:'active',releases:0})}
  finally {await f.admin.query(`DROP TRIGGER ${fn} ON creative_point_reservations`);await f.admin.query(`DROP FUNCTION ${fn}()`)}
  await sweepChild(valid)
  expect(await facts(valid)).toMatchObject({point:'released',budget:'released',job:'failed',failedEvents:1,releases:1})
  const before=await f.fingerprint();await sweepChild(valid);expect(await f.fingerprint()).toEqual(before)
  const received=await failedBudgetClose();await f.persistence.creativePointLifecycle!.recordProviderReceipt(receipt(received));await sweepChild(received)
  expect(await facts(received)).toMatchObject({point:'active',budget:'active',job:'queued',releases:0})
  const wrong=await failedBudgetClose()
  // Adversarial fixture corruption only: an active budget cannot use the
  // ordinary error-code path instead of the exact close-failure wrapper.
  await f.admin.query("UPDATE outbox_events SET last_error=jsonb_set(last_error,'{code}','\"MODEL_TASK_COST_LIMIT_EXCEEDED\"'::jsonb) WHERE workspace_id=$1 AND id=$2",[wrong.workspaceId,wrong.event.id])
  await sweepChild(wrong);expect(await facts(wrong)).toMatchObject({point:'active',budget:'active',job:'queued',releases:0})
  expect(providerCalls).toBe(0);evidence.push({case:'budget-release-failure-natural-atomic-recovery',budgetAndPointRollbackVerified:true,valid:await facts(valid),providerEvidenceDenied:await facts(received),wrongWrapperDenied:await facts(wrong),providerCalls})
},120000)
