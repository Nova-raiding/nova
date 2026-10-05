import type { ModelUsageRecord } from '../../../packages/persistence/src/model-usage-repository.js'

/** Describe the whole text action, including paid structure-repair attempts. */
export function aggregateContentExecutionEvidence(rows: readonly ModelUsageRecord[], actionId: string) {
  const byReceipt = new Map<string, ModelUsageRecord>()
  let conflictingReceipt = false
  for (const row of rows.filter(item => item.modality === 'text')) {
    const key = row.providerRequestId?.trim() || row.receiptKey || row.id
    const previous = byReceipt.get(key)
    if (previous && previous.revision === row.revision
      && (previous.costCny !== row.costCny || previous.settlementStatus !== row.settlementStatus
        || previous.inputTokens !== row.inputTokens || previous.outputTokens !== row.outputTokens || previous.totalTokens !== row.totalTokens)) conflictingReceipt = true
    if (!previous || row.revision > previous.revision) byReceipt.set(key, row)
  }
  const receipts = [...byReceipt.values()].sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || right.revision - left.revision)
  const latest = receipts[0]
  const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {}
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (receipts.length && receipts.every(row => Number.isSafeInteger(row[field]) && row[field]! >= 0)) {
      const sum = receipts.reduce((total, row) => total + BigInt(row[field]!), 0n)
      if (sum <= BigInt(Number.MAX_SAFE_INTEGER)) usage[field] = Number(sum)
    }
  }
  // SQL numeric(12,6) receipts are accumulated in integer micro-CNY, so
  // floating-point addition cannot omit or invent a micro-CNY across attempts.
  const costsValid = receipts.length > 0 && receipts.every(row => typeof row.costCny === 'number' && Number.isFinite(row.costCny) && row.costCny >= 0 && row.costCny < 1_000_000)
  const costMicros = costsValid ? receipts.reduce((sum, row) => sum + BigInt(row.costCny!.toFixed(6).replace('.', '')), 0n) : undefined
  const costCny = costMicros !== undefined && costMicros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(costMicros) / 1_000_000 : undefined
  const hasUsage = Object.keys(usage).length > 0
  const settled = !conflictingReceipt && receipts.length > 0 && costCny !== undefined && hasUsage
    && receipts.every(row => row.settlementStatus === 'settled' && Boolean(row.providerRequestId?.trim()))
  const unsettled = receipts.find(row => row.settlementStatus !== 'settled')
  return {
    settled,
    model: latest?.model,
    ...(latest?.providerRequestId ? { providerRequestId: latest.providerRequestId } : {}),
    providerRequestIds: receipts.flatMap(row => row.providerRequestId?.trim() ? [row.providerRequestId] : []),
    providerRequestCount: receipts.length,
    ...(hasUsage ? { usage } : {}),
    ...(costCny !== undefined ? { costCny } : {}),
    ...(latest ? { settlementStatus: settled ? 'settled' as const : unsettled?.settlementStatus ?? 'pending_cost' as const, actionId } : {}),
  }
}
