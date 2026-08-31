import { describe, expect, it } from 'vitest'
import { MemoryAuditCenterRepository } from '../../../../packages/persistence/src/audit-center-repository.js'
import { AuditCenterService, AuditCenterServiceError } from './audit-center-service.js'

const event = { id: 'event_1', source: 'operation' as const, workspace_id: 'ws_1', actor_id: '=cmd', action: 'member.update', resource_type: 'member', resource_id: '@target', reason: '+formula', occurred_at: '2026-08-29T00:00:00Z', evidence: { token: 'secret', safe: 'visible' } }
const ops = { actorId: 'ops_1', roles: ['platform_ops'] as const, authorizedWorkspaceIds: [] }
describe('audit center service', () => {
  it('enforces role and workspace access', async () => { const service = new AuditCenterService(new MemoryAuditCenterRepository([event])); await expect(service.list({ actorId: 'x', roles: ['support'], authorizedWorkspaceIds: [] }, { workspaceId: 'ws_1', limit: 10 })).rejects.toBeInstanceOf(AuditCenterServiceError); await expect(service.list(ops, { workspaceId: 'ws_1', limit: 10 })).resolves.toMatchObject({ records: [{ id: 'event_1' }] }) })
  it('merges bounded pages across authorized workspaces without a wildcard scope', async () => {
    const second = { ...event, id: 'event_2', workspace_id: 'ws_2', occurred_at: '2026-08-29T02:00:00Z' }
    const service = new AuditCenterService(new MemoryAuditCenterRepository([event, second]))
    await expect(service.listPlatform(ops, { limit: 1 }, ['ws_1', 'ws_2'])).resolves.toMatchObject({ totalRecords: 2, truncated: true, records: [{ id: 'event_2', workspaceId: 'ws_2' }] })
    await expect(service.listPlatform({ actorId: 'x', roles: ['support'], authorizedWorkspaceIds: [] }, { limit: 10 }, ['ws_1'])).rejects.toBeInstanceOf(AuditCenterServiceError)
    await expect(service.listPlatform(ops, { workspace_id: '*' }, ['ws_1'])).rejects.toThrow('workspaceId')
  })
  it('returns only redacted detail evidence', async () => { const detail = await new AuditCenterService(new MemoryAuditCenterRepository([event])).detail(ops, { workspaceId: 'ws_1', source: 'operation', id: 'event_1' }); expect(detail.evidence.fields).toEqual({ safe: 'visible' }); expect(JSON.stringify(detail)).not.toContain('secret') })
  it('bounds exports and neutralizes spreadsheet formulas', async () => { const result = await new AuditCenterService(new MemoryAuditCenterRepository([event]), () => new Date('2026-08-29T01:00:00Z')).exportCsv(ops, { workspaceId: 'ws_1', limit: 50 }); expect(result.rowCount).toBe(1); expect(result.csv).toContain("\"'=cmd\""); expect(result.csv).toContain("\"'+formula\""); expect(result.csv).toContain("\"'@target\"") })
})
