import { describe, expect, it } from 'vitest'
import { MemoryUnifiedLinkAuditRepository } from './unified-link-audit-repository.js'

const input = { workspaceId: 'ws-a', auditKey: 'product:p-1', entityType: 'product' as const, entityId: 'p-1', legacyProductId: 'p-1', status: 'legacy_only' as const, codes: ['CANONICAL_MAPPING_MISSING'], checkRevision: 'rev-1', checksum: 'a'.repeat(64), observedAt: '2026-08-31T00:00:00.000Z', lastError: 'mapping missing' }

describe('unified link audit repository', () => {
  it('idempotently updates the current state while preserving firstSeenAt and workspace isolation', async () => {
    const repository = new MemoryUnifiedLinkAuditRepository()
    const first = await repository.upsert(input)
    const second = await repository.upsert({ ...input, status: 'verified', codes: [], checkRevision: 'rev-2', observedAt: '2026-08-31T00:02:00.000Z', lastError: undefined })
    expect(second.id).toBe(first.id)
    expect(second.firstSeenAt).toBe(first.firstSeenAt)
    expect(second.lastSeenAt).toBe('2026-08-31T00:02:00.000Z')
    expect(second.status).toBe('verified')
    expect(await repository.list({ workspaceId: 'ws-a' })).toEqual([second])
    expect(await repository.list({ workspaceId: 'ws-b' })).toEqual([])
  })

  it('rejects malformed or non-verified rows without evidence codes', async () => {
    const repository = new MemoryUnifiedLinkAuditRepository()
    await expect(repository.upsert({ ...input, status: 'blocked', codes: [] })).rejects.toThrow('UNIFIED_LINK_AUDIT_CODES_REQUIRED')
    await expect(repository.upsert({ ...input, checkRevision: '' })).rejects.toThrow('UNIFIED_LINK_AUDIT_REVISION_REQUIRED')
  })
})
