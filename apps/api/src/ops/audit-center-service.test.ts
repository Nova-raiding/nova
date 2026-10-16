import { describe, expect, it } from 'vitest'
import { MemoryAuditCenterRepository, PostgresAuditCenterRepository } from '../../../../packages/persistence/src/audit-center-repository.js'
import type { SqlPool } from '../../../../packages/persistence/src/repository.js'
import { AuditCenterService, AuditCenterServiceError } from './audit-center-service.js'

const event = { id: 'event_1', source: 'operation' as const, workspace_id: 'ws_1', actor_id: '=cmd', action: 'member.update', resource_type: 'member', resource_id: '@target', reason: '+formula', occurred_at: '2026-08-29T00:00:00Z', evidence: { token: 'secret', safe: 'visible' } }
const ops = { actorId: 'ops_1', roles: ['platform_ops'] as const, authorizedWorkspaceIds: [], platformWide: true }
describe('audit center service', () => {
  it('reads platform audit results through each allowed tenant scope and merges a bounded page', async () => {
    const row = (id: string, workspace_id: string, occurred_at: string) => ({ ...event, id, workspace_id, occurred_at })
    const facts = [row('a', 'ws_1', '2026-10-16T00:00:00Z'), row('b', 'ws_2', '2026-10-16T01:00:00Z'), row('c', 'ws_2', '2026-10-16T02:00:00Z'), row('private', 'ws_foreign', '2026-10-16T03:00:00Z')]
    const scopes: string[] = []
    const pool = { connect: async () => {
      let scope = ''
      return { release() {}, query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("set_config('app.workspace_id'")) { scope = String(values?.[0]); scopes.push(scope) }
        const visible = facts.filter(fact => fact.workspace_id === scope).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
        if (sql.includes('count(*)')) return { rows: [{ total_records: visible.length }] }
        if (sql.includes('FROM ops_audit_center')) return { rows: visible }
        return { rows: [] }
      } }
    } } as unknown as SqlPool
    const page = await new AuditCenterService(new PostgresAuditCenterRepository(pool)).listPlatform(ops, { limit: 2 }, ['ws_1', 'ws_2', 'ws_1', ' '])
    expect(page.records.map(record => record.id)).toEqual(['c', 'b'])
    expect(page.totalRecords).toBe(3)
    expect(page.truncated).toBe(true)
    expect(scopes).toEqual(['ws_1', 'ws_2'])
    expect(page.records.every(record => record.redacted && record.workspaceId !== 'ws_foreign')).toBe(true)
  })

  it('enforces role and workspace access', async () => { const service = new AuditCenterService(new MemoryAuditCenterRepository([event])); await expect(service.list({ actorId: 'x', roles: ['support'], authorizedWorkspaceIds: [] }, { workspaceId: 'ws_1', limit: 10 })).rejects.toBeInstanceOf(AuditCenterServiceError); await expect(service.list(ops, { workspaceId: 'ws_1', limit: 10 })).resolves.toMatchObject({ records: [{ id: 'event_1' }] }) })
  it('requires an explicit platform grant before the platform_ops label skips the workspace scope check', async () => {
    // `platform_ops` is simultaneously a platform gateway role (canonical
    // `ops_admin`) and a workspace *membership* role that has no canonical form.
    // Carrying that label must therefore not, on its own, skip the check that the
    // requested workspace is inside the caller's authorized scope.
    const service = new AuditCenterService(new MemoryAuditCenterRepository([event]))
    const labelledOnly = { actorId: 'membership-ops', roles: ['platform_ops'] as const, authorizedWorkspaceIds: ['ws_1'] }
    await expect(service.list(labelledOnly, { workspaceId: 'ws_2', limit: 10 })).rejects.toMatchObject({ code: 'AUDIT_CENTER_FORBIDDEN', message: 'workspace is outside the authorized scope' })
    await expect(service.exportCsv(labelledOnly, { workspaceId: 'ws_2', limit: 10 })).rejects.toMatchObject({ code: 'AUDIT_CENTER_FORBIDDEN', message: 'workspace is outside the authorized scope' })
    await expect(service.listPlatform(labelledOnly, { limit: 10 }, ['ws_1'])).rejects.toMatchObject({ code: 'AUDIT_CENTER_FORBIDDEN' })
    await expect(service.list({ ...labelledOnly, platformWide: true }, { workspaceId: 'ws_2', limit: 10 })).resolves.toMatchObject({ totalRecords: 0 })
  })
  it('merges bounded pages across authorized workspaces without a wildcard scope', async () => {
    const second = { ...event, id: 'event_2', workspace_id: 'ws_2', occurred_at: '2026-08-29T02:00:00Z' }
    const service = new AuditCenterService(new MemoryAuditCenterRepository([event, second]))
    await expect(service.listPlatform(ops, { limit: 1 }, ['ws_1', 'ws_2'])).resolves.toMatchObject({ totalRecords: 2, truncated: true, records: [{ id: 'event_2', workspaceId: 'ws_2' }] })
    await expect(service.listPlatform({ actorId: 'x', roles: ['support'], authorizedWorkspaceIds: [] }, { limit: 10 }, ['ws_1'])).rejects.toBeInstanceOf(AuditCenterServiceError)
    await expect(service.listPlatform(ops, { workspace_id: '*' }, ['ws_1'])).rejects.toThrow('workspaceId')
  })
  it('uses the repository bulk path when available', async () => {
    let received: readonly string[] = []
    const repository = {
      listPlatform: async (_query: unknown, workspaceIds: readonly string[]) => { received = workspaceIds; return { records: [], totalRecords: 0, truncated: false } },
    } as never
    await new AuditCenterService(repository).listPlatform(ops, { limit: 10 }, ['ws_1', 'ws_1', 'ws_2'])
    expect(received).toEqual(['ws_1', 'ws_2'])
  })
  it('does not report a complete partial result when one authorized workspace read fails', async () => {
    const repository = {
      list: async ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === 'ws_2') throw new Error('scoped audit read unavailable')
        return { records: [], totalRecords: 0, truncated: false }
      },
    } as never
    await expect(new AuditCenterService(repository).listPlatform(ops, { limit: 10 }, ['ws_1', 'ws_2']))
      .rejects.toThrow('scoped audit read unavailable')
  })
  it('rejects a workspace-only platform label before opening any platform audit reads', async () => {
    let reads = 0
    const repository = { list: async () => { reads += 1; return { records: [], totalRecords: 0, truncated: false } } } as never
    await expect(new AuditCenterService(repository).listPlatform({ actorId: 'workspace-member', roles: ['platform_ops'], authorizedWorkspaceIds: ['ws_1'] }, { limit: 10 }, ['ws_1', 'ws_2']))
      .rejects.toMatchObject({ code: 'AUDIT_CENTER_FORBIDDEN' })
    expect(reads).toBe(0)
  })
  it('returns only redacted detail evidence', async () => { const detail = await new AuditCenterService(new MemoryAuditCenterRepository([event])).detail(ops, { workspaceId: 'ws_1', source: 'operation', id: 'event_1' }); expect(detail.evidence.fields).toEqual({ safe: 'visible' }); expect(JSON.stringify(detail)).not.toContain('secret') })
  it('bounds exports and neutralizes spreadsheet formulas', async () => { const result = await new AuditCenterService(new MemoryAuditCenterRepository([event]), () => new Date('2026-08-29T01:00:00Z')).exportCsv(ops, { workspaceId: 'ws_1', limit: 50 }); expect(result.rowCount).toBe(1); expect(result.csv).toContain("\"'=cmd\""); expect(result.csv).toContain("\"'+formula\""); expect(result.csv).toContain("\"'@target\"") })
  it('rejects cursor pagination instead of silently exporting a different slice', async () => {
    const service = new AuditCenterService(new MemoryAuditCenterRepository([event]))
    await expect(service.exportCsv(ops, { workspaceId: 'ws_1', cursor: 'opaque-cursor', limit: 50 })).rejects.toMatchObject({
      code: 'AUDIT_CENTER_INVALID_REQUEST',
      message: 'audit export does not support cursor pagination',
    })
  })
})
