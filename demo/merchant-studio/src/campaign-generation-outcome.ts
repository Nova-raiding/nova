/**
 * Distinguish a server-confirmed rejection from a request whose response did
 * not prove whether generation ran. Callers may safely explain/remediate a
 * rejection, but must reconcile an uncertain write before another attempt.
 */
export function campaignGenerationOutcomeUnknown(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return true
  const error = cause as { code?: unknown; status?: unknown; details?: Record<string, unknown> }
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : ''
  const details = error.details
  if (
    code === 'API_REQUEST_TIMEOUT'
    || code === 'MCP_TRANSPORT_CLOSED'
    || code.includes('OUTCOME_UNKNOWN')
    || details?.outcome === 'unknown'
    || details?.outcome_unknown === true
    || details?.reconciliationRequired === true
    || details?.reconciliation_required === true
  ) return true
  if (typeof error.status === 'number') return error.status >= 500
  // Fetch/parse failures and errors after a workspace/session transition may
  // happen after the server accepted the write, even when no HTTP status made
  // it into the client error.
  return true
}

export function campaignGenerationFailureMessage(campaignId: string, message: string, outcomeUnknown: boolean): string {
  return outcomeUnknown
    ? `批量计划 ${campaignId} 已创建，逐项生成结果尚未确认：${message}。请先在营销任务中刷新并读取该计划状态；在核对当前计划和目标范围前，请勿再次提交或另建批次。若商品、品牌或平台商品关联已变化，重试可能会成为不同操作。`
    : `批量计划 ${campaignId} 已创建，但逐项生成请求被服务端拒绝：${message}。请处理门禁后先在营销任务中读取计划最新状态；确认计划和目标范围后，再决定是否重新提交。目标身份变化可能形成不同计划，请勿假设系统会复用原计划。`
}
