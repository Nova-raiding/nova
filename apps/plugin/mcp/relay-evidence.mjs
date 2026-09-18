export function assertRelayEvidence(method, result, { environment, fixtureFallback }) {
  const relayMethods = new Set(['content.generate', 'catalog.image.generate', 'multimodal.generate', 'multimodal.video.request', 'multimodal.image.edit'])
  if (!relayMethods.has(method) || !['production', 'staging', 'preview'].includes(environment) || fixtureFallback) return
  const execution = result && typeof result === 'object' && !Array.isArray(result) && result.execution && typeof result.execution === 'object' ? result.execution : {}
  const pending = isPendingRelayResult(result)
  if (pending) return
  const simulated = execution.simulated === true || result?.simulated === true || result?.mode === 'fixture'
  const providerRequestId = execution.providerRequestId ?? execution.provider_request_id ?? result?.providerRequestId ?? result?.provider_request_id
  const usage = execution.usage ?? result?.usage
  const cost = execution.costCny ?? execution.cost_cny ?? result?.costCny ?? result?.cost_cny
  const numericCost = typeof cost === 'number'
    ? cost
    : typeof cost === 'string' && /^\d+(?:\.\d+)?$/u.test(cost.trim())
      ? Number(cost.trim())
      : undefined
  const missing = []
  if (simulated || execution.providerExecuted !== true) missing.push('provider_execution')
  if (typeof providerRequestId !== 'string' || !providerRequestId.trim()) missing.push('provider_request_id')
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).length === 0) missing.push('usage')
  if (numericCost === undefined || !Number.isFinite(numericCost) || numericCost < 0) missing.push('cost_cny')
  if (missing.length > 0) {
    const error = new Error('model relay evidence is incomplete; result delivery is blocked')
    error.code = 'MODEL_RELAY_EVIDENCE_REQUIRED'
    error.details = { operation_status: 'blocked', missing: [...new Set(missing)] }
    throw error
  }
}

export function isPendingRelayResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  const execution = result.execution && typeof result.execution === 'object' && !Array.isArray(result.execution) ? result.execution : {}
  const job = result.job && typeof result.job === 'object' && !Array.isArray(result.job) ? result.job : {}
  const candidateState = result.candidate_state && typeof result.candidate_state === 'object' && !Array.isArray(result.candidate_state) ? result.candidate_state : {}
  const states = [
    result.state,
    result.status,
    result.execution_state,
    execution.state,
    execution.status,
    job.state,
    job.status,
    candidateState.state,
  ].map(value => typeof value === 'string' ? value.trim().toLowerCase() : '')
  return states.some(state => ['queued', 'generating', 'processing', 'running', 'pending', 'provider_reserved', 'provider_dispatching', 'provider_started'].includes(state))
}
