import assert from 'node:assert/strict'
import { createConfiguredConnector, type CredentialProvider, type HttpConnectorConfig } from '../packages/connectors/src/index.js'
import { createPublishWorker } from '../packages/workers/src/index.js'
import { WorkerFailure } from '../packages/workers/src/runner.js'

const config: HttpConnectorConfig = {
  clientId: 'acceptance-client',
  oauth: {
    authorizeUrl: 'https://acceptance.invalid/oauth/authorize',
    tokenUrl: 'https://acceptance.invalid/oauth/token',
  },
  api: { baseUrl: 'https://acceptance.invalid/api', syncPath: '/products', createPath: '/products', updatePath: '/products/update', queryPath: '/publish/status' },
  timeoutMs: 25,
  signer: { kind: 'test', sign: () => ({ 'x-test-signature': 'fault-test-only' }) },
  mapProducts: () => [],
  mapWriteReceipt: (_payload, input, operation, platform) => ({ platform, operation, remoteId: input.remoteId ?? 'fault-remote', requestId: 'fault-request', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }),
  mapWriteStatus: () => ({ found: true, state: 'submitted', simulated: false }),
  mappingEvidence: { version: 'fault.mapping.v1', evidenceRef: 'fault-test', verifiedBy: 'test', verifiedAt: '2026-08-22T00:00:00Z' },
}

const configFor = (platform: 'jd' | 'pinduoduo'): HttpConnectorConfig => ({
  ...config,
  capabilityEvidence: ['authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke'].map(capability => ({ platform, capability: capability as any, state: 'test_e2e' as const, evidenceRef: 'fault-test', verifiedBy: 'test', verifiedAt: '2026-08-22T00:00:00Z' })),
})

const credentials: CredentialProvider = {
  kind: 'test',
  async resolve() { return { accessToken: 'acceptance-token' } },
  async store({ accountId }) { return { accountId, credentialRef: `test/${accountId}` } },
}

const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function runFaultAcceptance() {
  const rateLimited = createConfiguredConnector('pinduoduo', {
    config: configFor('pinduoduo'),
    credentials,
    allowTestCredentials: true,
    allowTestAdapters: true,
    fetch: async () => jsonResponse({ code: 'rate_limited' }, 429),
  })
  await assert.rejects(
    rateLimited.syncProducts({ workspaceId: 'ws_fault_429', accountId: 'acct_fault' }),
    error => (error as { normalized?: { code?: string; retryable?: boolean; status?: number } }).normalized?.code === 'RATE_LIMITED'
      && (error as { normalized: { retryable: boolean } }).normalized.retryable
      && (error as { normalized: { status: number } }).normalized.status === 429,
  )

  const timeoutConnector = createConfiguredConnector('jd', {
    config: configFor('jd'),
    credentials,
    allowTestCredentials: true,
    allowTestAdapters: true,
    fetch: async () => { const error = new Error('aborted acceptance-token'); error.name = 'AbortError'; throw error },
  })
  await assert.rejects(
    timeoutConnector.syncProducts({ workspaceId: 'ws_fault_timeout', accountId: 'acct_fault' }),
    error => (error as { normalized?: { code?: string; retryable?: boolean; unknown?: boolean } }).normalized?.code === 'TIMEOUT'
      && (error as { normalized: { retryable: boolean } }).normalized.retryable
      && (error as { normalized: { unknown: boolean } }).normalized.unknown === true,
  )

  let attempts = 0
  let now = 0
  const worker = createPublishWorker(async () => {
    attempts += 1
    throw new WorkerFailure({ code: 'RATE_LIMITED', message: 'acceptance backoff', retryable: true })
  }, { baseDelayMs: 0, now: () => now })
  const job = worker.enqueue({ workspaceId: 'ws_fault_429', idempotencyKey: 'fault-429', payload: { taskId: 'task', contentVersionId: 'cv', platform: 'jd', idempotencyKey: 'fault-429' }, maxAttempts: 3 })
  await worker.runNext(); await worker.runNext(); await worker.runNext()
  assert.equal(attempts, 3)
  assert.equal(job.state, 'dead_letter')
  assert.equal(job.lastError?.code, 'RATE_LIMITED')

  const unknownWorker = createPublishWorker(async () => {
    throw new WorkerFailure({ code: 'TIMEOUT', message: 'remote outcome unknown', retryable: true, unknown: true })
  }, { baseDelayMs: 0, now: () => now })
  const unknown = unknownWorker.enqueue({ workspaceId: 'ws_fault_timeout', idempotencyKey: 'fault-timeout', payload: { taskId: 'task', contentVersionId: 'cv', platform: 'jd', idempotencyKey: 'fault-timeout' } })
  await unknownWorker.runNext()
  assert.equal(unknown.state, 'unknown')
  assert.throws(() => unknownWorker.retryUnknown(unknown.id, { remoteAbsent: false, safeToRetry: false }))
  unknownWorker.retryUnknown(unknown.id, { remoteAbsent: true, safeToRetry: true })
  assert.equal(unknown.state, 'queued')
  now += 1
  await unknownWorker.runNext()
  assert.equal(unknown.state, 'unknown')

  return { profile: 'fault_injection_local', connectorTransport: 'stubbed_fetch', workerTransport: 'in_memory_runner', rateLimit: '429->retry->dead_letter', timeout: 'timeout->unknown->proof_required' }
}

if (process.argv[1]?.endsWith('/fault-acceptance.ts')) console.log(JSON.stringify(await runFaultAcceptance()))
