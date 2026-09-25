import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { CommercialPointAdjustmentApprovalRepositoryError } from '../../../packages/persistence/src/commercial-point-adjustment-approval-repository.js'
import { CommercialPointAdjustmentCommandError, decideCommercialPointAdjustment, proposeCommercialPointAdjustment, type CommercialPointAdjustmentDependencies, type CommercialPointAdjustmentPrincipal } from './ops/commercial-point-adjustment.js'

type Params = Record<string, unknown>

export interface CommercialOpsPointAdjustmentDependencies {
  repositories: CommercialPointAdjustmentDependencies | undefined
  principal: CommercialPointAdjustmentPrincipal
  required(params: Params, key: string): string
  parseJsonObjectParameter(params: Params, key: string): Record<string, unknown>
}

export async function handleCommercialOpsPointAdjustment(method: 'ops.commercial.points.adjust.propose' | 'ops.commercial.points.adjust.decide', params: Params, deps: CommercialOpsPointAdjustmentDependencies) {
  const { repositories, principal, required, parseJsonObjectParameter } = deps
  if (!repositories) throw new DomainError('COMMERCIAL_POINT_ADJUSTMENT_REPOSITORY_UNAVAILABLE', '创意点调账审批或账本仓储未配置，禁止调账', 503)
  try {
    if (method === 'ops.commercial.points.adjust.propose') {
      const pointsDelta = Number(required(params, 'points_delta'))
      const expectedAccessRevision = Number(required(params, 'expected_revision'))
      if (!Number.isSafeInteger(pointsDelta) || pointsDelta === 0 || !Number.isSafeInteger(expectedAccessRevision) || expectedAccessRevision < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'points_delta 或 expected_revision 无效', 400)
      return await proposeCommercialPointAdjustment(principal, { targetWorkspaceId: required(params, 'target_workspace_id'), pointsDelta, expectedAccessRevision, idempotencyKey: required(params, 'idempotency_key'), reason: required(params, 'reason'), evidence: parseJsonObjectParameter(params, 'evidence_json'), ...(typeof params.expires_at === 'string' && params.expires_at.trim() ? { expiresAt: params.expires_at.trim() } : {}), requestedAt: new Date().toISOString() }, repositories)
    }
    const decision = required(params, 'decision')
    if (decision !== 'approved' && decision !== 'rejected') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'decision 必须是 approved 或 rejected', 400)
    return await decideCommercialPointAdjustment(principal, { targetWorkspaceId: required(params, 'target_workspace_id'), proposalId: required(params, 'proposal_id'), decision, idempotencyKey: required(params, 'idempotency_key'), reason: required(params, 'reason'), evidence: parseJsonObjectParameter(params, 'evidence_json'), requestedAt: new Date().toISOString() }, repositories)
  } catch (error) {
    if (error instanceof DomainError) throw error
    if (error instanceof CommercialPointAdjustmentCommandError) throw new DomainError(error.code, error.message, error.status)
    if (error instanceof CommercialPointAdjustmentApprovalRepositoryError) {
      const status = error.code === 'COMMERCIAL_POINT_ADJUSTMENT_NOT_FOUND' ? 404 : 409
      throw new DomainError(error.code, error.message, status)
    }
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null
    if (code) throw new DomainError(code, error instanceof Error ? error.message : '创意点调账失败', code.includes('UNKNOWN') ? 503 : 409)
    throw error
  }
}
