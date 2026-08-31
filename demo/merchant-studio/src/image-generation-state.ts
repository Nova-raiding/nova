export type ImageGenerationExecutionState =
  | 'provider_reserved'
  | 'provider_dispatching'
  | 'provider_started'
  | 'outcome_unknown'
  | string
  | null
  | undefined

export const imageGenerationProviderExecutionStates = [
  'provider_reserved',
  'provider_dispatching',
  'provider_started',
  'outcome_unknown',
] as const

const labels: Record<string, string> = {
  provider_reserved: '已锁定模型请求，尚未发出',
  provider_dispatching: '正在提交模型请求，等待受理确认',
  provider_started: '模型已受理，等待结果确认',
  outcome_unknown: '结果待对账，禁止重复生成',
  // Keep rendering historical API values readable without treating them as
  // the current provider execution contract.
  dispatching: '正在提交模型请求，等待受理确认',
}

export function imageGenerationExecutionLabel(state: ImageGenerationExecutionState) {
  return state ? labels[state] ?? state : '未记录'
}

export function imageGenerationNeedsReconciliation(state: ImageGenerationExecutionState) {
  return state === 'outcome_unknown'
}

export function imageGenerationProviderCallStarted(state: ImageGenerationExecutionState) {
  return state === 'provider_dispatching' || state === 'provider_started' || state === 'outcome_unknown'
}

export function imageGenerationRetryAllowed(input: { state?: string; executionState?: ImageGenerationExecutionState; nextActionAllowed?: boolean }) {
  return input.state === 'failed'
    && !imageGenerationProviderExecutionStates.includes(input.executionState as typeof imageGenerationProviderExecutionStates[number])
    && input.nextActionAllowed === true
}
