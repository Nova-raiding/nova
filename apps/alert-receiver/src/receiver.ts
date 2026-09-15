import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const MAX_ALERT_BODY_BYTES = 256 * 1024
export const DEFAULT_ALERT_MAX_AGE_MS = 5 * 60_000

export interface AlertReceiptStore {
  health(): Promise<void>
  append(input: { alertId: string; requestId: string; receivedAt: string; sentAt: string; bodySha256: string; body: unknown }): Promise<'accepted' | 'replay'>
}

export class AlertReceiverError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const value = headers[name]
  return Array.isArray(value) ? value[0]?.trim() ?? '' : value?.trim() ?? ''
}

export async function receiveSignedAlert(input: {
  headers: Record<string, string | string[] | undefined>
  rawBody: Buffer
  secret: string
  store: AlertReceiptStore
  now?: number
  maxAgeMs?: number
}) {
  if (!input.secret.trim()) throw new AlertReceiverError('ALERT_RECEIVER_NOT_CONFIGURED', 503, 'alert receiver secret is unavailable')
  if (!input.rawBody.length || input.rawBody.length > MAX_ALERT_BODY_BYTES) throw new AlertReceiverError('ALERT_BODY_INVALID', 413, 'alert body is empty or too large')
  const alertId = header(input.headers, 'x-merchant-alert-id')
  const requestId = header(input.headers, 'x-request-id')
  const timestampText = header(input.headers, 'x-merchant-alert-timestamp')
  const signatureText = header(input.headers, 'x-merchant-alert-signature')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(alertId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(requestId)) throw new AlertReceiverError('ALERT_IDENTITY_INVALID', 400, 'alert or request identity is invalid')
  if (!/^\d{13}$/u.test(timestampText)) throw new AlertReceiverError('ALERT_TIMESTAMP_INVALID', 401, 'alert timestamp is invalid')
  const timestamp = Number(timestampText)
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > (input.maxAgeMs ?? DEFAULT_ALERT_MAX_AGE_MS)) throw new AlertReceiverError('ALERT_TIMESTAMP_STALE', 401, 'alert timestamp is stale')
  const providedHex = signatureText.match(/^sha256=([a-f0-9]{64})$/u)?.[1]
  if (!providedHex) throw new AlertReceiverError('ALERT_SIGNATURE_INVALID', 401, 'alert signature is invalid')
  const expected = createHmac('sha256', input.secret.trim()).update(`${timestampText}.`).update(input.rawBody).digest()
  const provided = Buffer.from(providedHex, 'hex')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new AlertReceiverError('ALERT_SIGNATURE_INVALID', 401, 'alert signature is invalid')
  let body: unknown
  try { body = JSON.parse(input.rawBody.toString('utf8')) } catch { throw new AlertReceiverError('ALERT_JSON_INVALID', 400, 'alert body is not valid JSON') }
  const envelope = body as { type?: unknown; version?: unknown; request_id?: unknown; sent_at?: unknown; alert?: { id?: unknown } }
  if (envelope.type !== 'merchant.operation_alert' || envelope.version !== 1 || envelope.request_id !== requestId || envelope.alert?.id !== alertId || typeof envelope.sent_at !== 'string' || Number.isNaN(Date.parse(envelope.sent_at))) throw new AlertReceiverError('ALERT_CONTRACT_INVALID', 422, 'alert envelope does not match signed headers')
  const result = await input.store.append({ alertId, requestId, receivedAt: new Date(now).toISOString(), sentAt: envelope.sent_at, bodySha256: createHash('sha256').update(input.rawBody).digest('hex'), body })
  if (result === 'replay') throw new AlertReceiverError('ALERT_REPLAYED', 409, 'alert request was already accepted')
  return { accepted: true as const, alert_id: alertId, request_id: requestId, received_at: new Date(now).toISOString() }
}
