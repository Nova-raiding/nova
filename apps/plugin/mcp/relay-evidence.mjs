export function assertRelayEvidence(method, result, { environment, fixtureFallback }) {
  const relayMethods = new Set(['content.generate', 'catalog.image.generate', 'multimodal.generate', 'multimodal.video.request', 'multimodal.image.edit'])
  if (!relayMethods.has(method) || !['production', 'staging', 'preview'].includes(environment) || fixtureFallback) return
  const execution = result && typeof result === 'object' && !Array.isArray(result) && result.execution && typeof result.execution === 'object' ? result.execution : {}
  const pending = result && typeof result === 'object' && !Array.isArray(result) && (['queued', 'generating', 'processing'].includes(result.state) || ['queued', 'running', 'pending'].includes(result.status))
  if (pending) return
  const simulated = execution.simulated === true || result?.simulated === true || result?.mode === 'fixture'
  const providerRequestId = execution.providerRequestId ?? execution.provider_request_id ?? result?.providerRequestId ?? result?.provider_request_id
  const usage = execution.usage ?? result?.usage
  const cost = execution.costCny ?? execution.cost_cny ?? result?.costCny ?? result?.cost_cny
  const missing = []
  if (simulated || execution.providerExecuted !== true) missing.push('provider_execution')
  if (typeof providerRequestId !== 'string' || !providerRequestId.trim()) missing.push('provider_request_id')
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).length === 0) missing.push('usage')
  if (cost === undefined || cost === null || (typeof cost !== 'number' && typeof cost !== 'string')) missing.push('cost_cny')
  if (missing.length > 0) {
    const error = new Error('model relay evidence is incomplete; result delivery is blocked')
    error.code = 'MODEL_RELAY_EVIDENCE_REQUIRED'
    error.details = { operation_status: 'blocked', missing: [...new Set(missing)] }
    throw error
  }
}
