import { describe, expect, it } from 'vitest'
import { PostgresRuleRepository } from './rule-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class Client implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text.startsWith('SELECT id, workspace_id, pack_id')) return { rows: [{ id: 'rule-1', workspace_id: 'ws_1', pack_id: 'catalog', name: '商品规则', version: '1.0.0', scope: 'global', status: 'active', source_kind: 'internal', source_reference: 'manual://rules', source_checked_at: '2026-08-23T00:00:00.000Z', checksum: 'a'.repeat(64), checks: {}, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z', created_by: 'owner', revision: 1 }] as Row[] }
    if (text.startsWith('SELECT id, workspace_id, rule_pack_id')) return { rows: [{ id: 'audit-1', workspace_id: 'ws_1', rule_pack_id: 'catalog', rule_version_id: 'rule-1', version: '1.0.0', action: 'created', actor_id: 'owner', reason: 'initial', occurred_at: '2026-08-23T00:00:00.000Z', data: {} }] as Row[] }
    if (text.startsWith('INSERT INTO rule_pack_versions')) return { rows: [{ id: 'rule-1', workspace_id: 'ws_1', pack_id: 'catalog', name: '商品规则', version: '1.0.0', scope: 'global', status: 'active', source_kind: 'internal', source_reference: 'manual://rules', source_checked_at: '2026-08-23T00:00:00.000Z', checksum: 'a'.repeat(64), checks: {}, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z', created_by: 'owner', revision: 1 }] as Row[] }
    if (text.startsWith('UPDATE rule_pack_versions')) return { rows: [{ id: 'rule-1', workspace_id: 'ws_1', pack_id: 'catalog', name: '商品规则', version: '1.0.0', scope: 'global', status: 'inactive', source_kind: 'internal', source_reference: 'manual://rules', source_checked_at: '2026-08-23T00:00:00.000Z', checksum: 'a'.repeat(64), checks: {}, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z', created_by: 'owner', revision: 2, deactivated_at: '2026-08-23T00:00:00.000Z' }] as Row[] }
    if (text.startsWith('INSERT INTO rule_audit_events')) return { rows: [{ id: 'audit-1', workspace_id: 'ws_1', rule_pack_id: 'catalog', rule_version_id: 'rule-1', version: '1.0.0', action: 'created', actor_id: 'owner', reason: 'initial', occurred_at: '2026-08-23T00:00:00.000Z', data: {} }] as Row[] }
    return { rows: [] as Row[] }
  }
  release() {}
}

describe('PostgresRuleRepository', () => {
  it('keeps rule reads and writes inside a workspace transaction', async () => {
    const client = new Client()
    const pool: SqlPool = { connect: async () => client }
    const repo = new PostgresRuleRepository(pool)
    const created = await repo.insertVersion({ id: 'rule-1', workspaceId: 'ws_1', packId: 'catalog', name: '商品规则', version: '1.0.0', scope: 'global', status: 'active', sourceKind: 'internal', sourceReference: 'manual://rules', sourceCheckedAt: '2026-08-23T00:00:00.000Z', checksum: 'a'.repeat(64), checks: {}, createdBy: 'owner', revision: 1 })
    expect(created.workspaceId).toBe('ws_1')
    expect((await repo.list('ws_1'))[0]?.id).toBe('rule-1')
    const audit = await repo.appendAudit({ id: 'audit-1', workspaceId: 'ws_1', rulePackId: 'catalog', ruleVersionId: 'rule-1', version: '1.0.0', action: 'created', actorId: 'owner', reason: 'initial', occurredAt: '2026-08-23T00:00:00.000Z', data: {} })
    expect(audit.ruleVersionId).toBe('rule-1')
    expect((await repo.listAudit('ws_1'))[0]?.actorId).toBe('owner')
    expect(client.calls.some(call => call.text.includes("set_config('app.workspace_id'"))).toBe(true)
  })

  it('rejects missing workspace scope before issuing SQL', async () => {
    const client = new Client()
    const repo = new PostgresRuleRepository({ connect: async () => client })
    await expect(repo.list('')).rejects.toThrow(/workspace/i)
    expect(client.calls).toHaveLength(0)
  })

  it('writes a new rule version and its audit in one transaction boundary', async () => {
    const client = new Client()
    const repo = new PostgresRuleRepository({ connect: async () => client })
    const result = await repo.insertVersionWithAudit({
      version: { id: 'rule-1', workspaceId: 'ws_1', packId: 'catalog', name: '商品规则', version: '1.0.0', scope: 'global', status: 'draft', sourceKind: 'internal', sourceReference: 'manual://rules', sourceCheckedAt: '2026-08-23T00:00:00.000Z', checksum: 'a'.repeat(64), checks: {}, createdBy: 'owner', revision: 1 },
      audit: { id: 'audit-1', workspaceId: 'ws_1', rulePackId: 'catalog', ruleVersionId: 'rule-1', version: '1.0.0', action: 'created', actorId: 'owner', reason: 'initial', occurredAt: '2026-08-23T00:00:00.000Z', data: {} },
    })
    expect(result.version.id).toBe('rule-1')
    expect(result.audit.ruleVersionId).toBe('rule-1')
    expect(client.calls.filter(call => call.text.includes('INSERT INTO')).map(call => call.text)).toHaveLength(2)
  })

  it('casts lifecycle transition timestamps for PostgreSQL parameter inference', async () => {
    const client = new Client()
    const repo = new PostgresRuleRepository({ connect: async () => client })
    const result = await repo.transitionStatusWithAudit({
      workspaceId: 'ws_1', packId: 'catalog', targetId: 'rule-1', status: 'inactive', actorId: 'owner', reason: 'retire',
      occurredAt: '2026-08-23T01:00:00.000Z', targetAuditId: 'audit-2', auditData: {},
    })
    expect(result.version.status).toBe('inactive')
    const transition = client.calls.find(call => call.text.includes('SET status = $4::text'))
    expect(transition?.text).toContain('$5::timestamptz')
  })
})
