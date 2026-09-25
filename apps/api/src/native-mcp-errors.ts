import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { isCommercialAccessErrorCode, isCommercialPurchaseErrorCode } from '../../../packages/contracts/src/index.js'
import { getRequestCorrelation } from './request-observability.js'

/** Preserve stable application errors inside JSON-RPC error.data. */
export function nativeMcpCommercialErrorData(error: unknown, req: IncomingMessage) {
  const errorCode = error instanceof DomainError
    ? error.code
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (!errorCode || (!isCommercialAccessErrorCode(errorCode) && !isCommercialPurchaseErrorCode(errorCode))) return undefined
  const correlation = getRequestCorrelation(req)
  const candidateDetails = error instanceof DomainError ? error.details : undefined
  const details = candidateDetails && typeof candidateDetails === 'object' && !Array.isArray(candidateDetails)
    ? candidateDetails
    : {}
  return { ...details, code: errorCode, request_id: correlation.requestId, trace_id: correlation.traceId }
}

export function nativeMcpErrorData(error: unknown, req: IncomingMessage) {
  const errorCode = error instanceof DomainError
    ? error.code
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (!errorCode) return undefined
  const commercialData = nativeMcpCommercialErrorData(error, req)
  if (commercialData) return commercialData
  const correlation = getRequestCorrelation(req)
  const candidateDetails = error instanceof DomainError
    ? error.details
    : error && typeof error === 'object' && 'details' in error
      ? error.details
      : undefined
  const details = candidateDetails && typeof candidateDetails === 'object' && !Array.isArray(candidateDetails)
    ? candidateDetails
    : {}
  return { code: errorCode, details, request_id: correlation.requestId, trace_id: correlation.traceId }
}
