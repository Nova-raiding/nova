import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { productionCommercialReadiness, productionReadinessDiagnostics, route, runtimeHealth, validateCapacityEvidenceRuntime, validateManualOperationsEvidenceRuntime } from './server.js'
import { startPlatformRelayTokenQuotaMonitor } from '../../../packages/ai/src/platform-model-gate.js'
import { MemoryCommercialCatalogRepository } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import { manualCaptureJournal, manualCaptureJournalSha256, manualCaptureObservationSha256 } from '../../../tests/manual-operations-evidence-fixture.js'

type Envelope = {
  data: unknown
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

const productionEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  CONNECTOR_FIXTURE_MODE: 'false',
  MCP_AUTHZ_MODE: 'enforce',
  AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
  MODEL_RELAY_BASE_URL: 'https://relay.example.test/v1',
  MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.test',
  MODEL_RELAY_API_KEY: 'relay-key',
  AI_MODEL: 'text-model',
  IMAGE_MODEL: 'image-model',
  IMAGE_EDIT_MODEL: 'image-edit-model',
  OCR_MODEL: 'ocr-model',
  VIDEO_MODEL: 'video-model',
  EMBEDDING_MODEL: 'embedding-model',
  EMBEDDING_DIMENSIONS: '1536',
  MODEL_EMBEDDING_MAX_REQUEST_CNY: '0.10',
  MODEL_RELAY_EMBEDDING_COST_EVIDENCE: 'true',
  MODEL_RPM_LIMIT: '120',
  MODEL_TPM_LIMIT: '120000',
  MODEL_DAILY_CNY_LIMIT: '100',
  MODEL_MAX_TASK_COST_CNY: '10',
  MODEL_RELAY_TEXT_COST_EVIDENCE: 'true',
  MODEL_RELAY_IMAGE_COST_EVIDENCE: 'true',
  MODEL_RELAY_IMAGE_EDIT_COST_EVIDENCE: 'true',
  MODEL_RELAY_OCR_COST_EVIDENCE: 'true',
  MODEL_RELAY_VIDEO_COST_EVIDENCE: 'true',
  OPS_AUTH_MODE: 'password',
  SESSION_ID_HASH_SECRET: 'session-hash-secret',
  OPS_DATABASE_URL: 'postgres://merchant_ops@database/store_nova',
  MERCHANT_BEARER_HOSTNAME: 'merchant.example.test',
  PUBLIC_OPS_BASE_URL: 'https://ops.example.test',
  MCP_INTEGRATION_MODE: 'local_stdio',
  PUBLIC_APP_BASE_URL: 'https://merchant.example.test',
  API_AUTH_TOKENS: JSON.stringify({
    'merchant-token': { actor_id: 'merchant-owner', workspaces: ['ws_production'], roles: ['workspace_owner'] },
  }),
  ASSET_STORAGE_BUCKET: 'merchant-assets',
  ASSET_STORAGE_REGION: 'cn-test-1',
  ASSET_STORAGE_ENDPOINT: 'https://storage.example.test',
  ASSET_STORAGE_CREDENTIAL_MODE: 'aliyun_ecs_ram_role',
  ASSET_STORAGE_SSE_MODE: 'aws:kms',
  ASSET_STORAGE_KMS_KEY_ID: 'kms-key-ref',
  ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
  ASSET_STORAGE_ECS_RAM_ROLE: 'merchant-oss-role',
  PUBLIC_ASSET_BASE_URL: 'https://merchant.example.test',
  ASSET_DISPLAY_URL_SIGNING_SECRET: 'production-display-signing-secret-32-bytes-minimum',
  ASSET_DISPLAY_URL_SIGNING_KEY_ID: 'display-2026-08',
  ASSET_SCANNER_MODE: 'clamav_worker',
  ASSET_SCANNER_API_TOKEN: 'scanner-api-token',
  ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: 'scanner-signing-secret',
  ASSET_SCAN_POLICY_VERSION: 'asset-scan-policy-v1',
  ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'scanner-production',
  ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000',
  ASSET_SCAN_TRUSTED_PUBLIC_KEYS: JSON.stringify({ scanner: '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----' }),
  PAYMENT_MODE: 'provider',
  PAYMENT_PROVIDER_ADAPTERS: 'alipay,wechat',
  PAYMENT_CHECKOUT_BASE_URL: 'https://payments.example.test/checkout',
  PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example.test/v1/checkout',
  PAYMENT_PROVIDER_QUERY_API_URL: 'https://payments.example.test/v1/query',
  PAYMENT_PROVIDER_REFUND_QUERY_API_URL: 'https://payments.example.test/v1/refund/query',
  PAYMENT_PROVIDER_REFUND_API_URL: 'https://payments.example.test/v1/refund',
  PAYMENT_PROVIDER_API_KEY: 'payment-provider-key',
  PAYMENT_PROVIDER_MERCHANT_ID: 'merchant-production',
  PAYMENT_CALLBACK_BASE_URL: 'https://merchant.example.test/v1',
  PAYMENT_CALLBACK_SECRET: 'payment-callback-secret',
  PAYMENT_RECONCILIATION_ENABLED: 'true',
  PAYMENT_REFUND_ENABLED: 'true',
  PLATFORM_RULE_SYNC_MANIFEST_URL: 'https://rules.example.test/platform-rules/v1/manifest.json',
  PLATFORM_RULE_SYNC_SIGNING_SECRET: 'rule-sync-signing-secret',
  PLATFORM_RULE_SYNC_INTERVAL_HOURS: '24',
  OBJECT_STORAGE_VERSIONING: 'true',
  DATA_RETENTION_DAYS: '90',
  ASSET_QUARANTINE_RETENTION_DAYS: '7',
  ASSET_CLEAN_RETENTION_DAYS: '30',
  DELETION_REQUEST_GRACE_DAYS: '7',
  BACKUP_RETENTION_DAYS: '30',
  LIFECYCLE_POLICY_REF: 'oss://merchant-assets/lifecycle/assets-v1',
  ALERT_CHANNEL_SECRET_REF: 'vault://merchant-alert-channel',
  OPS_ALERT_NOTIFICATIONS_ENABLED: 'true',
  OPS_ALERT_WEBHOOK_URL: 'https://alerts.example.test/merchant',
  OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: 'alerts.example.test',
  OPS_ALERT_WEBHOOK_SECRET: 'production-alert-webhook-secret',
  RELEASE_ID: 'release-0.1.1',
  RELEASE_GIT_SHA: 'a'.repeat(40),
  RELEASE_MANIFEST_SHA256: 'b'.repeat(64),
  RELEASE_IMAGE_SET_DIGEST: `sha256:${'c'.repeat(64)}`,
  PLUGIN_VERSION: '0.1.0+production',
  SKILL_BUNDLE_VERSION: '0.1.0+production',
  MCP_VERSION: '217',
  CONNECTOR_BUILD: 'connector-production-1',
  PROMPT_BUNDLE_VERSION: 'prompt-production-1',
})

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  const testServer = createServer((req, res) => { void route(req, res) })
  await new Promise<void>((resolve, reject) => {
    testServer.once('error', reject)
    testServer.listen(0, '127.0.0.1', resolve)
  })
  const address = testServer.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return { server: testServer, baseUrl: `http://127.0.0.1:${address.port}` }
}

const openServers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('production readiness fail-closed', () => {
  it('surfaces relay quota rate limiting in production readiness and keeps /readyz at 503', async () => {
    const environment = productionEnvironment()
    const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } })) as unknown as typeof fetch
    const stop = startPlatformRelayTokenQuotaMonitor(environment, fetcher)
    try {
      await vi.waitFor(() => {
        const result = productionReadinessDiagnostics(environment)
        expect(result.gates.relay?.reasons).toEqual(expect.arrayContaining([
          'text:relay_token_quota_rate_limited',
          'image:relay_token_quota_rate_limited',
          'image_edit:relay_token_quota_rate_limited',
          'ocr:relay_token_quota_rate_limited',
          'video:relay_token_quota_rate_limited',
        ]))
      })
      for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
      const running = await listen()
      openServers.push(running.server)
      const response = await fetch(`${running.baseUrl}/readyz`)
      const body = await response.json() as Envelope
      expect(response.status).toBe(503)
      expect(body.error).toMatchObject({ code: 'PRODUCTION_READINESS_BLOCKED' })
      expect(body.error?.details).toMatchObject({ gates: { relay: { ready: false } } })
      expect(JSON.stringify(body.error?.details)).toContain('video:relay_token_quota_rate_limited')
    } finally { stop() }
  })

  it('keeps the video capability blocked when its relay credential is rejected', async () => {
    const environment = productionEnvironment()
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>)?.authorization
      if (authorization === 'Bearer video-key') return new Response('', { status: 401 })
      return new Response(JSON.stringify({ code: true, data: { object: 'token_usage', unlimited_quota: false, total_granted: 100, total_used: 20, total_available: 80, expires_at: 0 } }), { status: 200 })
    }) as unknown as typeof fetch
    environment.VIDEO_MODEL_RELAY_API_KEY = 'video-key'
    const stop = startPlatformRelayTokenQuotaMonitor(environment, fetcher)
    try {
      await vi.waitFor(() => {
        const result = productionReadinessDiagnostics(environment)
        expect(result.gates.relay?.reasons).toContain('video:relay_token_auth_failed')
      })
      const result = productionReadinessDiagnostics(environment)
      expect(result.ready).toBe(false)
      expect(result.gates.relay?.reasons).toContain('video:relay_token_auth_failed')
      expect(result.gates.relay?.reasons).not.toContain('text:relay_token_auth_failed')
    } finally { stop() }
  })

  it('marks both relay capabilities stale after the quota evidence freshness window', async () => {
    const environment = productionEnvironment()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: true, data: { object: 'token_usage', unlimited_quota: false, total_granted: 100, total_used: 20, total_available: 80, expires_at: 0 } }), { status: 200 })) as unknown as typeof fetch
    const stop = startPlatformRelayTokenQuotaMonitor(environment, fetcher, { refreshIntervalMs: 30_000, maxAgeMs: 90_000 })
    try {
      await vi.waitFor(() => expect(productionReadinessDiagnostics(environment).gates.relay?.ready).toBe(true))
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 91_000)
      try {
        const result = productionReadinessDiagnostics(environment)
        expect(result.ready).toBe(false)
        expect(result.gates.relay?.reasons).toEqual(expect.arrayContaining([
          'text:relay_token_quota_stale',
          'video:relay_token_quota_stale',
        ]))
      } finally { clock.mockRestore() }
    } finally { stop() }
  })

  it('validates the manual operations evidence contract independently of the official API canary', () => {
    const generatedAt = '2026-09-22T01:00:00Z'
    const journal = manualCaptureJournal({ release_id: 'release-current', release_git_sha: 'a'.repeat(40), manifest_sha256: 'b'.repeat(64), image_set_digest: `sha256:${'c'.repeat(64)}` }, generatedAt)
    const evidence = {
      schema_version: 'manual-operations-evidence/2', release_id: 'release-current', environment: 'production',
      workflow: 'manual_operations_read_only', workspace_id: 'workspace-current', isolation_probe_workspace_id: 'workspace-isolation',
      verified_by: 'release-operator', manual_evidence_boundary: 'manual_unverified',
      official_api_receipt: false, tenant_isolation_verified: true, simulated: false,
      generated_at: generatedAt, expires_at: '2026-09-23T01:00:00Z', capture_journal: journal, capture_journal_sha256: manualCaptureJournalSha256(journal),
      checks: [
        { name: 'tenant_scope', status: 'pass', observation: 'target_workspace_read_contract' },
        { name: 'manual_route', status: 'pass', observation: 'publish_manual_list_read_only' },
        { name: 'isolation_boundary', status: 'pass', observation: 'foreign_workspace_rejected' },
      ],
    }
    expect(validateManualOperationsEvidenceRuntime(evidence, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toEqual([])
    expect(validateManualOperationsEvidenceRuntime({ ...evidence, release_id: 'release-other', simulated: true }, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toEqual(expect.arrayContaining([
      'release_id must match RELEASE_ID', 'simulated must be false',
    ]))
    const missingJournal = { ...evidence, capture_journal: undefined }
    expect(validateManualOperationsEvidenceRuntime(missingJournal, { now: new Date('2026-09-22T02:00:00Z') })).toContain('capture_journal is required')
    expect(validateManualOperationsEvidenceRuntime({ ...evidence, manual_evidence_boundary: 'unknown' }, { now: new Date('2026-09-22T02:00:00Z') })).toContain('manual_evidence_boundary must be manual_unverified')
    expect(validateManualOperationsEvidenceRuntime({ ...evidence, workflow: 'public_import_manual_publish' }, { now: new Date('2026-09-22T02:00:00Z') })).toContain('workflow must be manual_operations_read_only')
    expect(validateManualOperationsEvidenceRuntime({ ...evidence, isolation_probe_workspace_id: 'workspace-current' }, { now: new Date('2026-09-22T02:00:00Z') })).toContain('isolation probe workspace must differ from target workspace')
    const malformedTargetListJournal = structuredClone(journal)
    const listObservation = malformedTargetListJournal.observations.find(observation => observation.name === 'target_list')!
    listObservation.material.tenant_scoped = false
    listObservation.observation_sha256 = manualCaptureObservationSha256(listObservation.name, listObservation.status, listObservation.material)
    expect(validateManualOperationsEvidenceRuntime({ ...evidence, capture_journal: malformedTargetListJournal, capture_journal_sha256: manualCaptureJournalSha256(malformedTargetListJournal) }, { now: new Date('2026-09-22T02:00:00Z') }))
      .toContain('capture_journal target list material is invalid')
  })

  it('rejects stale or differently-bound capacity evidence at runtime', () => {
    const base = {
      schema_version: '1', status: 'pass', cloud_gate: true, environment: 'preproduction', release_id: 'release-other',
      platform_mock_ratio: 0, model_mock_ratio: 0, profile: 'pilot_50', sign_off: { verified_by: 'qa', verified_at: '2026-09-01T00:00:00Z' },
      expires_at: '2026-09-02T00:00:00Z', metrics: { workspaces: 50 },
    }
    expect(validateCapacityEvidenceRuntime(base, { expectedReleaseId: 'release-current', now: new Date('2026-09-03T00:00:00Z') })).toEqual(expect.arrayContaining([
      'release_id must match RELEASE_ID',
      'capacity evidence is expired',
    ]))
  })

  it('accepts only an explicitly release-bound no-load declaration and never treats it as pass', () => {
    const noLoad = {
      schema_version: '1', status: 'not_performed', cloud_gate: false, environment: 'production',
      release_id: 'release-current', software_version: 'release-current', config_version: 'config-current', data_version: 'migration-242', profile: 'no_load',
      target_url: 'https://yxsona.com', started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z',
      scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope',
      generated_at: '2026-09-22T01:00:00Z',
      sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' },
      expires_at: '2026-09-23T01:00:00Z',
    }
    expect(validateCapacityEvidenceRuntime(noLoad, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toEqual([])
    const offsetTimestamps = { ...noLoad, started_at: '2026-09-22T01:00:00+01:00', ended_at: '2026-09-22T02:00:00+01:00', sign_off: { verified_by: 'owner', verified_at: '2026-09-22T02:00:00+01:00' }, expires_at: '2026-09-24T01:00:00+01:00' }
    expect(validateCapacityEvidenceRuntime(offsetTimestamps, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toEqual([])
    expect(validateCapacityEvidenceRuntime({ ...noLoad, release_id: '' }, { now: new Date('2026-09-22T02:00:00Z') })).toContain('release_id is required for no_load evidence')
    expect(validateCapacityEvidenceRuntime({ ...noLoad, sign_off: { ...noLoad.sign_off, verified_at: '2026-09-22T01:01:00Z' } }, { now: new Date('2026-09-22T02:00:00Z') })).toContain('sign_off.verified_at must fall within the declaration interval')
    expect(validateCapacityEvidenceRuntime({ ...noLoad, ended_at: '2026-09-22T03:00:00Z' }, { now: new Date('2026-09-22T02:00:00Z') })).toContain('no_load declaration must not be future dated')
    expect(validateCapacityEvidenceRuntime({ ...noLoad, release_id: 'release-other' }, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toContain('release_id must match RELEASE_ID')
    expect(validateCapacityEvidenceRuntime({ ...noLoad, status: 'pass' }, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toContain('status must be not_performed for no_load evidence')
  })

  it.each([
    ['metrics', {}],
    ['duration', {}],
    ['tenant', {}],
    ['fault', {}],
    ['steady_state', {}],
    ['raw_metrics_ref', 'artifact://metrics/1'],
    ['platform_mock_ratio', 0],
    ['model_mock_ratio', 0],
    ['accepted_jobs', 0],
    ['completeness', { observations_valid: true }],
    ['p95_ms', 100],
    ['future_measurement', 100],
  ])('rejects no-load runtime evidence containing unsupported field %s', (field, fieldValue) => {
    const noLoad = {
      schema_version: '1', status: 'not_performed', cloud_gate: false, environment: 'production',
      release_id: 'release-current', software_version: 'release-current', config_version: 'config-current', data_version: 'migration-242', profile: 'no_load',
      target_url: 'https://yxsona.com', started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z',
      scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope',
      sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' }, expires_at: '2026-09-23T01:00:00Z',
    }
    expect(validateCapacityEvidenceRuntime({ ...noLoad, [field]: fieldValue }, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') }))
      .toContain(`no_load evidence contains unsupported fields: ${field}`)
  })

  it.each([
    ['http://yxsona.com', 'no_load target_url must be HTTPS without credentials or a fragment'],
    ['https://user:secret@yxsona.com', 'no_load target_url must be HTTPS without credentials or a fragment'],
    ['https://yxsona.com/#fragment', 'no_load target_url must be HTTPS without credentials or a fragment'],
    ['not-a-url', 'target_url must be a valid URL'],
  ])('rejects invalid no-load runtime target URL %s', (targetUrl, expectedError) => {
    const noLoad = {
      schema_version: '1', status: 'not_performed', cloud_gate: false, environment: 'production',
      release_id: 'release-current', software_version: 'release-current', config_version: 'config-current', data_version: 'migration-242', profile: 'no_load',
      target_url: targetUrl, started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z',
      scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope',
      sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' }, expires_at: '2026-09-23T01:00:00Z',
    }
    expect(validateCapacityEvidenceRuntime(noLoad, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') })).toContain(expectedError)
  })

  it.each([
    ['metrics', {}],
    ['future_signoff_field', 'unexpected'],
  ])('rejects no-load runtime sign_off containing unsupported field %s', (field, fieldValue) => {
    const noLoad = {
      schema_version: '1', status: 'not_performed', cloud_gate: false, environment: 'production',
      release_id: 'release-current', software_version: 'release-current', config_version: 'config-current', data_version: 'migration-242', profile: 'no_load',
      target_url: 'https://yxsona.com', started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z',
      scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope',
      sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' }, expires_at: '2026-09-23T01:00:00Z',
    }
    expect(validateCapacityEvidenceRuntime({ ...noLoad, sign_off: { ...noLoad.sign_off, [field]: fieldValue } }, { expectedReleaseId: 'release-current', now: new Date('2026-09-22T02:00:00Z') }))
      .toContain(`no_load sign_off contains unsupported fields: ${field}`)
  })

  it('projects a valid file-backed no-load report as not_performed over HTTP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'capacity-no-load-'))
    const now = new Date()
    const startedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const endedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    const report = { schema_version: '1', status: 'not_performed', cloud_gate: false, environment: 'production', release_id: 'release-current', software_version: 'release-current', config_version: 'config-current', data_version: 'migration-242', target_url: 'https://ops.example.test', started_at: startedAt, ended_at: endedAt, expires_at: expiresAt, profile: 'no_load', scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope', sign_off: { verified_by: 'owner', verified_at: endedAt } }
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify(report))
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CAPACITY_REPORT_PATH', join(directory, 'capacity.json'))
    vi.stubEnv('RELEASE_ID', 'release-current')
    const running = await listen()
    openServers.push(running.server)
    const response = await fetch(`${running.baseUrl}/healthz`)
    const body = await response.json() as Envelope & { data: { setup: { productionEvidence: { capacity: Record<string, unknown> } } } }
    expect([200, 503]).toContain(response.status)
    if (body.data) expect(body.data.setup.productionEvidence.capacity).toMatchObject({ state: 'not_performed', configured: true, profile: 'no_load', releaseId: 'release-current' })
    else expect(runtimeHealth({ commercialReadiness: { ready: true, reasons: [] } })).toMatchObject({ setup: { productionEvidence: { capacity: { state: 'not_performed', configured: true, profile: 'no_load', releaseId: 'release-current' } } } })
  })

  it('reads the API-readable runtime handoff when the signer source path is unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'capacity-runtime-handoff-'))
    const now = new Date()
    const endedAt = now.toISOString()
    const report = { schema_version: '1', status: 'not_performed', cloud_gate: false, environment: 'production', release_id: 'release-current', software_version: 'release-current', config_version: 'config-current', data_version: 'migration-242', target_url: 'https://ops.example.test', started_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), ended_at: endedAt, expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), profile: 'no_load', scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope', sign_off: { verified_by: 'owner', verified_at: endedAt } }
    const runtimePath = join(directory, 'capacity-runtime.json')
    writeFileSync(runtimePath, JSON.stringify(report))
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CAPACITY_REPORT_PATH', join(directory, 'missing-signer-source.json'))
    vi.stubEnv('CAPACITY_RUNTIME_EVIDENCE_PATH', runtimePath)
    vi.stubEnv('RELEASE_ID', 'release-current')
    const running = await listen()
    openServers.push(running.server)
    const response = await fetch(`${running.baseUrl}/healthz`)
    const body = await response.json() as Envelope & { data: { setup: { productionEvidence: { capacity: Record<string, unknown> } } } }
    expect([200, 503]).toContain(response.status)
    if (body.data) expect(body.data.setup.productionEvidence.capacity).toMatchObject({ state: 'not_performed', configured: true, profile: 'no_load', releaseId: 'release-current' })
  })

  it('requires persistence-backed executable catalog, approved rates, and an enabled charged registry operation', async () => {
    const blocked = await productionCommercialReadiness(new MemoryCommercialCatalogRepository([], []))
    expect(blocked.ready).toBe(false)
    expect(blocked.reasons).toEqual([
      'commercial_executable_catalog_missing',
      'commercial_executable_monthly_plan_missing',
      'commercial_approved_rate_missing',
    ])

    const pointPackOnly = await productionCommercialReadiness(new MemoryCommercialCatalogRepository([{
      id: 'sku-points', code: 'points_500', kind: 'point_pack', visibility: 'public', requiredCapability: null,
      versionId: 'sku-points-v1', version: 1, lifecycle: 'approved', executable: true, priceFen: 100,
      currency: 'CNY', priceMode: 'fixed', durationDays: 30, payload: {}, checksum: 'points-checksum',
      effectiveAt: new Date().toISOString(), benefits: [],
    }], [{
      rateCardId: 'rate-v1', version: 1, actionCode: 'image.generate.standard', unit: 'image',
      integerPoints: 1, checksum: 'rate-checksum', effectiveAt: new Date().toISOString(),
    }]))
    expect(pointPackOnly.ready).toBe(false)
    expect(pointPackOnly.reasons).toEqual(['commercial_executable_monthly_plan_missing'])
    expect(pointPackOnly.catalog).toEqual({ executable: 1, executable_monthly: 0 })

    const executable = await productionCommercialReadiness(new MemoryCommercialCatalogRepository([{
      id: 'sku-1', code: 'basic', kind: 'monthly', visibility: 'public', requiredCapability: null,
      versionId: 'sku-v1', version: 1, lifecycle: 'approved', executable: true, priceFen: 100,
      currency: 'CNY', priceMode: 'fixed', durationDays: 30, payload: {}, checksum: 'sku-checksum',
      effectiveAt: new Date().toISOString(), benefits: [],
    }], [{
      rateCardId: 'rate-v1', version: 1, actionCode: 'image.generate.standard', unit: 'image',
      integerPoints: 1, checksum: 'rate-checksum', effectiveAt: new Date().toISOString(),
    }]))
    expect(executable.ready).toBe(true)
    expect(executable.reasons).toEqual([])
    expect(executable.catalog).toEqual({ executable: 1, executable_monthly: 1 })
  })

  it('requires live relay quota evidence alongside static critical production gates without leaking secrets', () => {
    const ready = productionReadinessDiagnostics(productionEnvironment())
    expect(ready).toMatchObject({
      required: true,
      ready: false,
      gates: {
        relay: { ready: false, reasons: expect.arrayContaining(['relay:relay_token_quota_monitor_unavailable']) },
        authorization: { ready: true },
        identity: { ready: true },
        object_storage: { ready: true },
        payment: { ready: true },
        rule_sync: { ready: true },
        cost: { ready: true },
        alerts: { ready: true },
        release_metadata: { ready: true },
      },
    })

    const cases: Array<{ gate: string; key: string }> = [
      { gate: 'relay', key: 'MODEL_RELAY_API_KEY' },
      { gate: 'authorization', key: 'MCP_AUTHZ_MODE' },
      { gate: 'authorization', key: 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED' },
      { gate: 'identity', key: 'OPS_AUTH_MODE' },
      { gate: 'identity', key: 'OPS_DATABASE_URL' },
      { gate: 'identity', key: 'PUBLIC_OPS_BASE_URL' },
      { gate: 'identity', key: 'MCP_INTEGRATION_MODE' },
      { gate: 'identity', key: 'PUBLIC_APP_BASE_URL' },
      { gate: 'object_storage', key: 'ASSET_STORAGE_KMS_KEY_ID' },
      { gate: 'object_storage', key: 'ASSET_DISPLAY_URL_SIGNING_SECRET' },
      { gate: 'asset_scanner', key: 'ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS' },
      { gate: 'asset_scanner', key: 'ASSET_SCAN_MIN_DEFINITIONS_VERSION' },
      { gate: 'payment', key: 'PAYMENT_PROVIDER_API_KEY' },
      { gate: 'payment', key: 'PAYMENT_CALLBACK_SECRET' },
      { gate: 'payment', key: 'PAYMENT_RECONCILIATION_ENABLED' },
      { gate: 'rule_sync', key: 'PLATFORM_RULE_SYNC_MANIFEST_URL' },
      { gate: 'rule_sync', key: 'PLATFORM_RULE_SYNC_SIGNING_SECRET' },
      { gate: 'cost', key: 'MODEL_DAILY_CNY_LIMIT' },
      { gate: 'cost', key: 'MODEL_MAX_TASK_COST_CNY' },
      { gate: 'alerts', key: 'OPS_ALERT_WEBHOOK_URL' },
      { gate: 'alerts', key: 'OPS_ALERT_WEBHOOK_ALLOWED_HOSTS' },
      { gate: 'alerts', key: 'OPS_ALERT_WEBHOOK_SECRET' },
      { gate: 'release_metadata', key: 'RELEASE_MANIFEST_SHA256' },
    ]
    for (const { gate, key } of cases) {
      const environment = productionEnvironment()
      delete environment[key]
      const result = productionReadinessDiagnostics(environment)
      expect(result.ready, `${gate}:${key} must fail closed`).toBe(false)
      expect(result.gates[gate], `${gate}:${key} gate detail`).toMatchObject({ ready: false })
      expect(JSON.stringify(result)).not.toContain('relay-key')
      expect(JSON.stringify(result)).not.toContain('oidc-signing-secret')
      expect(JSON.stringify(result)).not.toContain('merchant-token')
      expect(JSON.stringify(result)).not.toContain('payment-provider-key')
      expect(JSON.stringify(result)).not.toContain('rule-sync-signing-secret')
    }
  })

  it('keeps lexical knowledge search independent of embedding while relay quota is unknown', () => {
    const environment = productionEnvironment()
    delete environment.EMBEDDING_MODEL
    delete environment.EMBEDDING_DIMENSIONS
    delete environment.MODEL_EMBEDDING_MAX_REQUEST_CNY
    delete environment.MODEL_RELAY_EMBEDDING_COST_EVIDENCE
    environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'false'

    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.relay?.reasons).toContain('relay:relay_token_quota_monitor_unavailable')
    expect(result.gates.cost).toMatchObject({ ready: true })
  })

  it('blocks vector indexing until semantic queries have independent authorization and settlement', () => {
    const environment = productionEnvironment()
    environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'true'
    environment.EMBEDDING_DIMENSIONS = '1024'
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.knowledge_vector_query).toEqual({ ready: false, reasons: ['semantic_query_authorization_budget_settlement_unavailable'] })
    environment.KNOWLEDGE_VECTOR_INDEX_ENABLED = 'false'
    expect(productionReadinessDiagnostics(environment).gates.knowledge_vector_query).toEqual({ ready: true, reasons: [] })
  })

  it.each([
    ['OPS_AUTH_MODE', 'oidc', 'ops_auth_mode_must_be_password'],
    ['MCP_INTEGRATION_MODE', 'remote_oauth', 'mcp_integration_mode_must_be_local_stdio'],
    ['MCP_OAUTH_REQUIRED', 'true', 'retired_external_auth_settings_present'],
    ['MCP_OAUTH_ISSUER', 'https://accounts.example.test', 'retired_external_auth_settings_present'],
    ['OIDC_PROXY_SIGNING_SECRET', 'retired-secret', 'retired_external_auth_settings_present'],
    ['PUBLIC_APP_BASE_URL', 'http://merchant.example.test', 'public_app_base_url_invalid'],
    ['PUBLIC_APP_BASE_URL', 'https://other.example.test/mcp', 'public_app_base_url_invalid'],
    ['PUBLIC_OPS_BASE_URL', 'http://ops.example.test', 'public_ops_base_url_invalid'],
    ['PUBLIC_OPS_BASE_URL', 'https://merchant.example.test', 'ops_and_merchant_hostnames_must_differ'],
  ])('rejects non-canonical production identity setting %s=%s', (key, value, reason) => {
    const environment = productionEnvironment()
    environment[key] = value
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining([reason]) })
  })

  it('accepts OSS AES256 encryption without requiring a KMS key', () => {
    const environment = productionEnvironment()
    environment.ASSET_STORAGE_SSE_MODE = 'AES256'
    delete environment.ASSET_STORAGE_KMS_KEY_ID

    const result = productionReadinessDiagnostics(environment)
    expect(result.gates.object_storage).toMatchObject({ ready: true, reasons: [] })
  })

  it('requires local stdio production identity and password login', () => {
    const environment = productionEnvironment()
    const result = productionReadinessDiagnostics(environment)
    expect(result.gates.identity).toMatchObject({ ready: true, reasons: [] })
  })

  it('fails closed when production MCP integration mode is absent', () => {
    const missing = productionEnvironment()
    delete missing.MCP_INTEGRATION_MODE
    expect(productionReadinessDiagnostics(missing).gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining(['mcp_integration_mode_must_be_local_stdio']) })

  })

  it('accepts ACK RRSA only when the admission-injected pod identity is complete', () => {
    const environment = productionEnvironment()
    environment.ASSET_STORAGE_CREDENTIAL_PROVIDER = 'aliyun_ack_rrsa'
    delete environment.ASSET_STORAGE_ECS_RAM_ROLE
    environment.ALIBABA_CLOUD_ROLE_ARN = 'acs:ram::1600188311395090:role/StoreNovaAckOssRole'
    environment.ALIBABA_CLOUD_OIDC_PROVIDER_ARN = 'acs:ram::1600188311395090:oidc-provider/ack-rrsa-cluster1'
    environment.ALIBABA_CLOUD_OIDC_TOKEN_FILE = '/var/run/secrets/ack.alibabacloud.com/rrsa-tokens/token'

    expect(productionReadinessDiagnostics(environment).gates.object_storage).toMatchObject({ ready: true, reasons: [] })
    delete environment.ALIBABA_CLOUD_OIDC_TOKEN_FILE
    expect(productionReadinessDiagnostics(environment).gates.object_storage).toMatchObject({
      ready: false,
      reasons: ['alibaba_cloud_oidc_token_file_missing_or_invalid'],
    })
  })

  it('does not allow an ACK deployment to fall back to shared ECS node metadata', () => {
    const environment = productionEnvironment()
    environment.ASSET_STORAGE_CREDENTIAL_PROVIDER = 'aliyun_ack_rrsa'
    environment.ALIBABA_CLOUD_ROLE_ARN = 'acs:ram::1600188311395090:role/StoreNovaAckOssRole'
    environment.ALIBABA_CLOUD_OIDC_PROVIDER_ARN = 'acs:ram::1600188311395090:oidc-provider/ack-rrsa-cluster1'
    delete environment.ALIBABA_CLOUD_OIDC_TOKEN_FILE

    expect(productionReadinessDiagnostics(environment).gates.object_storage?.ready).toBe(false)
  })

  it.each([
    ['LIFECYCLE_POLICY_REF', 'policy://production/assets-v1'],
    ['LIFECYCLE_POLICY_REF', 'oss://another-bucket/lifecycle/assets-v1'],
    ['LIFECYCLE_POLICY_REF', 'oss://merchant-assets/lifecycle/placeholder'],
    ['ALERT_CHANNEL_SECRET_REF', 'secret://production/alerts'],
    ['ALERT_CHANNEL_SECRET_REF', 'vault://placeholder'],
  ])('rejects an unbound or placeholder lifecycle control reference in %s', (key, value) => {
    const environment = productionEnvironment()
    environment[key] = value
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.object_storage).toMatchObject({ ready: false })
  })

  it('binds lifecycle readiness to the operational alert channel configuration', () => {
    const environment = productionEnvironment()
    delete environment.OPS_ALERT_WEBHOOK_SECRET
    const result = productionReadinessDiagnostics(environment)
    expect(result.gates.object_storage!.ready).toBe(false)
    expect(result.gates.object_storage!.reasons).toContain('lifecycle:alert channel is not verifiable: OPS_ALERT_WEBHOOK_SECRET 未配置')
  })

  it('allows alerts to be explicitly disabled without weakening lifecycle, storage or relay quota controls', () => {
    const environment = productionEnvironment()
    environment.OPS_ALERT_NOTIFICATIONS_ENABLED = 'false'
    delete environment.ALERT_CHANNEL_SECRET_REF
    delete environment.OPS_ALERT_WEBHOOK_URL
    delete environment.OPS_ALERT_WEBHOOK_ALLOWED_HOSTS
    delete environment.OPS_ALERT_WEBHOOK_SECRET
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.relay?.reasons).toContain('relay:relay_token_quota_monitor_unavailable')
    expect(result.gates.alerts).toEqual({ ready: true, reasons: [] })
    expect(result.gates.object_storage).toEqual({ ready: true, reasons: [] })

    delete environment.LIFECYCLE_POLICY_REF
    const withoutLifecycle = productionReadinessDiagnostics(environment)
    expect(withoutLifecycle.ready).toBe(false)
    expect(withoutLifecycle.gates.object_storage?.reasons).toContain('lifecycle:LIFECYCLE_POLICY_REF must bind the configured bucket and rule as oss://<bucket>/lifecycle/<rule-id>')
  })

  it.each([
    ['payment', 'PAYMENT_MODE', 'fixture'],
    ['payment', 'PAYMENT_PROVIDER_ADAPTERS', ''],
    ['payment', 'PAYMENT_PROVIDER_QUERY_API_URL', 'http://payments.example.test/query'],
    ['payment', 'PAYMENT_PROVIDER_REFUND_QUERY_API_URL', 'http://payments.example.test/refund/query'],
    ['payment', 'PAYMENT_PROVIDER_TIMEOUT_MS', 'invalid'],
    ['payment', 'PAYMENT_REFUND_ENABLED', 'false'],
    ['rule_sync', 'PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://127.0.0.1/manifest.json'],
    ['rule_sync', 'PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://rules.example.test/manifest.json?token=secret'],
    ['rule_sync', 'PLATFORM_RULE_SYNC_INTERVAL_HOURS', '0'],
  ])('rejects unsafe %s readiness configuration %s', (gate, key, value) => {
    const environment = productionEnvironment()
    environment[key] = value
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates[gate]).toMatchObject({ ready: false })
  })

  it('requires a safe refund-query endpoint and a constructible payment provider', () => {
    const withoutRefundQuery = productionEnvironment()
    delete withoutRefundQuery.PAYMENT_PROVIDER_REFUND_QUERY_API_URL
    expect(productionReadinessDiagnostics(withoutRefundQuery).gates.payment?.reasons).toContain('provider_refund_query_api_must_use_https')

    const invalidProvider = productionEnvironment()
    invalidProvider.PAYMENT_PROVIDER_TIMEOUT_MS = 'invalid'
    expect(productionReadinessDiagnostics(invalidProvider).gates.payment?.reasons).toContain('provider_configuration_invalid')
  })

  it('keeps optional alert notifications ready while unknown relay quota blocks production', () => {
    const environment = productionEnvironment()
    delete environment.OPS_ALERT_WEBHOOK_URL
    delete environment.OPS_ALERT_WEBHOOK_ALLOWED_HOSTS
    delete environment.OPS_ALERT_WEBHOOK_SECRET
    environment.OPS_ALERT_NOTIFICATIONS_ENABLED = 'false'
    const result = productionReadinessDiagnostics(environment)
    expect(result.gates.alerts).toEqual({ ready: true, reasons: [] })
    expect(result.ready).toBe(false)
    expect(result.gates.relay?.reasons).toContain('relay:relay_token_quota_monitor_unavailable')
  })

  it.each([
    ['MCP_AUTHZ_MODE', 'shadow'],
    ['MCP_AUTHZ_MODE', 'staged'],
    ['MCP_AUTHZ_MODE', ' enforce '],
    ['AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'false'],
    ['AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', ' true '],
    ['MCP_AUTHZ_ENFORCE_DOMAINS', 'support'],
  ])('rejects non-canonical production authorization setting %s=%s', (key, value) => {
    const environment = productionEnvironment()
    environment[key] = value
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.authorization).toMatchObject({ ready: false })
  })

  it.each([
    '',
    'release/unsafe',
    'release with spaces',
    `${'r'.repeat(129)}`,
  ])('rejects unsafe production release identity %j', (releaseId) => {
    const environment = productionEnvironment()
    environment.RELEASE_ID = releaseId
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.release_metadata).toMatchObject({ ready: false })
    expect(result.gates.release_metadata?.reasons ?? []).toContain(releaseId.trim() ? 'release_id_invalid' : 'release_id_missing')
  })

  it('returns 503 from /releasez when the production release identity is unsafe', async () => {
    const environment = productionEnvironment()
    environment.RELEASE_ID = 'release/unsafe'
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
    const running = await listen()
    openServers.push(running.server)

    const response = await fetch(`${running.baseUrl}/releasez`)
    const body = await response.json() as Envelope
    expect(response.status).toBe(503)
    expect(body.error).toMatchObject({ code: 'RELEASE_METADATA_UNAVAILABLE' })
    expect(body.data).toBeNull()
  })

  it('does not let a production fixture profile bypass control-plane gates', () => {
    expect(productionReadinessDiagnostics({ NODE_ENV: 'test', CONNECTOR_FIXTURE_MODE: 'true' })).toEqual({ required: false, ready: true, gates: {} })
    expect(productionReadinessDiagnostics({ NODE_ENV: 'production', CONNECTOR_FIXTURE_MODE: 'true' })).toMatchObject({ required: true, ready: false })
    expect(productionReadinessDiagnostics({ NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'local_acceptance' })).toMatchObject({ required: true, ready: false })
  })

  it('keeps the explicit 101 Demo runtime healthy without weakening formal production readiness', () => {
    expect(productionReadinessDiagnostics({ NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', DEMO_RUNTIME_MODE: 'true' })).toEqual({ required: false, ready: true, gates: {} })
    expect(productionReadinessDiagnostics({ NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs' })).toMatchObject({ required: true, ready: false })
  })

  it('reports the explicit 101 Demo target as demo while retaining the production-shaped process', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DEMO_RUNTIME_MODE', 'true')
    const setup = runtimeHealth({ commercialReadiness: { ready: true, reasons: [] } }).setup
    expect(setup.mode).toBe('demo')
    expect(setup.productionGate).toBe(false)
  })

  it('returns 503 from /readyz for an incomplete production deployment while /livez stays process-only', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'false')
    vi.stubEnv('DEPLOYMENT_PROFILE', '')
    const running = await listen()
    openServers.push(running.server)

    const readinessResponse = await fetch(`${running.baseUrl}/readyz`)
    const readiness = await readinessResponse.json() as Envelope
    expect(readinessResponse.status).toBe(503)
    expect(readiness.error).toMatchObject({ code: 'PRODUCTION_READINESS_BLOCKED' })
    expect(readiness.error?.details).toMatchObject({
      gates: {
        relay: { ready: false },
        authorization: { ready: false },
        identity: { ready: false },
        object_storage: { ready: false },
        cost: { ready: false },
        release_metadata: { ready: false },
      },
      commercial: { ready: false },
      runtime_setup: { ready: false },
    })

    const livenessResponse = await fetch(`${running.baseUrl}/livez`)
    const liveness = await livenessResponse.json() as Envelope
    expect(livenessResponse.status).toBe(200)
    expect(liveness.error).toBeNull()
    expect(liveness.data).toEqual({ process: { ready: true } })
  })

  it('projects persistence-backed commercial readiness into the health payload instead of an unchecked placeholder', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'false')
    vi.stubEnv('DEPLOYMENT_PROFILE', '')
    const setup = runtimeHealth({
      commercialReadiness: {
        ready: false,
        reasons: ['commercial_executable_catalog_missing'],
      },
    }).setup as { commercialReadiness: { ready: boolean; reasons: string[] } }
    expect(setup.commercialReadiness.ready).toBe(false)
    expect(setup.commercialReadiness.reasons).toContain('commercial_executable_catalog_missing')
    expect(setup.commercialReadiness.reasons).not.toContain('commercial_readiness_not_checked')
  })

  it('keeps the local fixture /readyz behavior healthy', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    const running = await listen()
    openServers.push(running.server)

    const response = await fetch(`${running.baseUrl}/readyz`)
    const body = await response.json() as Envelope
    expect(response.status).toBe(200)
    expect(body.error).toBeNull()
  })
})
