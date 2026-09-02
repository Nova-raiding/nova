import { describe, expect, it } from 'vitest'
import { PostgresCommercialPointAdjustmentApprovalRepository } from './commercial-point-adjustment-approval-repository.js'
import type { SqlClient, SqlQueryResult } from './repository.js'

class Client implements SqlClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  constructor(private readonly respond: (sql: string) => SqlQueryResult = () => ({ rows: [] })) {}
  async query<Row>(sql: string, values?: readonly unknown[]) { this.calls.push({ sql, values }); return this.respond(sql) as SqlQueryResult<Row> }
}

describe('PostgresCommercialPointAdjustmentApprovalRepository', () => {
  it('inserts an immutable workspace-scoped proposal with a request hash', async () => {
    const row = { id: 'proposal_1', workspaceId: 'ws_1', pointsDelta: 100, expectedAccessRevision: 7, reason: 'correction', evidence: { ticket: 'T-1' }, expiresAt: null, proposedByActorId: 'maker', idempotencyKey: 'proposal_key', requestHash: 'a'.repeat(64), createdAt: '2026-09-02T00:00:00.000Z' }
    const client = new Client(sql => sql.includes('INSERT INTO commercial_point_adjustment_proposals_v2') ? { rows: [row] } : { rows: [] })
    const repository = new PostgresCommercialPointAdjustmentApprovalRepository({ connect: async () => client })
    await expect(repository.propose({ workspaceId: 'ws_1', pointsDelta: 100, expectedAccessRevision: 7, reason: 'correction', evidence: { ticket: 'T-1' }, expiresAt: null, proposedByActorId: 'maker', idempotencyKey: 'proposal_key', at: '2026-09-02T00:00:00.000Z' })).resolves.toMatchObject({ id: 'proposal_1', proposedByActorId: 'maker' })
    const insert = client.calls.find(call => call.sql.includes('INSERT INTO commercial_point_adjustment_proposals_v2'))
    expect(insert?.sql).toContain('$10')
    expect(insert?.values?.[9]).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects self approval before inserting a decision', async () => {
    const proposal = { id: 'proposal_1', workspaceId: 'ws_1', pointsDelta: 100, expectedAccessRevision: 7, reason: 'correction', evidence: { ticket: 'T-1' }, expiresAt: null, proposedByActorId: 'maker', idempotencyKey: 'proposal_key', requestHash: 'a'.repeat(64), createdAt: '2026-09-02T00:00:00.000Z' }
    const client = new Client(sql => sql.includes('FROM commercial_point_adjustment_proposals_v2') && sql.includes('FOR SHARE') ? { rows: [proposal] } : { rows: [] })
    const repository = new PostgresCommercialPointAdjustmentApprovalRepository({ connect: async () => client })
    await expect(repository.decide({ workspaceId: 'ws_1', proposalId: 'proposal_1', decision: 'approved', actorId: 'maker', reason: 'self', evidence: { approval: 'A-1' }, idempotencyKey: 'decision_key', at: '2026-09-02T01:00:00.000Z' })).rejects.toMatchObject({ code: 'COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID' })
    expect(client.calls.some(call => call.sql.includes('INSERT INTO commercial_point_adjustment_decisions_v2'))).toBe(false)
  })
})
