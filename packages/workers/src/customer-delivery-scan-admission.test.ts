import { describe, expect, it, vi } from 'vitest'
import type { DurableOutboxEvent } from './durable.js'
import { CUSTOMER_DELIVERY_SCAN_EVENT, CUSTOMER_DELIVERY_SCAN_OPERATION, createDeliveryScanAdmissionGuard, createUnavailableDeliveryScanAdmissionGuard, DeliveryScanAdmissionError, parseDeliveryScanAdmission, parseDeliveryScanRecheck, type DeliveryScanAdmission } from './customer-delivery-scan-admission.js'

const now = Date.parse('2026-09-14T10:00:00.000Z')
function fixture(): DurableOutboxEvent {
  const admission: DeliveryScanAdmission = {
    schema_version: 1, operation: CUSTOMER_DELIVERY_SCAN_OPERATION, decision_id: 'decision_1', actor_id: 'ops_1', identity_id: 'identity_1',
    workbench: 'platform', context_id: 'platform:global', capability: 'customer.delivery.update', authorized: true,
    workspace_id: 'ws_1', delivery_id: 'delivery_1', purpose: 'contract', asset_id: 'asset_1', asset_revision: 3, source_revision: 2,
    storage_key: 'quarantine/ws_1/asset_1/contract.pdf', sha256: 'a'.repeat(64), size_bytes: 30, mime_type: 'application/pdf',
    request_id: 'request_1', trace_id: 'trace_1', admitted_at: new Date(now - 60_000).toISOString(),
  }
  return { id: 'event_1', workspaceId: 'ws_1', aggregateId: 'asset_1', eventType: CUSTOMER_DELIVERY_SCAN_EVENT, sequence: 3, createdAt: admission.admitted_at,
    payload: { asset_id: admission.asset_id, source_revision: admission.source_revision, storage_key: admission.storage_key, sha256: admission.sha256, size_bytes: admission.size_bytes, mime_type: admission.mime_type, delivery_scan_admission: admission } }
}
function evidence(event: DurableOutboxEvent) {
  return { ...(event.payload.delivery_scan_admission as DeliveryScanAdmission), recheck_id: 'recheck_1', event_id: event.id, allowed: true, ready: true, checked_at: new Date(now).toISOString() }
}

describe('platform customer delivery scan admission', () => {
  it('accepts a durable platform admission older than the live freshness window', () => {
    expect(parseDeliveryScanAdmission(fixture(), { now })).toMatchObject({ purpose: 'contract', asset_revision: 3, source_revision: 2 })
  })

  it.each([
    ['schema_version', 2], ['operation', 'asset.scan.execute'], ['decision_id', ''], ['actor_id', ''], ['identity_id', ''],
    ['workbench', 'workspace'], ['context_id', 'workspace:ws_1'], ['capability', 'customer.content.update'], ['authorized', false],
    ['workspace_id', 'ws_other'], ['asset_id', 'asset_other'], ['asset_revision', 4], ['source_revision', 3],
    ['storage_key', 'quarantine/ws_1/asset_other/contract.pdf'], ['sha256', 'b'.repeat(64)], ['size_bytes', 31], ['mime_type', 'image/png'],
    ['delivery_id', ''], ['purpose', 'generation'], ['request_id', ''], ['trace_id', ''], ['admitted_at', 'invalid'],
    ['admitted_at', new Date(now + 5_001).toISOString()],
  ])('rejects malformed or mismatched admission %s', (key, value) => {
    const event = fixture()
    ;(event.payload.delivery_scan_admission as Record<string, unknown>)[key as string] = value
    expect(() => parseDeliveryScanAdmission(event, { now })).toThrow(expect.objectContaining({ code: 'DELIVERY_SCAN_ADMISSION_INVALID', retryable: false }))
  })

  it.each([
    ['asset.uploaded'], ['asset.generated_quarantined'], ['asset.video_quarantined'], ['asset.scan_redrive_requested'],
  ])('cannot turn merchant event %s into platform admission', eventType => {
    expect(() => parseDeliveryScanAdmission({ ...fixture(), eventType }, { now })).toThrow('delivery scan event or admission is missing')
  })

  it.each([
    ['storage_key', 'clean/ws_1/asset_1/contract.pdf'], ['storage_key', 'quarantine/ws_1/asset_1/../other.pdf'],
    ['storage_key', 'quarantine/ws_1/asset_1/'], ['sha256', 'A'.repeat(64)], ['size_bytes', 0], ['size_bytes', 50 * 1024 * 1024 + 1],
    ['source_revision', 1.5], ['mime_type', 'application/octet-stream'], ['mime_type', 'video/mp4'],
  ])('rejects an invalid asset even when payload matches: %s', (key, value) => {
    const event = fixture()
    ;(event.payload.delivery_scan_admission as Record<string, unknown>)[key as string] = value
    event.payload[key as string] = value
    expect(() => parseDeliveryScanAdmission(event, { now })).toThrow(expect.objectContaining({ code: 'DELIVERY_SCAN_ADMISSION_INVALID' }))
  })

  it.each(['video/mp4', 'video/webm'])('accepts an explicitly video-scoped %s admission', mime => {
    const event = fixture()
    Object.assign(event.payload.delivery_scan_admission!, { purpose: 'video', mime_type: mime })
    event.payload.mime_type = mime
    expect(parseDeliveryScanAdmission(event, { now })).toMatchObject({ purpose: 'video', mime_type: mime })
  })

  it('validates every recheck field against the immutable admission', () => {
    const event = fixture()
    const admission = parseDeliveryScanAdmission(event, { now })
    const raw = evidence(event)
    expect(parseDeliveryScanRecheck(raw, event, admission, { now })).toEqual(raw)
    for (const [key, value] of Object.entries(admission)) {
      const changed = { ...raw, [key]: typeof value === 'number' ? value + 1 : value === true ? false : `${String(value)}_changed` }
      expect(() => parseDeliveryScanRecheck(changed, event, admission, { now }), key).toThrow(expect.objectContaining({ code: 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID' }))
    }
  })

  it.each([
    ['checked_at', new Date(now - 30_001).toISOString()], ['checked_at', new Date(now + 5_001).toISOString()], ['checked_at', 'invalid'],
    ['event_id', 'event_other'], ['recheck_id', 'decision_1'], ['recheck_id', ''],
  ])('rejects stale or unbound recheck %s', (key, value) => {
    const event = fixture()
    expect(() => parseDeliveryScanRecheck({ ...evidence(event), [key]: value }, event, parseDeliveryScanAdmission(event, { now }), { now })).toThrow(expect.objectContaining({ code: 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID' }))
  })

  it('fails closed when missing, denied, not ready, or unavailable', async () => {
    const event = fixture()
    const guard = (raw: unknown) => createDeliveryScanAdmissionGuard(async () => raw, { now: () => now })
    await expect(guard(undefined).assertAdmitted(event)).rejects.toMatchObject({ code: 'DELIVERY_SCAN_EXECUTION_RECHECK_INVALID' })
    await expect(guard({ ...evidence(event), allowed: false }).assertAdmitted(event)).rejects.toMatchObject({ code: 'DELIVERY_SCAN_EXECUTION_DENIED', retryable: false })
    await expect(guard({ ...evidence(event), ready: false }).assertAdmitted(event)).rejects.toMatchObject({ code: 'DELIVERY_SCAN_EXECUTION_NOT_READY', retryable: true })
    const historical = fixture()
    ;(historical.payload.delivery_scan_admission as DeliveryScanAdmission).admitted_at = '2020-01-01T00:00:00.000Z'
    await expect(createUnavailableDeliveryScanAdmissionGuard().assertAdmitted(historical)).rejects.toMatchObject({ code: 'DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE', retryable: true })
    await expect(createDeliveryScanAdmissionGuard(async () => { throw new Error('network') }, { now: () => now }).assertAdmitted(event)).rejects.toBeInstanceOf(DeliveryScanAdmissionError)
  })

  it('does not call the authority for malformed admission and respects cancellation', async () => {
    const event = fixture()
    const recheck = vi.fn(async () => evidence(event))
    const guard = createDeliveryScanAdmissionGuard(recheck, { now: () => now })
    await expect(guard.assertAdmitted({ ...event, payload: {} })).rejects.toMatchObject({ code: 'DELIVERY_SCAN_ADMISSION_INVALID' })
    const controller = new AbortController()
    controller.abort()
    await expect(guard.assertAdmitted(event, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(recheck).not.toHaveBeenCalled()
  })

  it('rejects cancellation or event mutation during authority I/O', async () => {
    const event = fixture()
    const controller = new AbortController()
    const cancelled = createDeliveryScanAdmissionGuard(async () => { controller.abort(); return evidence(event) }, { now: () => now })
    await expect(cancelled.assertAdmitted(event, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const changed = createDeliveryScanAdmissionGuard(async () => {
      const result = evidence(event)
      ;(event.payload.delivery_scan_admission as DeliveryScanAdmission).delivery_id = 'delivery_2'
      return result
    }, { now: () => now })
    await expect(changed.assertAdmitted(event)).rejects.toMatchObject({ code: 'DELIVERY_SCAN_ADMISSION_INVALID' })
  })

  it('does not permit widening the 30-second evidence window', () => {
    expect(() => createDeliveryScanAdmissionGuard(async () => undefined, { maxEvidenceAgeMs: 30_001 })).toThrow(RangeError)
  })
})
