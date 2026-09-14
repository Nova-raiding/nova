import { describe, expect, it, vi } from 'vitest'
import { createOutboxHandler } from './handler.js'
import { createApiDeliveryScanAdmissionGuard, pollOnce, readWorkerConfig } from './main.js'
import { CUSTOMER_DELIVERY_SCAN_EVENT, CUSTOMER_DELIVERY_SCAN_OPERATION, createDeliveryScanAdmissionGuard, type DeliveryScanAdmission } from '../../../packages/workers/src/customer-delivery-scan-admission.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import type { PostgresOutboxRepository } from '../../../packages/persistence/src/index.js'
import { verifyWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import { COMMERCIAL_OPERATION_REGISTRY, WORKER_RUNTIME_OPERATIONS } from '../../../packages/contracts/src/commercial-operation-registry.js'

function fixture(): DurableOutboxEvent {
  const at = new Date().toISOString()
  const admission: DeliveryScanAdmission = {
    schema_version: 1, operation: CUSTOMER_DELIVERY_SCAN_OPERATION, decision_id: 'decision_1', actor_id: 'ops_1', identity_id: 'identity_1',
    workbench: 'platform', context_id: 'platform:global', capability: 'customer.delivery.update', authorized: true,
    workspace_id: 'ws_1', delivery_id: 'delivery_1', purpose: 'contract', asset_id: 'asset_1', asset_revision: 1, source_revision: 1,
    storage_key: 'quarantine/ws_1/asset_1/contract.pdf', sha256: 'a'.repeat(64), size_bytes: 30, mime_type: 'application/pdf',
    request_id: 'request_1', trace_id: 'trace_1', admitted_at: at,
  }
  return { id: 'event_1', workspaceId: 'ws_1', aggregateId: 'asset_1', eventType: CUSTOMER_DELIVERY_SCAN_EVENT, sequence: 1, createdAt: at,
    payload: { asset_id: admission.asset_id, source_revision: admission.source_revision, storage_key: admission.storage_key, sha256: admission.sha256, size_bytes: admission.size_bytes, mime_type: admission.mime_type, delivery_scan_admission: admission } }
}
function evidence(event: DurableOutboxEvent) {
  return { ...(event.payload.delivery_scan_admission as DeliveryScanAdmission), recheck_id: 'recheck_1', event_id: event.id, allowed: true, ready: true, checked_at: new Date().toISOString() }
}

describe('customer delivery scan worker boundary', () => {
  it('defaults to deny before reading any asset or invoking the scanner', async () => {
    const scanRequested = vi.fn()
    await expect(createOutboxHandler({ scanRequested })({ event: fixture(), attempt: 1, now: Date.now() })).rejects.toMatchObject({
      error: { code: 'DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE', retryable: true, unknown: false },
    })
    expect(scanRequested).not.toHaveBeenCalled()
  })

  it('runs only after live platform admission without touching merchant point or member guards', async () => {
    const event = fixture()
    const order: string[] = []
    const commercialAccess = { assertCommercialAccess: vi.fn() }
    const executionAuthorization = { assertAuthorized: vi.fn() }
    const deliveryScanAdmission = createDeliveryScanAdmissionGuard(async () => { order.push('admission'); return evidence(event) })
    const scanRequested = vi.fn(async () => { order.push('scan'); return { verdict: 'clean' } })
    const result = await createOutboxHandler({ deliveryScanAdmission, commercialAccess, executionAuthorization, scanRequested })({ event, attempt: 1, now: Date.now() })
    expect(result).toEqual({ value: { verdict: 'clean' } })
    expect(order).toEqual(['admission', 'scan'])
    expect(commercialAccess.assertCommercialAccess).not.toHaveBeenCalled()
    expect(executionAuthorization.assertAuthorized).not.toHaveBeenCalled()
  })

  it.each([
    ['denied', { allowed: false }, 'DELIVERY_SCAN_EXECUTION_DENIED', false],
    ['wrong source revision', { source_revision: 2 }, 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID', true],
    ['wrong event', { event_id: 'other' }, 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID', true],
    ['stale', { checked_at: '2020-01-01T00:00:00.000Z' }, 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID', true],
  ])('never scans with %s evidence', async (_label, patch, code, retryable) => {
    const event = fixture()
    const scanRequested = vi.fn()
    const deliveryScanAdmission = createDeliveryScanAdmissionGuard(async () => ({ ...evidence(event), ...patch }))
    await expect(createOutboxHandler({ deliveryScanAdmission, scanRequested })({ event, attempt: 1, now: Date.now() })).rejects.toMatchObject({ error: { code, retryable } })
    expect(scanRequested).not.toHaveBeenCalled()
  })

  it.each(['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined', 'asset.scan_redrive_requested'])('does not bypass commercial or actor gates for %s even with forged platform metadata', async eventType => {
    const event = { ...fixture(), eventType }
    const deliveryScanAdmission = { assertAdmitted: vi.fn() }
    const scanRequested = vi.fn()
    await expect(createOutboxHandler({ deliveryScanAdmission, scanRequested })({ event, attempt: 1, now: Date.now() })).rejects.toMatchObject({ error: { code: eventType === 'asset.scan_redrive_requested' ? 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' : 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID' } })
    expect(deliveryScanAdmission.assertAdmitted).not.toHaveBeenCalled()
    expect(scanRequested).not.toHaveBeenCalled()
  })

  it('classifies only the new operation as independent platform control', () => {
    expect(WORKER_RUNTIME_OPERATIONS).toContain(CUSTOMER_DELIVERY_SCAN_OPERATION)
    expect(COMMERCIAL_OPERATION_REGISTRY.find(item => item.surface === 'WORKER' && item.operation === CUSTOMER_DELIVERY_SCAN_OPERATION)).toMatchObject({ domain: 'OPS_CONTROL', classification: null, rate_action: null })
    expect(COMMERCIAL_OPERATION_REGISTRY.find(item => item.surface === 'WORKER' && item.operation === 'asset.scan.execute')).toMatchObject({ domain: 'COMMERCIAL', classification: 'POINT_REQUIRED_NO_CHARGE' })
  })

  it('includes the new event in native scan-role claiming', async () => {
    const claimPending = vi.fn(async () => [])
    const repository = { claimPending } as unknown as PostgresOutboxRepository
    const config = readWorkerConfig({ DATABASE_URL: 'postgres://worker', WORKER_WORKSPACES: 'ws_1', WORKER_ROLE: 'scan' })
    await pollOnce(repository, new Map(), config)
    expect(claimPending).toHaveBeenCalledWith('ws_1', expect.objectContaining({ eventTypes: expect.arrayContaining([CUSTOMER_DELIVERY_SCAN_EVENT, 'asset.uploaded']) }))
  })
})

describe('delivery scan API admission transport', () => {
  const config = { apiBaseUrl: 'http://worker-api.test', apiToken: 'isolated-test-token', apiSigningSecret: 'isolated-test-signing-secret', workerId: 'delivery-scan-test' }

  it('requests the exact persisted event with a scan-role signature and validates evidence', async () => {
    const event = fixture()
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: { delivery_scan_recheck: evidence(event) } }), { status: 200 }))
    await expect(createApiDeliveryScanAdmissionGuard(config, fetcher as typeof fetch).assertAdmitted(event)).resolves.toMatchObject({ event_id: event.id })
    const [target, init] = fetcher.mock.calls[0]!
    const url = new URL(String(target))
    expect(url.pathname).toBe('/v1/worker-events/event_1/execution-check')
    expect(url.searchParams.get('aggregate_id')).toBe('asset_1')
    expect(url.searchParams.get('operation')).toBe(CUSTOMER_DELIVERY_SCAN_OPERATION)
    const headers = new Headers(init?.headers)
    expect(headers.get('x-worker-role')).toBe('scan')
    expect(headers.get('x-internal-worker-signing-secret')).toBeNull()
    expect(verifyWorkerRequestProof({ secret: config.apiSigningSecret, role: 'scan', workerId: config.workerId, method: 'GET', requestTarget: `${url.pathname}${url.search}`, workspaceId: event.workspaceId,
      timestamp: headers.get('x-worker-timestamp') ?? '', nonce: headers.get('x-worker-nonce') ?? '', bodySha256: headers.get('x-worker-body-sha256') ?? '', signature: headers.get('x-worker-workspace-signature') ?? '' })).toBe(true)
  })

  it('will not issue unsigned requests', async () => {
    const fetcher = vi.fn()
    await expect(createApiDeliveryScanAdmissionGuard({ ...config, apiSigningSecret: undefined }, fetcher).assertAdmitted(fixture())).rejects.toMatchObject({ code: 'DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([[403, false], [404, false], [409, false], [429, true], [503, true]])('normalizes HTTP %s retry policy and never trusts a success-shaped error body', async (status, retryable) => {
    const event = fixture()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { delivery_scan_recheck: evidence(event) }, error: { code: 'SERVER_UNAVAILABLE', retryable: !retryable } }), { status }))
    await expect(createApiDeliveryScanAdmissionGuard(config, fetcher).assertAdmitted(event)).rejects.toMatchObject({ retryable })
  })

  it('rejects a legacy commercial response without delivery admission evidence', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { commercial_access_recheck: { allowed: true } } }), { status: 200 }))
    await expect(createApiDeliveryScanAdmissionGuard(config, fetcher).assertAdmitted(fixture())).rejects.toMatchObject({ code: 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID' })
  })
})
