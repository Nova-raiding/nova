import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildRequestLogEvent, getRequestCorrelation, serializeRequestLogEvent, type RequestLogInput } from './request-observability.js'

export function createRequestObservation(deps: { isProduction: () => boolean; requiresStrictAuth: () => boolean; actorId: (req: IncomingMessage) => string | undefined }) {
  type RequestObservationState = RequestLogInput & { startedAt: bigint; failed: boolean }
  const requestObservationStates = new WeakMap<IncomingMessage, RequestObservationState>()

  function requestObservabilityEnabled() {
    // Vitest simulates production in several suites. Do not let that switch on
    // per-request JSON logging for the whole process; observability tests opt in
    // explicitly, while real production remains always-on.
    if (process.env.VITEST === 'true') return process.env.REQUEST_OBSERVABILITY_LOGS === 'true'
    return deps.isProduction() || process.env.REQUEST_OBSERVABILITY_LOGS === 'true'
  }

  function requestDurationMs(startedAt: bigint) {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000
  }

  function writeRequestObservation(req: IncomingMessage, event: 'request.received' | 'request.completed' | 'request.failed' | 'request.aborted', input: RequestLogInput) {
    if (!requestObservabilityEnabled()) return
    console.info(serializeRequestLogEvent(buildRequestLogEvent(req, event, input)))
  }

  function beginRequestObservation(req: IncomingMessage) {
    const state: RequestObservationState = {
      startedAt: process.hrtime.bigint(),
      failed: false,
    }
    requestObservationStates.set(req, state)
    getRequestCorrelation(req)
    writeRequestObservation(req, 'request.received', state)
  }

  function enrichRequestObservation(req: IncomingMessage, input: RequestLogInput) {
    const state = requestObservationStates.get(req)
    if (state) Object.assign(state, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)))
  }

  function trustedRequestObservationActor(req: IncomingMessage) {
    return deps.requiresStrictAuth() ? deps.actorId(req) : undefined
  }

  function completeRequestObservation(req: IncomingMessage, res: ServerResponse, aborted = false) {
    const state = requestObservationStates.get(req)
    if (!state || state.failed) return
    if (aborted && !res.writableFinished) {
      // The client went away before we answered. Recording this as
      // `request.completed status:200` wrote a false success into the audit
      // stream; it is neither a completion nor a server failure.
      writeRequestObservation(req, 'request.aborted', { ...state, status: 499, durationMs: requestDurationMs(state.startedAt) })
      return
    }
    if (res.statusCode >= 400) {
      failRequestObservation(req, res.statusCode, typeof state.errorCode === 'string' ? state.errorCode : 'HTTP_ERROR')
      return
    }
    writeRequestObservation(req, 'request.completed', { ...state, status: res.statusCode, durationMs: requestDurationMs(state.startedAt) })
  }

  function failRequestObservation(req: IncomingMessage, status: number, errorCode: string) {
    const state = requestObservationStates.get(req)
    if (!state || state.failed) return
    state.failed = true
    writeRequestObservation(req, 'request.failed', { ...state, status, errorCode, durationMs: requestDurationMs(state.startedAt) })
  }


  return { beginRequestObservation, enrichRequestObservation, trustedRequestObservationActor, completeRequestObservation, failRequestObservation }
}
