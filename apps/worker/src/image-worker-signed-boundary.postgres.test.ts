import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { startImageSignedFixture } from '../../../tests/fixtures/image-signed-http-test-fixture.js'
import { evaluatePlatformModelRelayGate, startPlatformRelayTokenQuotaMonitor } from '../../../packages/ai/src/platform-model-gate.js'

let f: Awaited<ReturnType<typeof startImageSignedFixture>>
let provider: Server
let providerBase: string
let stopQuota: (() => Promise<void>) | undefined
let providerCalls = 0
const evidence: unknown[] = []
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
  console.info('SIGNED_WORKER_BOUNDARY_EVIDENCE', JSON.stringify({ providerCalls, cases: evidence }))
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

for (const mode of ['explicit', 'disconnect', 'ordinary503', 'malformed200'] as const) it(`persists ${mode} dispatch outcome through signed HTTP and fresh worker restart`, async () => {
  const job = await f.seedJob({ unclaimed: true })
  // A real request ceiling rejects before dispatch CAS, retaining the correct
  // original action so fail_before_provider can release the existing budget.
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', mode === 'explicit' ? '0.1' : '2')
  const calls: Array<{ path: string; operation?: string; status: number; code?: string }> = []
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString(); const input = raw ? JSON.parse(raw) : {}
      expect(req.headers['x-internal-worker-signing-secret']).toBeUndefined()
      if (req.url !== '/readyz') expect(process.env.NODE_ENV).toBe('production')
      const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
      const response = await fetch(f.base + req.url, { method: req.method, headers: headers as Record<string, string>, ...(raw ? { body: raw } : {}) })
      const text = await response.text(); let parsed: any; try { parsed = JSON.parse(text) } catch {}
      if (req.url === '/readyz') {
        expect(response.status, text).toBe(200)
        expect(parsed.data.persistence.ready).toBe(true); expect(parsed.data.redis.ready).toBe(true)
        vi.stubEnv('NODE_ENV', 'production')
      }
      calls.push({ path: req.url!, operation: input.operation, status: response.status, code: parsed?.error?.code })
      if (input.operation === 'begin_provider_dispatch' && response.ok && mode !== 'explicit') {
        // Read the real committed state before faulting only its HTTP response.
        const execution = await f.persistence.imageGenerationExecutions!.get({ workspaceId: job.workspaceId, jobId: job.jobId })
        expect(execution?.state).toBe('provider_dispatching')
        if (mode === 'disconnect') { res.destroy(); return }
        res.statusCode = mode === 'ordinary503' ? 503 : 200; res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(mode === 'ordinary503' ? { error: { code: 'ISOLATED_RESPONSE_FAILURE' } } : { data: {} })); return
      }
      res.statusCode = response.status; res.setHeader('content-type', 'application/json'); res.end(text)
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'FIXTURE_PROXY_FAILURE', message: String(error) } })) }
  })
  const base = await listen(proxy)
  try {
    await runWorker(job.workspaceId, base)
    const begin = calls.filter(c => c.operation === 'begin_provider_dispatch')
    expect(begin, JSON.stringify(calls)).toHaveLength(1)
    const execution = await f.persistence.imageGenerationExecutions!.get({ workspaceId: job.workspaceId, jobId: job.jobId })
    const rows = (await f.admin.query('SELECT * FROM outbox_events WHERE id=$1', [job.event.id])).rows
    const budget = (await f.admin.query('SELECT status FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [job.workspaceId, job.action])).rows[0]
    const hold = await f.persistence.creativePoints!.getReservation(job.workspaceId, job.hold.value.id)
    if (mode === 'explicit') {
      expect(begin[0]?.code).toBe('MODEL_TASK_COST_LIMIT_EXCEEDED')
      expect(calls.filter(c => c.operation === 'fail_before_provider').map(c => c.status)).toEqual([200])
      expect(execution?.state).toBe('failed'); expect(budget.status).toBe('released')
      expect(rows[0].unknown_at).toBeNull(); expect(rows[0].last_error.terminal).toBe(true)
    } else {
      expect(begin[0]?.status).toBe(200); expect(execution?.state).toBe('provider_dispatching')
      expect(calls.filter(c => c.operation === 'fail_before_provider')).toHaveLength(0)
      expect(rows[0].unknown_at).not.toBeNull(); expect(budget.status).toBe('active')
    }
    // The normal dispatcher does not settle/release creative points at this boundary.
    expect(hold?.status).toBe('active'); expect(rows[0].published_at).toBeNull(); expect(rows[0].lease_token).toBeNull()
    expect(providerCalls).toBe(0)
    const before = await f.fingerprint(); const beforeBeginCount = begin.length
    await runWorker(job.workspaceId, base)
    expect(await f.fingerprint()).toEqual(before)
    expect(calls.filter(c => c.operation === 'begin_provider_dispatch')).toHaveLength(beforeBeginCount)
    expect(providerCalls).toBe(0)
    evidence.push({ bootstrapProfile: 'development-readiness-then-production-business', mode, execution: execution?.state, outboxUnknown: Boolean(rows[0].unknown_at), budget: budget.status, points: hold?.status, providerCalls, restartUnchanged: true, beginStatus: begin[0]?.status, beginCode: begin[0]?.code })
  } finally { await close(proxy) }
}, 120000)
