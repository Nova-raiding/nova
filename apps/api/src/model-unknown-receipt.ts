import { createHash } from 'node:crypto'

type UnknownProviderError = { code?: unknown; providerOutcome?: unknown; providerRequestId?: unknown; providerIdempotencyKey?: unknown }

const validIdentity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)

/** An unknown outcome is correlation evidence, never a billable success receipt. */
export function unknownModelProviderReceipt(error: unknown, workspaceId: string, operationId: string) {
  const candidate = error as UnknownProviderError | null
  if (!candidate || candidate.code !== 'MODEL_PROVIDER_OUTCOME_UNKNOWN' || candidate.providerOutcome !== 'unknown') return null
  const providerRequestId = validIdentity(candidate.providerRequestId) ? candidate.providerRequestId
    : validIdentity(candidate.providerIdempotencyKey) ? candidate.providerIdempotencyKey : null
  if (!providerRequestId) return null
  const evidence = { workspace_id: workspaceId, operation_id: operationId, provider: 'model-relay', provider_request_id: providerRequestId, outcome: 'unknown', error_code: candidate.code }
  return { workspaceId, operationId, provider: 'model-relay', providerRequestId, outcome: 'unknown' as const,
    receiptHash: createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex'), at: new Date().toISOString() }
}
