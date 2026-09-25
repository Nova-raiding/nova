import { DomainError } from '../../../packages/application/src/service.js'
import { evaluatePlatformModelBudgetEstimate, evaluatePlatformModelCostGate, evaluatePlatformModelTaskRequestCost, type PlatformModelKind } from '../../../packages/ai/src/platform-model-gate.js'
import type { ActionKind, ModelUsageRepository } from '../../../packages/persistence/src/index.js'

export function modelIdForBudget(kind: PlatformModelKind) {
  switch (kind) {
    case 'text': return process.env.AI_MODEL?.trim() || process.env.MODEL_ID?.trim()
    case 'image': return process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim()
    case 'image_edit': return process.env.IMAGE_EDIT_MODEL?.trim() || process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim()
    case 'ocr': return process.env.OCR_MODEL?.trim() || process.env.AI_VISION_MODEL?.trim()
    case 'embedding': return process.env.EMBEDDING_MODEL?.trim()
    case 'video': return process.env.VIDEO_MODEL?.trim() || process.env.AI_VIDEO_MODEL?.trim()
  }
}

export function modalityForActionKind(kind: ActionKind): PlatformModelKind | undefined {
  if (kind === 'model_text') return 'text'
  if (kind === 'model_image') return 'image'
  if (kind === 'image_edit') return 'image_edit'
  if (kind === 'model_ocr') return 'ocr'
  if (kind === 'model_video') return 'video'
  return undefined
}

export function createModelBudgetRuntime(deps: {
  isProduction: () => boolean
  requirePlatformModelCostGate: (kind: PlatformModelKind) => void
  ready: () => Promise<unknown>
  repository: () => ModelUsageRepository | undefined
  recheckBeforeProvider: (context: { operation: string; workspaceId?: string }, actualDispatch?: boolean) => Promise<void>
  providerSucceededButSettlementPending: (error: unknown) => boolean
}) {
  async function reserveDailyModelBudget(workspaceId: string, reservationKey: string, runKey: string, kind: PlatformModelKind) {
    if (!deps.isProduction()) return undefined
    deps.requirePlatformModelCostGate(kind)
    await deps.ready()
    const repository = deps.repository()
    const model = modelIdForBudget(kind)
    const estimate = evaluatePlatformModelBudgetEstimate(process.env, kind)
    const costGate = evaluatePlatformModelCostGate(process.env)
    const taskCostGate = evaluatePlatformModelTaskRequestCost(estimate.amountCny, process.env)
    if (!repository || !model || !estimate.ready || !estimate.version || !costGate.ready || !taskCostGate.ready) throw new DomainError(taskCostGate.reasons.includes('request_cost_exceeds_task_limit') ? 'MODEL_TASK_COST_LIMIT_EXCEEDED' : 'MODEL_COST_BUDGET_PREFLIGHT_UNAVAILABLE', taskCostGate.reasons.includes('request_cost_exceeds_task_limit') ? '本次生成请求的保守成本预估超过单任务安全上限，未调用上游' : `生产${kind}模型缺少版本化保守成本预估或持久化预算仓储，已阻断上游请求`, taskCostGate.reasons.includes('request_cost_exceeds_task_limit') ? 422 : 503, { reasons: [...estimate.reasons, ...costGate.reasons, ...taskCostGate.reasons, ...(!repository ? ['budget_repository_missing'] : []), ...(!model ? ['model_missing'] : [])] })
    try {
      return await repository.reserveDailyBudget({ workspaceId, reservationKey, runKey, modality: kind, model, estimateCny: estimate.amountCny, estimateVersion: estimate.version, dailyLimitCny: costGate.dailyCnyLimit, runLimitCny: taskCostGate.limitCny })
    } catch (error) {
      if ((error as { code?: string })?.code === 'MODEL_TASK_COST_LIMIT_EXCEEDED') {
        const details = (error as { details: { usedCny: number; reservedCny: number; requestCny: number; limitCny: number } }).details
        throw new DomainError('MODEL_TASK_COST_LIMIT_EXCEEDED', '本次生成方案预计成本超过单任务安全上限，未扣款且未调用上游', 422, { used_cny: details.usedCny, reserved_cny: details.reservedCny, request_cny: details.requestCny, maximum_task_cost_cny: details.limitCny })
      }
      if ((error as { code?: string })?.code === 'MODEL_DAILY_COST_BUDGET_EXCEEDED') {
        const details = (error as { details: { usedCny: number; reservedCny: number; requestCny: number; limitCny: number } }).details
        throw new DomainError('MODEL_DAILY_COST_BUDGET_EXCEEDED', '当日模型成本预算不足，未扣钱包且未调用上游', 429, { used_cny: details.usedCny, reserved_cny: details.reservedCny, request_cny: details.requestCny, limit_cny: details.limitCny })
      }
      throw error
    }
  }

  async function releaseDailyModelBudget(workspaceId: string, reservationKey: string) {
    if (!deps.isProduction()) return
    await deps.ready()
    await deps.repository()?.releaseDailyBudget({ workspaceId, reservationKey })
  }

  async function withDailyModelBudget<T>(kind: PlatformModelKind, usageContext: { workspaceId?: string; actionId?: string; runKey?: string } | undefined, invoke: () => Promise<T>): Promise<T> {
    if (!deps.isProduction()) {
      await deps.recheckBeforeProvider({ operation: kind, workspaceId: usageContext?.workspaceId }, false)
      return invoke()
    }
    const workspaceId = usageContext?.workspaceId?.trim(); const actionId = usageContext?.actionId?.trim(); const runKey = usageContext?.runKey?.trim()
    if (!workspaceId || !actionId || !runKey) throw new DomainError('MODEL_COST_BUDGET_CONTEXT_REQUIRED', '生产模型调用缺少工作区、幂等动作标识或任务预算标识，已阻断上游请求', 503)
    await reserveDailyModelBudget(workspaceId, actionId, runKey, kind)
    try {
      await deps.recheckBeforeProvider({ operation: kind, workspaceId }, false)
      return await invoke()
    } catch (error) {
      if (!deps.providerSucceededButSettlementPending(error)) await releaseDailyModelBudget(workspaceId, actionId)
      throw error
    }
  }

  return { reserveDailyModelBudget, releaseDailyModelBudget, withDailyModelBudget }
}
