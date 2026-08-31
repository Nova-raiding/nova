export type ImageGenerationExecutionState = string | null | undefined

const labels: Record<string, string> = {
  dispatching: '已提交模型请求，等待受理确认',
  provider_started: '模型已受理，等待结果确认',
  outcome_unknown: '结果待对账，禁止重复生成',
}

export function imageGenerationExecutionLabel(state: ImageGenerationExecutionState) {
  return state ? labels[state] ?? state : '未记录'
}

export function imageGenerationNeedsReconciliation(state: ImageGenerationExecutionState) {
  return state === 'outcome_unknown'
}

export function imageGenerationRetryAllowed(input: { state?: string; executionState?: ImageGenerationExecutionState; nextActionAllowed?: boolean }) {
  return input.state === 'failed' && input.executionState !== 'outcome_unknown' && input.nextActionAllowed === true
}

