import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialPointAdjustmentApprovalRepository } from './commercial-point-adjustment-approval-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const databaseUrl = (base: URL, name: string, user?: string, password?: string) => { const value = new URL(base); value.pathname = `/${name}`; if (user) value.username = user; if (password) value.password = password; return value.toString() }

describe('commercial point adjustment approval PostgreSQL E2', () => {
  it('enforces maker/approver separation, RLS, append-only facts, replay and revision fencing', async () => {
    const base = new URL(databaseUrlValue)
    const name = `point_adjust_159_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-adjust-a','active'),('ws-adjust-b','active')")
      await database.query("INSERT INTO creative_point_access_state(workspace_id,available_points,reserved_points,settled_points,revision) VALUES ('ws-adjust-a',500,0,0,7),('ws-adjust-b',100,0,0,1)")
      app = new Pool({ connectionString: databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only') })
      const approvals = new PostgresCommercialPointAdjustmentApprovalRepository(app)
      const lifecycle = new PostgresCreativePointLifecycleRepository(app)
      const proposalInput = { workspaceId: 'ws-adjust-a', pointsDelta: 100, expectedAccessRevision: 7, reason: 'verified support correction', evidence: { ticket: 'T-E2' }, expiresAt: null, proposedByActorId: 'ops-maker', idempotencyKey: 'proposal-e2', at: '2026-09-02T00:00:00Z' }
      const proposal = await approvals.propose(proposalInput)
      expect(await approvals.propose(proposalInput)).toEqual(proposal)
      expect(await approvals.getProposal('ws-adjust-b', proposal.id)).toBeNull()
      await expect(approvals.decide({ workspaceId: 'ws-adjust-a', proposalId: proposal.id, decision: 'approved', actorId: 'ops-maker', reason: 'self approval', evidence: { approval: 'invalid' }, idempotencyKey: 'self-e2', at: '2026-09-02T00:01:00Z' })).rejects.toMatchObject({ code: 'COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID' })
      const decisionInput = { workspaceId: 'ws-adjust-a', proposalId: proposal.id, decision: 'approved' as const, actorId: 'finance-approver', reason: 'finance evidence verified', evidence: { approval: 'APR-E2' }, idempotencyKey: 'decision-e2', at: '2026-09-02T00:02:00Z' }
      const decision = await approvals.decide(decisionInput)
      expect(await approvals.decide(decisionInput)).toEqual(decision)
      await expect(lifecycle.adjust({ workspaceId: 'ws-adjust-a', approvalId: decision.id, pointsDelta: proposal.pointsDelta, expectedAccessRevision: proposal.expectedAccessRevision, actorId: proposal.proposedByActorId, approvedByActorId: decision.actorId, reason: proposal.reason, evidence: { proposal: proposal.evidence, approval: decision.evidence }, idempotencyKey: `approved:${proposal.id}`, at: decision.createdAt })).resolves.toMatchObject({ availablePoints: 600, revision: 8 })
      await expect(lifecycle.adjust({ workspaceId: 'ws-adjust-a', approvalId: decision.id, pointsDelta: proposal.pointsDelta, expectedAccessRevision: proposal.expectedAccessRevision, actorId: proposal.proposedByActorId, approvedByActorId: decision.actorId, reason: proposal.reason, evidence: { proposal: proposal.evidence, approval: decision.evidence }, idempotencyKey: `approved:${proposal.id}`, at: decision.createdAt })).resolves.toMatchObject({ availablePoints: 600, revision: 8 })
      await expect(database.query("UPDATE commercial_point_adjustment_proposals_v2 SET reason='tamper' WHERE workspace_id='ws-adjust-a'" )).rejects.toMatchObject({ code: '55000' })
      await expect(database.query("DELETE FROM commercial_point_adjustment_decisions_v2 WHERE workspace_id='ws-adjust-a'" )).rejects.toMatchObject({ code: '55000' })
      await expect(lifecycle.adjust({ workspaceId: 'ws-adjust-a', approvalId: 'stale-approval', pointsDelta: 1, expectedAccessRevision: 7, actorId: 'other-maker', approvedByActorId: 'other-approver', reason: 'stale correction', evidence: { ticket: 'stale' }, idempotencyKey: 'stale-adjust', at: '2026-09-02T00:03:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    } finally {
      await app?.end(); await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name])
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 240_000)
})
