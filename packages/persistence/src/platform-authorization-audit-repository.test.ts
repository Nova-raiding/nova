import { describe, expect, it } from 'vitest'
import { MemoryPlatformAuthorizationAuditRepository } from './platform-authorization-audit-repository.js'

const input = (overrides: Record<string, unknown> = {}) => ({
  decisionId: 'decision-1', policyVersion: '2026-08-31.v2', actorId: 'ops-1', workbench: 'platform' as const,
  capability: 'platform.summary.read', method: 'ops.stores.list', result: 'deny' as const, reasonCode: 'AUTHZ_CAPABILITY_MISSING',
  resourceType: 'platform', resourceId: '*', resourceScope: { type: 'platform', ids: ['*'] }, requestId: 'request-1', traceId: 'trace-1', evidence: { safe: true },
  createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
})

describe('platform authorization audit repository', () => {
  it('is idempotent by decision and returns cloned evidence', async () => {
    const repo = new MemoryPlatformAuthorizationAuditRepository()
    const first = await repo.append(input())
    const second = await repo.append(input({ evidence: { safe: false } }))
    expect(second).toEqual(first)
    second.evidence.safe = false
    expect((await repo.getByDecisionId('decision-1'))?.evidence.safe).toBe(true)
  })

  it('filters platform decisions and rejects unsafe context', async () => {
    const repo = new MemoryPlatformAuthorizationAuditRepository()
    await repo.append(input())
    await repo.append(input({ decisionId: 'decision-2', actorId: 'ops-2', result: 'allow', method: 'ops.tasks.summary' }))
    expect(await repo.list({ result: 'allow' })).toHaveLength(1)
    await expect(repo.append(input({ workbench: 'workspace' }))).rejects.toThrow('PLATFORM_AUTHZ_AUDIT_WORKBENCH_INVALID')
    await expect(repo.append(input({ evidence: { huge: 'x'.repeat(33_000) } }))).rejects.toThrow('PLATFORM_AUTHZ_AUDIT_EVIDENCE_INVALID')
  })
})
