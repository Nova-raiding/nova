import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AlertReceiverError, receiveSignedAlert, type AlertReceiptStore } from './receiver.js'

const now = 1_789_300_000_000
const secret = 'receiver-secret-long-enough'
const envelope = { type: 'merchant.operation_alert', version: 1, request_id: 'request-1', sent_at: new Date(now).toISOString(), alert: { id: 'alert-1', severity: 'critical' } }
const rawBody = Buffer.from(JSON.stringify(envelope))
const headers = { 'x-merchant-alert-id': 'alert-1', 'x-request-id': 'request-1', 'x-merchant-alert-timestamp': String(now), 'x-merchant-alert-signature': `sha256=${createHmac('sha256', secret).update(`${now}.`).update(rawBody).digest('hex')}` }

class MemoryStore implements AlertReceiptStore {
  seen = new Set<string>(); records: unknown[] = []
  async health() {}
  async append(input: Parameters<AlertReceiptStore['append']>[0]) { if (this.seen.has(input.requestId) || this.seen.has(input.alertId)) return 'replay' as const; this.seen.add(input.requestId); this.seen.add(input.alertId); this.records.push(input); return 'accepted' as const }
}

describe('signed alert receiver', () => {
  it('authenticates exact raw bytes and persists an auditable digest', async () => {
    const store = new MemoryStore()
    await expect(receiveSignedAlert({ headers, rawBody, secret, store, now })).resolves.toMatchObject({ accepted: true, alert_id: 'alert-1' })
    expect(store.records).toHaveLength(1)
    expect(store.records[0]).toMatchObject({ alertId: 'alert-1', requestId: 'request-1', bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })
  it.each([
    ['changed body', { rawBody: Buffer.from(`${rawBody.toString()} `) }, 'ALERT_SIGNATURE_INVALID'],
    ['wrong signature', { headers: { ...headers, 'x-merchant-alert-signature': `sha256=${'0'.repeat(64)}` } }, 'ALERT_SIGNATURE_INVALID'],
    ['stale timestamp', { now: now + 300_001 }, 'ALERT_TIMESTAMP_STALE'],
  ])('rejects %s before persistence', async (_name, override, code) => {
    const store = new MemoryStore()
    await expect(receiveSignedAlert({ headers, rawBody, secret, store, now, ...override })).rejects.toMatchObject({ code })
    expect(store.records).toHaveLength(0)
  })
  it('rejects a replay through the durable store contract', async () => {
    const store = new MemoryStore()
    await receiveSignedAlert({ headers, rawBody, secret, store, now })
    await expect(receiveSignedAlert({ headers, rawBody, secret, store, now })).rejects.toEqual(expect.objectContaining<Partial<AlertReceiverError>>({ code: 'ALERT_REPLAYED', status: 409 }))
  })
})
