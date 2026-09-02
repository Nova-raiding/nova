import type { CapabilityId } from '../../../../packages/contracts/src/authz.js'
import type { CreativePointBalance } from '../../../../packages/persistence/src/creative-point-repository.js'
import type { CreativePointAdjustmentInput } from '../../../../packages/persistence/src/creative-point-lifecycle-repository.js'
import type { CommercialPointAdjustmentApprovalRepository, CommercialPointAdjustmentDecision, CommercialPointAdjustmentProposal } from '../../../../packages/persistence/src/commercial-point-adjustment-approval-repository.js'

export const COMMERCIAL_POINT_ADJUST_PROPOSE_CAPABILITY = 'commercial.point.adjust' as const satisfies CapabilityId
export const COMMERCIAL_POINT_ADJUST_APPROVE_CAPABILITY = 'commercial.point.adjust.approve' as const satisfies CapabilityId
export type CommercialPointAdjustmentPrincipal = { actorId: string; workbench: 'platform' | 'workspace'; capabilities: readonly CapabilityId[] }
export type CommercialPointAdjustmentProposalCommand = { targetWorkspaceId: string; pointsDelta: number; expectedAccessRevision: number; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; expiresAt?: string | null; requestedAt: string }
export type CommercialPointAdjustmentDecisionCommand = { targetWorkspaceId: string; proposalId: string; decision: 'approved' | 'rejected'; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; requestedAt: string }
export interface CommercialPointAdjustmentDependencies { approvals: CommercialPointAdjustmentApprovalRepository; getBalance(workspaceId: string): Promise<CreativePointBalance>; adjust(input: CreativePointAdjustmentInput): Promise<CreativePointBalance> }

export class CommercialPointAdjustmentCommandError extends Error {
  constructor(readonly code: 'COMMERCIAL_POINT_ADJUST_FORBIDDEN' | 'COMMERCIAL_POINT_ADJUST_INVALID' | 'COMMERCIAL_POINT_ADJUSTMENT_NOT_FOUND' | 'CREATIVE_POINT_BALANCE_UNKNOWN', message: string, readonly status: number) { super(message); this.name = 'CommercialPointAdjustmentCommandError' }
}

function required(value: string, field: string): string { const normalized = value.trim(); if (!normalized || normalized !== value) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', `${field} 必须为非空且不能包含首尾空格`, 400); return normalized }
function timestamp(value: string, field: string): string { const parsed = new Date(value); if (Number.isNaN(parsed.valueOf())) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', `${field} 必须是有效时间`, 400); return parsed.toISOString() }
function evidence(value: Record<string, unknown>): Record<string, unknown> { if (!value || Array.isArray(value) || Object.keys(value).length === 0) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', 'evidence 必须包含非空审批证据', 400); return value }
function authorize(principal: CommercialPointAdjustmentPrincipal, capability: CapabilityId): string { if (principal.workbench !== 'platform' || !principal.capabilities.includes(capability)) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_FORBIDDEN', '只有具备独立创意点调账能力的平台运营身份可以执行该动作', 403); return required(principal.actorId, 'actorId') }
function validateMutation(input: { pointsDelta: number; expectedAccessRevision: number; expiresAt?: string | null; requestedAt: string }) { if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', 'pointsDelta 必须是非零安全整数', 400); if (!Number.isSafeInteger(input.expectedAccessRevision) || input.expectedAccessRevision < 0) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', 'expectedAccessRevision 必须是非负安全整数', 400); const requestedAt = timestamp(input.requestedAt, 'requestedAt'); const expiresAt = input.expiresAt == null ? null : timestamp(input.expiresAt, 'expiresAt'); if (input.pointsDelta < 0 && expiresAt !== null) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', '扣减调账不能设置到期时间', 400); if (expiresAt !== null && expiresAt <= requestedAt) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', '增加点数的到期时间必须晚于调账时间', 400); return { requestedAt, expiresAt } }

export async function proposeCommercialPointAdjustment(principal: CommercialPointAdjustmentPrincipal, command: CommercialPointAdjustmentProposalCommand, dependencies: CommercialPointAdjustmentDependencies) {
  const actorId = authorize(principal, COMMERCIAL_POINT_ADJUST_PROPOSE_CAPABILITY)
  const workspaceId = required(command.targetWorkspaceId, 'targetWorkspaceId')
  const { requestedAt, expiresAt } = validateMutation(command)
  const before = await dependencies.getBalance(workspaceId)
  if (before.availablePoints === null) throw new CommercialPointAdjustmentCommandError('CREATIVE_POINT_BALANCE_UNKNOWN', '创意点余额未知，禁止创建调账提案', 503)
  if (before.revision !== command.expectedAccessRevision) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', '创意点 access revision 已变化，请刷新后重试', 409)
  const proposal = await dependencies.approvals.propose({ workspaceId, pointsDelta: command.pointsDelta, expectedAccessRevision: command.expectedAccessRevision, idempotencyKey: required(command.idempotencyKey, 'idempotencyKey'), reason: required(command.reason, 'reason'), evidence: evidence(command.evidence), expiresAt, proposedByActorId: actorId, at: requestedAt })
  return { schema_version: 'commercial.point-adjustment-proposal.v1', proposal: projectProposal(proposal), before: projectBalance(before), status: 'pending_approval' as const }
}

export async function decideCommercialPointAdjustment(principal: CommercialPointAdjustmentPrincipal, command: CommercialPointAdjustmentDecisionCommand, dependencies: CommercialPointAdjustmentDependencies) {
  const actorId = authorize(principal, COMMERCIAL_POINT_ADJUST_APPROVE_CAPABILITY)
  const workspaceId = required(command.targetWorkspaceId, 'targetWorkspaceId')
  const proposalId = required(command.proposalId, 'proposalId')
  const proposal = await dependencies.approvals.getProposal(workspaceId, proposalId)
  if (!proposal) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUSTMENT_NOT_FOUND', '调账提案不存在或不属于当前 workspace', 404)
  if (proposal.proposedByActorId === actorId) throw new CommercialPointAdjustmentCommandError('COMMERCIAL_POINT_ADJUST_INVALID', '提案人不能批准自己的调账提案', 409)
  const decidedAt = timestamp(command.requestedAt, 'requestedAt')
  const decision = await dependencies.approvals.decide({ workspaceId, proposalId, decision: command.decision, actorId, reason: required(command.reason, 'reason'), evidence: evidence(command.evidence), idempotencyKey: required(command.idempotencyKey, 'idempotencyKey'), at: decidedAt })
  if (decision.decision === 'rejected') return { schema_version: 'commercial.point-adjustment-decision.v1', proposal: projectProposal(proposal), decision: projectDecision(decision), status: 'rejected' as const, before: null, after: null }
  const before = await dependencies.getBalance(workspaceId)
  if (before.availablePoints === null) throw new CommercialPointAdjustmentCommandError('CREATIVE_POINT_BALANCE_UNKNOWN', '创意点余额未知，批准记录已保留但禁止执行调账', 503)
  const after = await dependencies.adjust({ workspaceId, approvalId: decision.id, pointsDelta: proposal.pointsDelta, expectedAccessRevision: proposal.expectedAccessRevision, actorId: proposal.proposedByActorId, approvedByActorId: decision.actorId, reason: proposal.reason, evidence: { proposal: proposal.evidence, approval: decision.evidence, approval_reason: decision.reason }, idempotencyKey: `approved:${proposal.id}`, at: decidedAt, ...(proposal.expiresAt !== null ? { expiresAt: proposal.expiresAt } : {}) })
  return { schema_version: 'commercial.point-adjustment-decision.v1', proposal: projectProposal(proposal), decision: projectDecision(decision), status: 'executed' as const, before: projectBalance(before), after: projectBalance(after) }
}

const projectBalance = (item: CreativePointBalance) => ({ available_points: item.availablePoints, reserved_points: item.reservedPoints, settled_points: item.settledPoints, access_revision: String(item.revision) })
const projectProposal = (item: CommercialPointAdjustmentProposal) => ({ id: item.id, workspace_id: item.workspaceId, points_delta: item.pointsDelta, expected_access_revision: String(item.expectedAccessRevision), reason: item.reason, evidence: item.evidence, expires_at: item.expiresAt, proposed_by_actor_id: item.proposedByActorId, idempotency_key: item.idempotencyKey, created_at: item.createdAt })
const projectDecision = (item: CommercialPointAdjustmentDecision) => ({ id: item.id, proposal_id: item.proposalId, decision: item.decision, actor_id: item.actorId, reason: item.reason, evidence: item.evidence, idempotency_key: item.idempotencyKey, created_at: item.createdAt })
