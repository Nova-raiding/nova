import { describe, expect, it, vi } from 'vitest'
import type { CapabilityId } from '../../../../packages/contracts/src/authz.js'
import { decideCommercialPointAdjustment, proposeCommercialPointAdjustment } from './commercial-point-adjustment.js'

const proposal = { id: 'proposal_1', workspaceId: 'ws_1', pointsDelta: 100, expectedAccessRevision: 7, reason: '客服工单核实后的点数修正', evidence: { ticket: 'T-1' }, expiresAt: null, proposedByActorId: 'ops_maker', idempotencyKey: 'proposal_key', createdAt: '2026-09-02T00:00:00.000Z' }
const deps = () => ({
  approvals: {
    propose: vi.fn().mockResolvedValue(proposal),
    getProposal: vi.fn().mockResolvedValue(proposal),
    decide: vi.fn().mockResolvedValue({ id: 'decision_1', workspaceId: 'ws_1', proposalId: 'proposal_1', decision: 'approved', actorId: 'finance_approver', reason: '证据复核通过', evidence: { approval: 'APR-1' }, idempotencyKey: 'decision_key', createdAt: '2026-09-02T01:00:00.000Z' }),
  },
  getBalance: vi.fn().mockResolvedValue({ workspaceId: 'ws_1', availablePoints: 500, reservedPoints: 10, settledPoints: 90, revision: 7 }),
  adjust: vi.fn().mockResolvedValue({ workspaceId: 'ws_1', availablePoints: 600, reservedPoints: 10, settledPoints: 90, revision: 8 }),
})
const principal = (actorId: string, capability: CapabilityId, workbench: 'platform' | 'workspace' = 'platform') => ({ actorId, workbench, capabilities: [capability] })

describe('commercial point adjustment two-person command', () => {
  it('persists a proposal without adjusting balance', async () => {
    const dependencies = deps()
    await expect(proposeCommercialPointAdjustment(principal('ops_maker', 'commercial.point.adjust'), { targetWorkspaceId: 'ws_1', pointsDelta: 100, expectedAccessRevision: 7, idempotencyKey: 'proposal_key', reason: proposal.reason, evidence: proposal.evidence, requestedAt: proposal.createdAt }, dependencies)).resolves.toMatchObject({ status: 'pending_approval', proposal: { proposed_by_actor_id: 'ops_maker' } })
    expect(dependencies.adjust).not.toHaveBeenCalled()
  })

  it('derives the approver from auth context and executes the persisted proposal', async () => {
    const dependencies = deps()
    await expect(decideCommercialPointAdjustment(principal('finance_approver', 'commercial.point.adjust.approve'), { targetWorkspaceId: 'ws_1', proposalId: 'proposal_1', decision: 'approved', idempotencyKey: 'decision_key', reason: '证据复核通过', evidence: { approval: 'APR-1' }, requestedAt: '2026-09-02T01:00:00.000Z' }, dependencies)).resolves.toMatchObject({ status: 'executed', before: { available_points: 500 }, after: { available_points: 600 } })
    expect(dependencies.approvals.decide).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'finance_approver' }))
    expect(dependencies.adjust).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'ops_maker', approvedByActorId: 'finance_approver', approvalId: 'decision_1', expectedAccessRevision: 7 }))
  })

  it('does not execute a rejected proposal', async () => {
    const dependencies = deps()
    dependencies.approvals.decide.mockResolvedValue({ id: 'decision_2', workspaceId: 'ws_1', proposalId: 'proposal_1', decision: 'rejected', actorId: 'finance_approver', reason: '证据不足', evidence: { approval: 'APR-2' }, idempotencyKey: 'reject_key', createdAt: '2026-09-02T01:00:00.000Z' })
    await expect(decideCommercialPointAdjustment(principal('finance_approver', 'commercial.point.adjust.approve'), { targetWorkspaceId: 'ws_1', proposalId: 'proposal_1', decision: 'rejected', idempotencyKey: 'reject_key', reason: '证据不足', evidence: { approval: 'APR-2' }, requestedAt: '2026-09-02T01:00:00.000Z' }, dependencies)).resolves.toMatchObject({ status: 'rejected', after: null })
    expect(dependencies.adjust).not.toHaveBeenCalled()
  })

  it('rejects self approval before writing a decision', async () => {
    const dependencies = deps()
    await expect(decideCommercialPointAdjustment(principal('ops_maker', 'commercial.point.adjust.approve'), { targetWorkspaceId: 'ws_1', proposalId: 'proposal_1', decision: 'approved', idempotencyKey: 'self', reason: 'self', evidence: { approval: 'x' }, requestedAt: '2026-09-02T01:00:00.000Z' }, dependencies)).rejects.toMatchObject({ code: 'COMMERCIAL_POINT_ADJUST_INVALID', status: 409 })
    expect(dependencies.approvals.decide).not.toHaveBeenCalled()
    expect(dependencies.adjust).not.toHaveBeenCalled()
  })

  it.each([['workspace maker', principal('maker', 'commercial.point.adjust', 'workspace')], ['merchant without capability', { actorId: 'merchant', workbench: 'workspace' as const, capabilities: [] }]])('rejects %s before reading balance', async (_label, denied) => {
    const dependencies = deps()
    await expect(proposeCommercialPointAdjustment(denied, { targetWorkspaceId: 'ws_1', pointsDelta: 1, expectedAccessRevision: 7, idempotencyKey: 'p', reason: 'r', evidence: { x: 1 }, requestedAt: proposal.createdAt }, dependencies)).rejects.toMatchObject({ code: 'COMMERCIAL_POINT_ADJUST_FORBIDDEN' })
    expect(dependencies.getBalance).not.toHaveBeenCalled()
  })
})
