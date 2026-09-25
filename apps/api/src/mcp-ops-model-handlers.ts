import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { CommercialExtensionsRepository, ModelUsageRepository, OperationAudit } from '../../../packages/persistence/src/index.js'
import { mapWithConcurrency } from './bounded-concurrency.js'

export const MCP_OPS_MODEL_METHODS = new Set([
  'ops.model-usage.summary',
  'ops.commercial.model-markup.get',
  'ops.commercial.model-markup.update',
])

interface ModelOpsDependencies {
  modelUsage?: ModelUsageRepository
  commercialExtensions: CommercialExtensionsRepository
  listWorkspaceIds: () => Promise<string[]>
  requirePlatformReadRole: (req: IncomingMessage) => unknown
  requirePlatformOps: (req: IncomingMessage) => string
  required: (params: Record<string, unknown>, key: string) => string
  recordOperationAudit: (audit: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

/** The caller performs the MCP response wrapping and keeps method policy checks. */
export async function handleMcpOpsModelMethod(
  method: string,
  params: Record<string, unknown>,
  req: IncomingMessage,
  workspaceId: string,
  deps: ModelOpsDependencies,
): Promise<unknown> {
  if (method === 'ops.model-usage.summary') {
    deps.requirePlatformReadRole(req)
    if (params.platform_scope !== 'platform') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台模型用量汇总必须显式声明 platform_scope=platform', 400)
    const repository = deps.modelUsage
    if (!repository) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
    const workspaceIds = await deps.listWorkspaceIds()
    const summaries = await mapWithConcurrency(workspaceIds, 24, async targetWorkspaceId => {
      try {
        const records = await repository.list(targetWorkspaceId, 1000)
        return { failed: false, records }
      } catch {
        return { failed: true, records: [] as Awaited<ReturnType<ModelUsageRepository['list']>> }
      }
    })
    const records = summaries.flatMap(summary => summary.records)
    const byModality = records.reduce((counts, row) => { counts[row.modality] = (counts[row.modality] ?? 0) + 1; return counts }, {} as Record<string, number>)
    const byModel = records.reduce((counts, row) => { counts[row.model] = (counts[row.model] ?? 0) + 1; return counts }, {} as Record<string, number>)
    const bySettlementStatus = records.reduce((counts, row) => { counts[row.settlementStatus] = (counts[row.settlementStatus] ?? 0) + 1; return counts }, {} as Record<string, number>)
    const failedWorkspaceCount = summaries.filter(summary => summary.failed).length
    const missingCostEvidenceCount = records.filter(row => row.costCny === undefined || row.costCny === null).length
    const providerCostStatus = failedWorkspaceCount > 0 ? 'unavailable' : missingCostEvidenceCount > 0 ? 'partial' : 'verified'
    return {
      scope: 'platform',
      workspaceCount: workspaceIds.length,
      failedWorkspaceCount,
      recordCount: records.length,
      totalTokens: records.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
      providerCostCny: providerCostStatus === 'verified'
        ? Number(records.reduce((sum, row) => sum + (row.costCny ?? 0), 0).toFixed(6))
        : null,
      missingCostEvidenceCount,
      providerCostStatus,
      customerChargeCny: Number(records.reduce((sum, row) => sum + (row.customerChargeCny ?? 0), 0).toFixed(6)),
      unsettledRecordCount: records.filter(row => !['settled', 'waived'].includes(row.settlementStatus)).length,
      byModality,
      byModel,
      bySettlementStatus,
    }
  }

  if (method === 'ops.commercial.model-markup.get') {
    deps.requirePlatformReadRole(req)
    return deps.commercialExtensions.getModelMarkupPolicy()
  }

  if (method === 'ops.commercial.model-markup.update') {
    const actorId = deps.requirePlatformOps(req)
    const rawMultiplier = deps.required(params, 'multiplier')
    const multiplier = Number(rawMultiplier)
    const expectedRevision = Number(deps.required(params, 'expected_revision'))
    const reason = deps.required(params, 'reason')
    if (!/^\d+(?:\.\d{1,3})?$/u.test(rawMultiplier) || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10 || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, '模型计费倍率必须在 1.0 至 10.0 之间，最多 3 位小数', 400)
    }
    const repository = deps.commercialExtensions
    const before = await repository.getModelMarkupPolicy()
    let item
    try {
      item = await repository.updateModelMarkupPolicy({ multiplier, reason, updatedBy: actorId, expectedRevision })
    } catch (error) {
      if (error instanceof Error && error.message.includes('revision conflict')) {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, '倍率配置已被其他运营人员更新，请刷新后重试', 409)
      }
      throw error
    }
    await deps.recordOperationAudit({ workspaceId, actorId, action: 'commercial.model_markup.update', resourceType: 'model_markup_policy', resourceId: 'global', before: before as unknown as Record<string, unknown>, after: item as unknown as Record<string, unknown>, reason })
    return item
  }

  throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知模型运营方法: ${method}`, 400)
}
