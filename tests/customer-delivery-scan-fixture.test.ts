import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CUSTOMER_DELIVERY_CLAMAV_IMAGE, customerDeliveryScanRunPlan, customerDeliveryScanTimeout,
  collectCustomerDeliveryScanStartupDiagnostics, projectCustomerDeliveryScanState, sanitizeCustomerDeliveryScanLogs,
  disposeCustomerDeliveryScanContainer, startCustomerDeliveryScanFixture, stopCustomerDeliveryScanFixture,
  unidentifiedCustomerDeliveryScanDisposal,
  validateCustomerDeliveryScanBindings, validateCustomerDeliveryScanReadiness, verifyCustomerDeliveryScanContainer,
  type ScanContainerInspection,
} from '../scripts/customer-delivery-scan-fixture.js'
import { ISOLATED_POSTGRES_IMAGE, type IsolatedOpsFixture } from './isolated-ops-fixture.js'

// These are pure safety-guard tests. No scanner is mocked or run, and these
// synthetic protocol values are NOT real-scanning acceptance evidence.
const runId = '00000000-0000-4000-8000-000000000163'
const plan = customerDeliveryScanRunPlan({ runId, evidenceDir: '/tmp/scan-guard-test' })
const owned = { id: 'a'.repeat(64), name: plan.name, runId, image: CUSTOMER_DELIVERY_CLAMAV_IMAGE }
const inspection = (): ScanContainerInspection => ({
  id: owned.id, name: `/${owned.name}`, image: owned.image, autoRemove: true, running: true,
  labels: { 'merchant.fixture.purpose': 'isolated-customer-delivery-real-scan', 'merchant.fixture.run-id': runId, 'merchant.fixture.kind': 'clamav' },
  mounts: [{ Type: 'tmpfs', Destination: '/tmp' }], tmpfs: { '/tmp': 'rw,nosuid,size=256m' },
  ports: { '3310/tcp': [{ HostIp: '127.0.0.1', HostPort: '49331' }] },
})
const protocolEvidence = () => ({ version: 'ClamAV 1.4.3/28001/Mon Sep 14 01:00:00 2026', observedAt: new Date('2026-09-14T02:00:00Z'),
  clean: { status: 'clean' as const, target: 'stream', raw: 'stream: OK' },
  eicar: { status: 'infected' as const, target: 'stream', raw: 'stream: Eicar-Test-Signature FOUND', signature: 'Eicar-Test-Signature' },
})
const fixture = (): IsolatedOpsFixture => ({
  runId, databaseUrl: 'postgres://merchant_app:generated-app-password@127.0.0.1:49543/merchant',
  adminDatabaseUrl: 'must-never-be-inherited', opsDatabaseUrl: 'must-never-be-inherited', redisUrl: 'redis://:generated-redis-password@127.0.0.1:49637/0',
  workspaceId: `ws_ops_fixture_${runId.replaceAll('-', '')}`, subjectIdentityId: 'synthetic-identity',
  workspaceActorSubject: 'synthetic-workspace-actor', approverId: 'synthetic-approver', issuer: 'synthetic-issuer', actorSubject: 'synthetic-actor',
  containerEvidence: (['postgres', 'redis'] as const).map((kind, index) => ({
    id: String(index + 1).repeat(64), runId, kind, name: `merchant-ops-fixture-${kind}-${runId}`,
    image: kind === 'postgres' ? ISOLATED_POSTGRES_IMAGE : `redis@sha256:${'b'.repeat(64)}`,
    hostPort: kind === 'postgres' ? 49543 : 49637, autoRemove: true, dataStorage: 'tmpfs',
    labels: { 'merchant.fixture.purpose': 'isolated-ops-oidc-acceptance', 'merchant.fixture.run-id': runId, 'merchant.fixture.kind': kind },
  })), dispose: async () => ({ stopped: [], leftRunning: [] }),
})

describe('customer delivery real-scan harness safety guards (not live scan acceptance)', () => {
  it('is disabled without explicit boolean opt-in, before any filesystem or Docker access', async () => {
    await expect(startCustomerDeliveryScanFixture()).resolves.toBeUndefined()
    await expect(startCustomerDeliveryScanFixture({ enabled: false, evidenceDir: '/unavailable', startupTimeoutMs: -1 })).resolves.toBeUndefined()
    await expect(startCustomerDeliveryScanFixture({ enabled: 'true' as unknown as boolean })).resolves.toBeUndefined()
    await expect(stopCustomerDeliveryScanFixture(undefined)).resolves.toEqual({ stopped: [], leftRunning: [] })
  })
  it.each([0, -1, 120_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects unsafe timeout %s', value => {
    expect(() => customerDeliveryScanTimeout(value)).toThrow('CUSTOMER_DELIVERY_SCAN_TIMEOUT_INVALID')
  })
  it('accepts only bounded startup deadlines', () => {
    expect(customerDeliveryScanTimeout()).toBe(120_000)
    expect(customerDeliveryScanTimeout(5000)).toBe(5000)
  })
  it('validates enabled inputs before touching runtime services', async () => {
    await expect(startCustomerDeliveryScanFixture({ enabled: true, evidenceDir: '/tmp/unused-scan-guard', startupTimeoutMs: 120_001 })).rejects.toThrow('TIMEOUT_INVALID')
    await expect(startCustomerDeliveryScanFixture({ enabled: true, evidenceDir: '../shared' })).rejects.toThrow('EVIDENCE_DIRECTORY_INVALID')
    await expect(startCustomerDeliveryScanFixture({ enabled: true, evidenceDir: '/unused/scan-guard-test', signal: AbortSignal.abort('private cancellation reason') })).rejects.toThrow('CUSTOMER_DELIVERY_SCAN_ABORTED')
  })
  it('plans an immutable loopback-only owned container without shared volume/config access', () => {
    expect(plan.args.slice(0, 4)).toEqual(['run', '--detach', '--rm', '--pull=never'])
    expect(plan.args.slice(-4)).toEqual([CUSTOMER_DELIVERY_CLAMAV_IMAGE, 'sh', '-c', 'freshclam --foreground --stdout && exec clamd --foreground'])
    expect(plan.args).toContain('127.0.0.1::3310')
    expect(plan.args).toContain(`merchant.fixture.run-id=${runId}`)
    expect(plan.args).toContain('merchant.fixture.purpose=isolated-customer-delivery-real-scan')
    expect(plan.args).toContain('/tmp:rw,nosuid,size=256m')
    expect(plan.args).toContain('4g')
    expect(plan.cidFile).toBe('/tmp/scan-guard-test/container.id')
    for (const forbidden of ['--volume', '-v', '--mount', '--volumes-from', '--env-file', '--privileged', '--network=host', '--entrypoint']) expect(plan.args).not.toContain(forbidden)
    expect(() => customerDeliveryScanRunPlan({ runId: '../shared', evidenceDir: '/tmp/test' })).toThrow('IDENTITY_INVALID')
  })
  it('accepts exact owned inspection', () => {
    expect(verifyCustomerDeliveryScanContainer(inspection(), owned)).toMatchObject({ hostPort: 49331, dataStorage: 'ephemeral-container-layer', autoRemove: true })
  })
  it.each([
    ['different ID', { id: 'c'.repeat(64) }], ['different name', { name: '/shared-clamav' }],
    ['different image', { image: 'clamav/clamav:latest' }], ['persistent container', { autoRemove: false }],
    ['stopped container', { running: false }], ['missing labels', { labels: null }],
    ['shared volume', { mounts: [{ Type: 'volume', Destination: '/var/lib/clamav' }] }],
    ['host bind', { mounts: [{ Type: 'bind', Destination: '/config' }] }],
    ['extra tmpfs destination', { mounts: [{ Type: 'tmpfs', Destination: '/var/lib/clamav' }] }],
    ['no tmpfs', { tmpfs: null }], ['public port', { ports: { '3310/tcp': [{ HostIp: '0.0.0.0', HostPort: '49331' }] } }],
    ['invalid port', { ports: { '3310/tcp': [{ HostIp: '127.0.0.1', HostPort: '65536' }] } }],
    ['extra port', { ports: { ...inspection().ports, '1234/tcp': [{ HostIp: '127.0.0.1', HostPort: '49332' }] } }],
  ] as const)('refuses destructive cleanup for %s', async (_label, changes) => {
    const stop = vi.fn(async (_id: string) => undefined)
    const result = await disposeCustomerDeliveryScanContainer(owned, { inspect: async () => ({ ...inspection(), ...changes }) as ScanContainerInspection, stop })
    expect(stop).not.toHaveBeenCalled()
    expect(result.stopped).toEqual([])
    expect(result.leftRunning).toHaveLength(1)
  })
  it.each(['purpose', 'run-id', 'kind'])('requires matching %s ownership label', label => {
    const actual = inspection(); actual.labels![`merchant.fixture.${label}`] = 'another-run'
    expect(() => verifyCustomerDeliveryScanContainer(actual, owned)).toThrow('CONTAINER_IDENTITY_MISMATCH')
  })
  it('stops only the exact verified ID and never broadens failed cleanup', async () => {
    const stop = vi.fn(async (_id: string) => undefined)
    await expect(disposeCustomerDeliveryScanContainer(owned, { inspect: async () => inspection(), stop })).resolves.toEqual({ stopped: [owned.id], leftRunning: [] })
    expect(stop).toHaveBeenCalledExactlyOnceWith(owned.id)
    const failure = await disposeCustomerDeliveryScanContainer(owned, { inspect: async () => { throw Error('private daemon diagnostic') }, stop })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(failure)).not.toContain('private daemon diagnostic')
    expect(failure.leftRunning).toHaveLength(1)
    const failedStop = await disposeCustomerDeliveryScanContainer(owned, { inspect: async () => inspection(), stop: async () => { throw Error('stop failed') } })
    expect(failedStop.stopped).toEqual([])
    expect(failedStop.leftRunning).toHaveLength(1)
  })
  it('does not claim clean teardown when Docker creation lost its exact ID', () => {
    expect(unidentifiedCustomerDeliveryScanDisposal(false)).toEqual({ stopped: [], leftRunning: [] })
    expect(unidentifiedCustomerDeliveryScanDisposal(true)).toEqual({ stopped: [], leftRunning: [{ id: 'unconfirmed', reason: expect.stringContaining('manual review required') }] })
  })
  it('redacts URL credentials, query tokens, authorization and quoted secrets from startup logs', () => {
    const raw = [
      'Downloading https://fixture-user:fixture-pass@database.clamav.net/daily.cvd?ToKeN=query-secret&Api_Key=another-secret#private-fragment',
      'Authorization: Bearer bearer-secret', 'authorization=Basic YmFzaWMtc2VjcmV0',
      'SCANNER_TOKEN=token-secret password="quoted secret value"',
      '{"api_key":"json-secret", "signing_secret": "another signing value"}',
      '-----BEGIN PRIVATE KEY-----\nprivate-key-value\n-----END PRIVATE KEY-----',
      '\u001b[31mERROR\u001b[0m\u0000 definitions unavailable\r\n',
    ].join('\n')
    const safe = sanitizeCustomerDeliveryScanLogs(raw)
    for (const secret of ['fixture-user', 'fixture-pass', 'query-secret', 'another-secret', 'private-fragment', 'bearer-secret', 'YmFzaWMtc2VjcmV0', 'token-secret', 'quoted secret value', 'json-secret', 'another signing value', 'private-key-value']) expect(safe).not.toContain(secret)
    expect(safe).toContain('database.clamav.net/daily.cvd')
    expect(safe).toContain('definitions unavailable')
    expect(safe).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
  })
  it('bounds diagnostics after redaction and keeps at most the last 100 lines', () => {
    const log = sanitizeCustomerDeliveryScanLogs(Array.from({ length: 130 }, (_, index) => `line-${index}`).join('\n'))
    expect(log.split('\n')).toHaveLength(100)
    expect(log).toMatch(/^line-30\n/u)
    const secret = 'boundary-private-value'.repeat(100)
    const bounded = sanitizeCustomerDeliveryScanLogs(`${'.'.repeat(16_370)} token=${secret}\n`)
    expect(bounded.length).toBeLessThanOrEqual(16_384)
    expect(bounded).not.toContain('boundary-private')
    expect(bounded).toContain('[truncated]')
  })
  it('redacts escaped quotes and non-Bearer authorization without leaking credential suffixes', () => {
    const raw = [JSON.stringify({ password: 'prefix"secret-suffix', api_key: 'escaped\\key-suffix' }),
      "secret='prefix\\'single-quote-suffix'", 'Authorization: Digest username=private-user, response=private-response',
      'Proxy-Authorization: Negotiate private-negotiation-value',
    ].join('\n')
    const safe = sanitizeCustomerDeliveryScanLogs(raw)
    for (const secret of ['secret-suffix', 'key-suffix', 'single-quote-suffix', 'private-user', 'private-response', 'private-negotiation-value']) expect(safe).not.toContain(secret)
    expect(safe).toContain('[redacted-authorization]')
  })
  it('projects only safe container state fields, including exited OOM evidence', () => {
    expect(projectCustomerDeliveryScanState({ running: false, status: 'exited', exitCode: 137, oomKilled: true, Error: 'private daemon failure', environment: 'private configuration' }))
      .toEqual({ running: false, status: 'exited', exitCode: 137, oomKilled: true })
    expect(() => projectCustomerDeliveryScanState({ running: true, status: 'secret status', exitCode: 0, oomKilled: false })).toThrow('DIAGNOSTIC_STATE_INVALID')
    expect(() => projectCustomerDeliveryScanState({ running: true, status: 'running', exitCode: '0', oomKilled: false })).toThrow('DIAGNOSTIC_STATE_INVALID')
  })
  it('reads startup logs only after matching the previously verified exact identity', async () => {
    const logs = vi.fn(async (_id: string) => 'ERROR definitions download failed')
    const inspect = vi.fn(async (_id: string) => ({ ...inspection(), state: { running: false, status: 'exited', exitCode: 137, oomKilled: true } }))
    expect(await collectCustomerDeliveryScanStartupDiagnostics(undefined, { inspect, logs })).toEqual({ failures: ['OWNERSHIP_NOT_VERIFIED'] })
    expect(inspect).not.toHaveBeenCalled()
    const rejected = await collectCustomerDeliveryScanStartupDiagnostics(owned, { inspect: async () => ({ ...inspection(), id: 'f'.repeat(64) }), logs })
    expect(rejected.failures).toEqual(['OWNERSHIP_NOT_VERIFIED'])
    expect(logs).not.toHaveBeenCalled()
    const diagnostics = await collectCustomerDeliveryScanStartupDiagnostics(owned, { inspect, logs })
    expect(inspect).toHaveBeenCalledExactlyOnceWith(owned.id)
    expect(logs).toHaveBeenCalledExactlyOnceWith(owned.id)
    expect(diagnostics).toEqual({ containerId: owned.id, state: { running: false, status: 'exited', exitCode: 137, oomKilled: true }, logs: 'ERROR definitions download failed', failures: [] })
    expect(JSON.stringify(diagnostics)).not.toContain('labels')
  })
  it('contains diagnostic failures without exposing raw errors or preventing subsequent cleanup', async () => {
    const logs = vi.fn(async (_id: string) => { throw new Error('native private URL https://secret:secret@private.example') })
    const failedInspection = await collectCustomerDeliveryScanStartupDiagnostics(owned, { inspect: async () => { throw new Error('raw secret inspect error') }, logs })
    expect(failedInspection).toEqual({ failures: ['INSPECTION_UNAVAILABLE'] })
    expect(logs).not.toHaveBeenCalled()
    const failedLogs = await collectCustomerDeliveryScanStartupDiagnostics(owned, { inspect: async () => ({ ...inspection(), state: 'private malformed state' }), logs })
    expect(failedLogs).toEqual({ containerId: owned.id, failures: ['STATE_UNAVAILABLE', 'LOGS_UNAVAILABLE'] })
    const stop = vi.fn(async (_id: string) => undefined)
    await expect(disposeCustomerDeliveryScanContainer(owned, { inspect: async () => inspection(), stop })).resolves.toEqual({ stopped: [owned.id], leftRunning: [] })
    expect(stop).toHaveBeenCalledExactlyOnceWith(owned.id)
    expect(JSON.stringify([failedInspection, failedLogs])).not.toContain('private')
  })
  it('validates clean + real EICAR signature + current definitions together', () => {
    expect(validateCustomerDeliveryScanReadiness(protocolEvidence())).toMatchObject({ engineVersion: '1.4.3', definitionsVersion: '28001', definitionsAgeSeconds: 3600, cleanProbe: 'clean', eicarSignature: 'Eicar-Test-Signature' })
  })
  it.each([
    'PONG', 'ClamAV 1.4.3/28001/Fri Sep 11 01:00:00 2026', 'ClamAV 1.4.3/28001/Tue Sep 15 01:00:00 2026',
    'ClamAV 1.4.3/27999/Mon Sep 14 01:00:00 2026', 'ClamAV 1.4.3/28001/Sun Sep 13 25:00:00 2026',
    'ClamAV 1.4.3/999999999999999999999/Mon Sep 14 01:00:00 2026',
  ])('rejects absent, stale, future or malformed definition evidence %s', version => {
    expect(() => validateCustomerDeliveryScanReadiness({ ...protocolEvidence(), version })).toThrow('CUSTOMER_DELIVERY_SCAN_')
  })
  it('rejects an always-clean scanner or unexpected EICAR signature', () => {
    const value = protocolEvidence()
    expect(() => validateCustomerDeliveryScanReadiness({ ...value, eicar: value.clean })).toThrow('EICAR_PROBE_FAILED')
    expect(() => validateCustomerDeliveryScanReadiness({ ...value, eicar: { ...value.eicar, signature: 'other' } })).toThrow('EICAR_PROBE_FAILED')
    expect(() => validateCustomerDeliveryScanReadiness({ ...value, clean: value.eicar })).toThrow('CLEAN_PROBE_FAILED')
  })
  it('requires generated fixture endpoints rather than any loopback database', () => {
    const value = fixture()
    const check = () => validateCustomerDeliveryScanBindings({ fixture: value, apiBaseUrl: 'http://127.0.0.1:49878', apiPort: 49878 })
    expect(check).not.toThrow()
    value.databaseUrl = value.databaseUrl.replace('49543', '18087')
    expect(check).toThrow('FIXTURE_ENDPOINT_INVALID')
  })
  it.each([
    'http://127.0.0.1:18082', 'https://external.example', 'http://localhost:49878', 'http://secret@127.0.0.1:49878',
    'http://127.0.0.1:49878/api', 'http://127.0.0.1:49878?token=private',
  ])('rejects an unrelated API endpoint %s', apiBaseUrl => {
    expect(() => validateCustomerDeliveryScanBindings({ fixture: fixture(), apiBaseUrl, apiPort: 49878 })).toThrow('API_ENDPOINT_INVALID')
  })
  it('rejects cross-run evidence and privileged DB credentials', () => {
    const value = fixture()
    value.containerEvidence[0]!.runId = '00000000-0000-4000-8000-000000000164'
    expect(() => validateCustomerDeliveryScanBindings({ fixture: value, apiBaseUrl: 'http://127.0.0.1:49878', apiPort: 49878 })).toThrow('FIXTURE_ENDPOINT_INVALID')
    const privileged = fixture(); privileged.databaseUrl = privileged.databaseUrl.replace('merchant_app', 'merchant')
    expect(() => validateCustomerDeliveryScanBindings({ fixture: privileged, apiBaseUrl: 'http://127.0.0.1:49878', apiPort: 49878 })).toThrow('FIXTURE_ENDPOINT_INVALID')
  })
  it('does not inherit secrets, inspect shared config, invoke mock scans or write credentials to evidence', () => {
    const source = readFileSync('scripts/customer-delivery-scan-fixture.ts', 'utf8')
    for (const forbidden of ['...process.env', '.Config.Env', '--env-file', 'docker-compose', "docker(['rm'", "docker(['prune'", 'MemoryAssetScan', 'signedReceipt(', 'input.scanner']) expect(source).not.toContain(forbidden)
    expect(source).toContain('isolatedFixtureSpawnEnvironment()')
    expect(source).toContain("'--host', `unix://${socket}`, '--config', dockerConfig")
    expect(source).toContain("WORKER_API_CREDENTIALS: JSON.stringify({ scan:")
    expect(source).toContain('new URL(bindings.apiBaseUrl).origin')
    expect(source).not.toContain('bindings.fixture.adminDatabaseUrl')
    expect(source).not.toContain('bindings.fixture.opsDatabaseUrl')
    expect(source).toContain("readFile(plan.cidFile, 'utf8')")
    expect(source).toContain('disposal ??=')
    expect(source).toContain("docker(['logs', '--tail', '100', id], true, true)")
    expect(source).toContain('timeout: diagnostics ? 5_000')
    expect(source).toContain('verifiedOwned = { ...owned }')
    expect(source).toContain('startup-diagnostics.json')
    expect(source).not.toContain('.State.Error')
    for (const line of source.split('\n').filter(line => line.includes('writeFile('))) expect(line).not.toMatch(/privateKey|scannerToken|scannerSecret|workerToken|workerSecret|apiEnvironment|workerEnvironment/u)
  })
})
