/**
 * Safe actions for the image-generation state projection.
 *
 * This is deliberately a pure application contract. It does not execute a
 * provider call, mutate a job, or infer that an external result succeeded.
 */
export type ImageGenerationActionState =
  | 'queued'
  | 'processing'
  | 'provider_reserved'
  | 'provider_dispatching'
  | 'provider_started'
  | 'outcome_unknown'
  | 'archiving'
  | 'archived'
  | 'scan_pending'
  | 'quarantined'
  | 'failed'

export type ImageGenerationAction =
  | 'wait'
  | 'refresh_status'
  | 'query_provider'
  | 'review_archive'
  | 'wait_for_scan'
  | 'resolve_scan'
  | 'retry_generation'
  | 'none'

export interface ImageGenerationActionInput {
  state: ImageGenerationActionState | string | null | undefined
  /** Provider execution evidence. A started/unknown provider call is never safely retryable. */
  providerAttemptState?: 'not_started' | 'started' | 'succeeded' | 'unknown' | string | null
  /** Archive evidence as projected by the durable job. */
  archiveState?: 'pending' | 'archiving' | 'archived' | 'partial' | 'external_unarchived' | string | null
  /** Candidate asset scan state. */
  scanStatus?: 'pending' | 'quarantined' | 'clean' | 'blocked' | 'failed' | string | null
  /** Only explicit pre-provider failures may be retried. */
  errorCode?: string | null
  nextActionAllowed?: boolean
}

export interface ImageGenerationActionProjection {
  state: ImageGenerationActionState | 'unknown'
  primaryAction: ImageGenerationAction
  allowedActions: readonly ImageGenerationAction[]
  retryAllowed: boolean
  reconciliationRequired: boolean
  publishable: boolean
  reason: string
}

const SAFE_RETRY_ERRORS = new Set(['IMAGE_GENERATION_NOT_CONFIGURED', 'IMAGE_GENERATION_PRE_PROVIDER_FAILED'])
const NO_ACTION: readonly ImageGenerationAction[] = ['none']

function normalizeState(value: ImageGenerationActionInput['state']): ImageGenerationActionProjection['state'] {
  if (typeof value !== 'string') return 'unknown'
  const state = value.trim() as ImageGenerationActionState
  return state === 'queued' || state === 'processing' || state === 'provider_reserved' || state === 'provider_dispatching'
    || state === 'provider_started' || state === 'outcome_unknown' || state === 'archiving' || state === 'archived'
    || state === 'scan_pending' || state === 'quarantined' || state === 'failed' ? state : 'unknown'
}

/**
 * Projects one safe primary action. Unknown, provider-started, archive and
 * scan states fail closed; none of them can become a publish or blind retry.
 */
export function projectImageGenerationActions(input: ImageGenerationActionInput): ImageGenerationActionProjection {
  const state = normalizeState(input.state)
  const providerStarted = input.providerAttemptState === 'started' || input.providerAttemptState === 'succeeded' || input.providerAttemptState === 'unknown'
  const reconciliationRequired = state === 'outcome_unknown' || state === 'provider_started' || state === 'provider_dispatching' || state === 'archiving'
    || input.providerAttemptState === 'unknown' || input.archiveState === 'partial' || input.archiveState === 'external_unarchived'

  if (state === 'outcome_unknown' || state === 'provider_started' || state === 'provider_dispatching') {
    return { state, primaryAction: 'query_provider', allowedActions: ['query_provider', 'refresh_status'], retryAllowed: false, reconciliationRequired: true, publishable: false, reason: 'Provider 结果尚未确认，必须先按 request ID 对账，禁止重复生成。' }
  }
  if (state === 'provider_reserved') {
    return { state, primaryAction: 'refresh_status', allowedActions: ['refresh_status'], retryAllowed: false, reconciliationRequired: false, publishable: false, reason: 'Provider 请求已预留，等待安全提交状态。' }
  }
  if (state === 'archiving' || input.archiveState === 'partial' || input.archiveState === 'external_unarchived') {
    return { state: state === 'unknown' ? 'archiving' : state, primaryAction: 'review_archive', allowedActions: ['review_archive', 'refresh_status'], retryAllowed: false, reconciliationRequired: true, publishable: false, reason: '生成结果尚未完成完整归档，不能展示成功或再次生成。' }
  }
  if (state === 'scan_pending' || state === 'quarantined' || input.scanStatus === 'pending' || input.scanStatus === 'quarantined') {
    return { state, primaryAction: 'wait_for_scan', allowedActions: ['wait_for_scan', 'refresh_status'], retryAllowed: false, reconciliationRequired, publishable: false, reason: '候选仍在安全扫描或隔离区，扫描通过前不能选择、发布或重试。' }
  }
  if (input.scanStatus === 'blocked' || input.scanStatus === 'failed') {
    return { state, primaryAction: 'resolve_scan', allowedActions: ['resolve_scan', 'refresh_status'], retryAllowed: false, reconciliationRequired, publishable: false, reason: '安全扫描未通过，必须处理扫描阻断后才能继续。' }
  }
  if (state === 'failed') {
    const retryAllowed = !providerStarted && input.nextActionAllowed === true && SAFE_RETRY_ERRORS.has(input.errorCode ?? '')
    return retryAllowed
      ? { state, primaryAction: 'retry_generation', allowedActions: ['retry_generation', 'refresh_status'], retryAllowed: true, reconciliationRequired: false, publishable: false, reason: '失败发生在 Provider 外呼前，满足幂等条件后可安全重试。' }
      : { state, primaryAction: reconciliationRequired ? 'refresh_status' : 'none', allowedActions: reconciliationRequired ? ['refresh_status'] : NO_ACTION, retryAllowed: false, reconciliationRequired, publishable: false, reason: reconciliationRequired ? '失败任务存在外部结果或归档不完整证据，必须先对账，禁止盲重试。' : '当前失败不满足安全重试条件。' }
  }
  if (state === 'archived') {
    return { state, primaryAction: 'none', allowedActions: NO_ACTION, retryAllowed: false, reconciliationRequired: false, publishable: input.scanStatus === 'clean', reason: input.scanStatus === 'clean' ? '候选已归档且扫描通过，可由上层审核/选择契约继续。' : '归档完成但缺少可信扫描通过证据。' }
  }
  if (state === 'queued' || state === 'processing') {
    return { state, primaryAction: 'wait', allowedActions: ['wait', 'refresh_status'], retryAllowed: false, reconciliationRequired: false, publishable: false, reason: '任务仍在执行，等待状态推进。' }
  }
  return { state: 'unknown', primaryAction: 'refresh_status', allowedActions: ['refresh_status'], retryAllowed: false, reconciliationRequired: true, publishable: false, reason: '状态无法识别，必须刷新并进入对账，禁止任何写入动作。' }
}
