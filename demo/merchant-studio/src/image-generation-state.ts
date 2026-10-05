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
  return state ? labels[state] ?? '状态待确认，请刷新或进入对账' : '未记录'
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

/** Configuration failures must be visually distinct from transient read errors. */
export function isImageGenerationConfigurationError(error: unknown) {
  const candidate = error as { code?: unknown; status?: unknown } | undefined
  const code = typeof candidate?.code === 'string' ? candidate.code.trim().toUpperCase() : ''
  return candidate?.status === 503 && [
    'MODEL_RELAY_NOT_CONFIGURED',
    'IMAGE_GENERATION_NOT_CONFIGURED',
    'IMAGE_EDIT_NOT_CONFIGURED',
    'VIDEO_GENERATION_NOT_CONFIGURED',
  ].includes(code)
}

/** Provider uncertainty precedes archive placeholders; it never means scanning has begun. */
export function imageGenerationDisplayState(job: { state: string; archiveState?: string; executionState?: ImageGenerationExecutionState } | null | undefined): string {
  if (!job) return ''
  const execution = job.executionState
  if (execution && [...imageGenerationProviderExecutionStates, 'dispatching'].includes(execution)) return execution
  if (job.archiveState === 'pending') return 'archiving'
  if (job.archiveState === 'partial') return 'partial_archive'
  if (job.archiveState === 'external_unarchived') return 'external_unarchived'
  return job.state
}
