import type { DurableOutboxEvent } from './durable.js'

export const CUSTOMER_DELIVERY_SCAN_EVENT = 'asset.customer_delivery_quarantined' as const
export const CUSTOMER_DELIVERY_SCAN_OPERATION = 'customer_delivery.asset.scan.execute' as const
export type DeliveryScanEvent = Pick<DurableOutboxEvent, 'id' | 'workspaceId' | 'aggregateId' | 'eventType' | 'sequence' | 'payload'>

/** Platform-owned security work, not a merchant commercial access snapshot.
 * These fields are minted by the authorized upload route and committed with
 * the exact asset source revision. Never derive admission from usage scopes. */
export interface DeliveryScanAdmission {
  schema_version: 1
  operation: typeof CUSTOMER_DELIVERY_SCAN_OPERATION
  decision_id: string
  actor_id: string
  identity_id: string
  workbench: 'platform'
  context_id: 'platform:global'
  capability: 'customer.delivery.update'
  authorized: true
  workspace_id: string
  delivery_id: string
  purpose: 'contract' | 'payment' | 'system_integration' | 'functional_acceptance' | 'training' | 'video'
  asset_id: string
  asset_revision: number
  source_revision: number
  storage_key: string
  sha256: string
  size_bytes: number
  mime_type: string
  request_id: string
  trace_id: string
  admitted_at: string
}

export interface DeliveryScanRecheck extends DeliveryScanAdmission {
  recheck_id: string
  event_id: string
  allowed: true
  ready: true
  checked_at: string
}

export interface DeliveryScanAdmissionGuard {
  assertAdmitted(event: DurableOutboxEvent, signal?: AbortSignal): Promise<DeliveryScanRecheck>
}

export type DeliveryScanAdmissionRecheckPort = (input: {
  event: DurableOutboxEvent
  admission: DeliveryScanAdmission
  signal?: AbortSignal
}) => Promise<unknown>

export class DeliveryScanAdmissionError extends Error {
  readonly unknown = false
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'DeliveryScanAdmissionError'
  }
}

const CONTRACT_MIMES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm'])

export function parseDeliveryScanAdmission(event: DeliveryScanEvent, options: { now?: number } = {}): DeliveryScanAdmission {
  const raw = event.payload?.delivery_scan_admission
  if (event.eventType !== CUSTOMER_DELIVERY_SCAN_EVENT || !nonEmpty(event.id) || !record(raw)) throw invalid('delivery scan event or admission is missing')
  if (raw.schema_version !== 1 || raw.operation !== CUSTOMER_DELIVERY_SCAN_OPERATION || raw.workbench !== 'platform'
    || raw.context_id !== 'platform:global' || raw.capability !== 'customer.delivery.update' || raw.authorized !== true
    || !['contract', 'payment', 'system_integration', 'functional_acceptance', 'training', 'video'].includes(String(raw.purpose))) throw invalid('delivery scan admission authority is invalid')
  const admission: DeliveryScanAdmission = {
    schema_version: 1,
    operation: CUSTOMER_DELIVERY_SCAN_OPERATION,
    decision_id: textField(raw.decision_id, 'decision_id'),
    actor_id: textField(raw.actor_id, 'actor_id'),
    identity_id: textField(raw.identity_id, 'identity_id'),
    workbench: 'platform',
    context_id: 'platform:global',
    capability: 'customer.delivery.update',
    authorized: true,
    workspace_id: textField(raw.workspace_id, 'workspace_id'),
    delivery_id: textField(raw.delivery_id, 'delivery_id'),
    purpose: raw.purpose as DeliveryScanAdmission['purpose'],
    asset_id: textField(raw.asset_id, 'asset_id'),
    asset_revision: positiveInteger(raw.asset_revision, 'asset_revision'),
    source_revision: positiveInteger(raw.source_revision, 'source_revision'),
    storage_key: textField(raw.storage_key, 'storage_key'),
    sha256: textField(raw.sha256, 'sha256'),
    size_bytes: positiveInteger(raw.size_bytes, 'size_bytes'),
    mime_type: textField(raw.mime_type, 'mime_type'),
    request_id: textField(raw.request_id, 'request_id'),
    trace_id: textField(raw.trace_id, 'trace_id'),
    admitted_at: textField(raw.admitted_at, 'admitted_at'),
  }
  const objectPrefix = `quarantine/${admission.workspace_id}/${admission.asset_id}/`
  if (admission.workspace_id !== event.workspaceId || admission.asset_id !== event.aggregateId || admission.asset_revision !== event.sequence
    || admission.asset_id !== event.payload.asset_id || admission.source_revision !== event.payload.source_revision
    || admission.storage_key !== event.payload.storage_key || admission.sha256 !== event.payload.sha256
    || admission.size_bytes !== event.payload.size_bytes || admission.mime_type !== event.payload.mime_type) throw invalid('delivery scan admission event binding mismatch')
  if (!admission.storage_key.startsWith(objectPrefix) || admission.storage_key.length <= objectPrefix.length
    || admission.storage_key.split('/').some(part => part === '.' || part === '..' || !part)
    || admission.storage_key.includes('\\') || !/^[a-f0-9]{64}$/u.test(admission.sha256)
    || admission.size_bytes > 50 * 1024 * 1024
    || !(admission.purpose === 'video' ? VIDEO_MIMES : CONTRACT_MIMES).has(admission.mime_type)) throw invalid('delivery scan admission asset binding is invalid')
  const admittedAt = Date.parse(admission.admitted_at)
  // Durable work may wait in the queue. Only the authoritative recheck, not
  // the immutable enqueue decision, has a short freshness window.
  if (!Number.isFinite(admittedAt) || admittedAt > (options.now ?? Date.now()) + 5_000) throw invalid('delivery scan admission timestamp is invalid')
  return admission
}

export function parseDeliveryScanRecheck(raw: unknown, event: DeliveryScanEvent, admission: DeliveryScanAdmission, options: { now?: number; maxEvidenceAgeMs?: number } = {}): DeliveryScanRecheck {
  if (!record(raw)) throw recheckInvalid('delivery scan recheck evidence is missing')
  if (raw.allowed !== true) throw new DeliveryScanAdmissionError('DELIVERY_SCAN_EXECUTION_DENIED', 'delivery scan admission was denied')
  if (raw.ready !== true) throw new DeliveryScanAdmissionError('DELIVERY_SCAN_EXECUTION_NOT_READY', 'delivery scan execution is not ready', true)
  if (!nonEmpty(raw.recheck_id) || raw.recheck_id === admission.decision_id || raw.event_id !== event.id) throw recheckInvalid('delivery scan recheck event binding mismatch')
  for (const [key, value] of Object.entries(admission)) {
    if (raw[key] !== value) throw recheckInvalid(`delivery scan recheck ${key} binding mismatch`)
  }
  const checkedAt = typeof raw.checked_at === 'string' ? Date.parse(raw.checked_at) : NaN
  const now = options.now ?? Date.now()
  const maxEvidenceAgeMs = evidenceAge(options.maxEvidenceAgeMs)
  if (!Number.isFinite(checkedAt) || checkedAt > now + 5_000 || now - checkedAt > maxEvidenceAgeMs) throw recheckInvalid('delivery scan recheck evidence is stale')
  return { ...admission, recheck_id: raw.recheck_id, event_id: event.id, allowed: true, ready: true, checked_at: raw.checked_at as string }
}

export function createDeliveryScanAdmissionGuard(recheck: DeliveryScanAdmissionRecheckPort, options: { now?: () => number; maxEvidenceAgeMs?: number } = {}): DeliveryScanAdmissionGuard {
  const now = options.now ?? Date.now
  const maxEvidenceAgeMs = evidenceAge(options.maxEvidenceAgeMs)
  return {
    async assertAdmitted(event, signal) {
      signal?.throwIfAborted()
      const admission = parseDeliveryScanAdmission(event, { now: now() })
      const eventId = event.id
      let current: unknown
      try {
        current = await recheck({ event, admission, ...(signal ? { signal } : {}) })
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof DeliveryScanAdmissionError) throw error
        throw new DeliveryScanAdmissionError('DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE', 'delivery scan authority is unavailable', true)
      }
      signal?.throwIfAborted()
      // Do not let asynchronous authority I/O mutate the event underneath its
      // validated admission binding.
      const currentAdmission = parseDeliveryScanAdmission(event, { now: now() })
      if (event.id !== eventId || JSON.stringify(currentAdmission) !== JSON.stringify(admission)) throw invalid('delivery scan admission changed during recheck')
      return parseDeliveryScanRecheck(current, event, admission, { now: now(), maxEvidenceAgeMs })
    },
  }
}

export function createUnavailableDeliveryScanAdmissionGuard(): DeliveryScanAdmissionGuard {
  return createDeliveryScanAdmissionGuard(async () => {
    throw new DeliveryScanAdmissionError('DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE', 'delivery scan authority is not configured', true)
  })
}

function invalid(message: string): DeliveryScanAdmissionError { return new DeliveryScanAdmissionError('DELIVERY_SCAN_ADMISSION_INVALID', message) }
function recheckInvalid(message: string): DeliveryScanAdmissionError { return new DeliveryScanAdmissionError('DELIVERY_SCAN_EXECUTION_RECHECK_INVALID', message, true) }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function textField(value: unknown, field: string): string { if (!nonEmpty(value)) throw invalid(`delivery scan admission ${field} is invalid`); return value }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(`delivery scan admission ${field} is invalid`); return value as number }
function evidenceAge(value: number | undefined): number {
  const age = value ?? 30_000
  if (!Number.isFinite(age) || age <= 0 || age > 30_000) throw new RangeError('delivery scan evidence age must be between 1 and 30000 ms')
  return age
}
