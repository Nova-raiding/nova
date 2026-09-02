import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type CommercialPointAdjustmentProposal = {
  id: string
  workspaceId: string
  pointsDelta: number
  expectedAccessRevision: number
  reason: string
  evidence: Record<string, unknown>
  expiresAt: string | null
  proposedByActorId: string
  idempotencyKey: string
  createdAt: string
}

export type CommercialPointAdjustmentDecision = {
  id: string
  workspaceId: string
  proposalId: string
  decision: 'approved' | 'rejected'
  actorId: string
  reason: string
  evidence: Record<string, unknown>
  idempotencyKey: string
  createdAt: string
}

export interface CommercialPointAdjustmentApprovalRepository {
  propose(input: Omit<CommercialPointAdjustmentProposal, 'id' | 'createdAt'> & { at: string }): Promise<CommercialPointAdjustmentProposal>
  getProposal(workspaceId: string, proposalId: string): Promise<CommercialPointAdjustmentProposal | null>
  decide(input: Omit<CommercialPointAdjustmentDecision, 'id' | 'createdAt'> & { at: string }): Promise<CommercialPointAdjustmentDecision>
}

export class CommercialPointAdjustmentApprovalRepositoryError extends Error {
  constructor(readonly code: 'COMMERCIAL_POINT_ADJUSTMENT_NOT_FOUND' | 'COMMERCIAL_POINT_ADJUSTMENT_IDEMPOTENCY_CONFLICT' | 'COMMERCIAL_POINT_ADJUSTMENT_DECISION_CONFLICT' | 'COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID', message: string) {
    super(message)
    this.name = 'CommercialPointAdjustmentApprovalRepositoryError'
  }
}

type ProposalRow = {
  id: string; workspaceId: string; pointsDelta: string | number; expectedAccessRevision: string | number; reason: string; evidence: Record<string, unknown>; expiresAt: Date | string | null; proposedByActorId: string; idempotencyKey: string; requestHash: string; createdAt: Date | string
}
type DecisionRow = {
  id: string; workspaceId: string; proposalId: string; decision: 'approved' | 'rejected'; actorId: string; reason: string; evidence: Record<string, unknown>; idempotencyKey: string; requestHash: string; createdAt: Date | string
}

const iso = (value: Date | string): string => new Date(value).toISOString()
const proposal = (row: ProposalRow): CommercialPointAdjustmentProposal => ({ id: row.id, workspaceId: row.workspaceId, pointsDelta: Number(row.pointsDelta), expectedAccessRevision: Number(row.expectedAccessRevision), reason: row.reason, evidence: row.evidence, expiresAt: row.expiresAt === null ? null : iso(row.expiresAt), proposedByActorId: row.proposedByActorId, idempotencyKey: row.idempotencyKey, createdAt: iso(row.createdAt) })
const decision = (row: DecisionRow): CommercialPointAdjustmentDecision => ({ id: row.id, workspaceId: row.workspaceId, proposalId: row.proposalId, decision: row.decision, actorId: row.actorId, reason: row.reason, evidence: row.evidence, idempotencyKey: row.idempotencyKey, createdAt: iso(row.createdAt) })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class PostgresCommercialPointAdjustmentApprovalRepository implements CommercialPointAdjustmentApprovalRepository {
  constructor(private readonly pool: SqlPool) {}

  async propose(input: Omit<CommercialPointAdjustmentProposal, 'id' | 'createdAt'> & { at: string }): Promise<CommercialPointAdjustmentProposal> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const requestHash = digest({ pointsDelta: input.pointsDelta, expectedAccessRevision: input.expectedAccessRevision, reason: input.reason, evidence: input.evidence, expiresAt: input.expiresAt, proposedByActorId: input.proposedByActorId })
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await this.proposalByIdempotency(client, workspaceId, input.idempotencyKey)
      if (replay) {
        if (replay.requestHash !== requestHash) throw new CommercialPointAdjustmentApprovalRepositoryError('COMMERCIAL_POINT_ADJUSTMENT_IDEMPOTENCY_CONFLICT', 'proposal idempotency key is bound to another request')
        return proposal(replay)
      }
      const rows = await client.query<ProposalRow>(`INSERT INTO commercial_point_adjustment_proposals_v2 (id,workspace_id,points_delta,expected_access_revision,reason,evidence,expires_at,proposed_by_actor_id,idempotency_key,request_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8,$9,$10,$11::timestamptz) RETURNING id,workspace_id AS "workspaceId",points_delta AS "pointsDelta",expected_access_revision AS "expectedAccessRevision",reason,evidence,expires_at AS "expiresAt",proposed_by_actor_id AS "proposedByActorId",idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt"`, [`cpap_${randomUUID()}`, workspaceId, input.pointsDelta, input.expectedAccessRevision, input.reason, JSON.stringify(input.evidence), input.expiresAt, input.proposedByActorId, input.idempotencyKey, requestHash, input.at])
      return proposal(rows.rows[0]!)
    })
  }

  async getProposal(workspaceIdInput: string, proposalId: string): Promise<CommercialPointAdjustmentProposal | null> {
    const workspaceId = requireWorkspaceScope(workspaceIdInput)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const rows = await client.query<ProposalRow>(`SELECT id,workspace_id AS "workspaceId",points_delta AS "pointsDelta",expected_access_revision AS "expectedAccessRevision",reason,evidence,expires_at AS "expiresAt",proposed_by_actor_id AS "proposedByActorId",idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt" FROM commercial_point_adjustment_proposals_v2 WHERE workspace_id=$1 AND id=$2`, [workspaceId, proposalId])
      return rows.rows[0] ? proposal(rows.rows[0]) : null
    })
  }

  async decide(input: Omit<CommercialPointAdjustmentDecision, 'id' | 'createdAt'> & { at: string }): Promise<CommercialPointAdjustmentDecision> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const requestHash = digest({ proposalId: input.proposalId, decision: input.decision, actorId: input.actorId, reason: input.reason, evidence: input.evidence })
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await this.decisionByIdempotency(client, workspaceId, input.idempotencyKey)
      if (replay) {
        if (replay.requestHash !== requestHash) throw new CommercialPointAdjustmentApprovalRepositoryError('COMMERCIAL_POINT_ADJUSTMENT_IDEMPOTENCY_CONFLICT', 'decision idempotency key is bound to another request')
        return decision(replay)
      }
      const proposalRows = await client.query<ProposalRow>(`SELECT id,workspace_id AS "workspaceId",points_delta AS "pointsDelta",expected_access_revision AS "expectedAccessRevision",reason,evidence,expires_at AS "expiresAt",proposed_by_actor_id AS "proposedByActorId",idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt" FROM commercial_point_adjustment_proposals_v2 WHERE workspace_id=$1 AND id=$2`, [workspaceId, input.proposalId])
      const proposalRow = proposalRows.rows[0]
      if (!proposalRow) throw new CommercialPointAdjustmentApprovalRepositoryError('COMMERCIAL_POINT_ADJUSTMENT_NOT_FOUND', 'adjustment proposal was not found')
      if (proposalRow.proposedByActorId === input.actorId) throw new CommercialPointAdjustmentApprovalRepositoryError('COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID', 'proposal maker cannot approve their own adjustment')
      const existing = await client.query<DecisionRow>(`SELECT id,workspace_id AS "workspaceId",proposal_id AS "proposalId",decision,actor_id AS "actorId",reason,evidence,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt" FROM commercial_point_adjustment_decisions_v2 WHERE workspace_id=$1 AND proposal_id=$2`, [workspaceId, input.proposalId])
      if (existing.rows[0]) throw new CommercialPointAdjustmentApprovalRepositoryError('COMMERCIAL_POINT_ADJUSTMENT_DECISION_CONFLICT', 'adjustment proposal already has a decision')
      const rows = await client.query<DecisionRow>(`INSERT INTO commercial_point_adjustment_decisions_v2 (id,workspace_id,proposal_id,decision,actor_id,reason,evidence,idempotency_key,request_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::timestamptz) RETURNING id,workspace_id AS "workspaceId",proposal_id AS "proposalId",decision,actor_id AS "actorId",reason,evidence,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt"`, [`cpadn_${randomUUID()}`, workspaceId, input.proposalId, input.decision, input.actorId, input.reason, JSON.stringify(input.evidence), input.idempotencyKey, requestHash, input.at])
      return decision(rows.rows[0]!)
    })
  }

  private async proposalByIdempotency(client: SqlClient, workspaceId: string, key: string) { const rows = await client.query<ProposalRow>(`SELECT id,workspace_id AS "workspaceId",points_delta AS "pointsDelta",expected_access_revision AS "expectedAccessRevision",reason,evidence,expires_at AS "expiresAt",proposed_by_actor_id AS "proposedByActorId",idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt" FROM commercial_point_adjustment_proposals_v2 WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, key]); return rows.rows[0] }
  private async decisionByIdempotency(client: SqlClient, workspaceId: string, key: string) { const rows = await client.query<DecisionRow>(`SELECT id,workspace_id AS "workspaceId",proposal_id AS "proposalId",decision,actor_id AS "actorId",reason,evidence,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_at AS "createdAt" FROM commercial_point_adjustment_decisions_v2 WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, key]); return rows.rows[0] }
}
