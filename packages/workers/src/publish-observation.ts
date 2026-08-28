import type { PublishHandlerResult } from './publish-adapter.js'

export type PublishObservationSource = 'publish' | 'reconcile'

export interface PublishObservationRequest {
  source: PublishObservationSource
  status: {
    found: boolean
    state: 'submitted' | 'published' | 'rejected' | 'unknown'
    remote_id?: string
    request_id?: string
    simulated: boolean
    platform_rejection?: {
      raw_code: string
      message?: string
      fields: Array<{ path: string; raw_code?: string; message: string }>
    }
  }
  /** Retained for audit/debugging; the API may ignore fields it does not persist. */
  receipt?: PublishHandlerResult['receipt']
  observed_at: string
}

/**
 * Convert connector evidence into the existing API observation contract.
 *
 * A write receipt is acceptance only. For a publish event, an explicit remote
 * status is still required, and simulated or incomplete evidence is downgraded
 * to unknown. This makes it impossible for a connector's optimistic receipt
 * to make a publish job look published.
 */
export function buildPublishObservationRequest(
  result: PublishHandlerResult,
  options: { source: PublishObservationSource; observedAt?: string },
): PublishObservationRequest {
  const receipt = result.receipt
  const remote = result.remoteStatus
  const remoteId = remote.remoteId ?? receipt?.remoteId
  const requestId = remote.requestId ?? receipt?.requestId
  const simulated = remote.simulated || receipt?.simulated === true
  const hasEvidence = Boolean(remoteId || requestId)
  const explicitlyVerified = remote.found === true
    && remote.state !== 'unknown'
    && !simulated
    && (remote.state !== 'published' || hasEvidence)
  const state = explicitlyVerified ? remote.state : 'unknown'

  return {
    source: options.source,
    status: {
      found: state !== 'unknown',
      state,
      ...(remoteId ? { remote_id: remoteId } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      simulated,
      ...(state === 'rejected' && remote.rejection ? { platform_rejection: {
        raw_code: remote.rejection.rawCode,
        ...(remote.rejection.message ? { message: remote.rejection.message } : {}),
        fields: remote.rejection.fields.map(field => ({ path: field.path, ...(field.rawCode ? { raw_code: field.rawCode } : {}), message: field.message })),
      } } : {}),
    },
    ...(receipt ? { receipt } : {}),
    observed_at: options.observedAt ?? new Date().toISOString(),
  }
}

export class PublishObservationReportError extends Error {
  readonly retryable: boolean

  constructor(message: string, options: { retryable: boolean }) {
    super(message)
    this.name = 'PublishObservationReportError'
    this.retryable = options.retryable
  }
}
