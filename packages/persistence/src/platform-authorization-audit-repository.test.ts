import { describe, expect, it } from 'vitest'
import { MemoryPlatformAuthorizationAuditRepository, PlatformAuthorizationAuditConnectionProbeError, PostgresPlatformAuthorizationAuditRepository } from './platform-authorization-audit-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const input = (overrides: Record<string, unknown> = {}) => ({
  decisionId: 'decision-1', policyVersion: '2026-08-31.v2', actorId: 'ops-1', workbench: 'platform' as const,
  capability: 'platform.summary.read', method: 'ops.stores.list', result: 'deny' as const, reasonCode: 'AUTHZ_CAPABILITY_MISSING',
  resourceType: 'platform', resourceId: '*', resourceScope: { type: 'platform', ids: ['*'] }, requestId: 'request-1', traceId: 'trace-1', evidence: { safe: true },
  createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
})

describe('platform authorization audit repository', () => {
  it('is idempotent for the same decision facts and rejects conflicting facts', async () => {
    const repo = new MemoryPlatformAuthorizationAuditRepository()
    const first = await repo.append(input())
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    const second = await repo.append(input({ id: 'retry-generated-id' }))
    expect(second).toEqual(first)
    second.evidence.safe = false
    expect((await repo.getByDecisionId('decision-1'))?.evidence.safe).toBe(true)
    await expect(repo.append(input({ result: 'allow' }))).rejects.toMatchObject({ code: 'PLATFORM_AUTHZ_AUDIT_DECISION_CONFLICT' })
  })

  it('filters platform decisions and rejects unsafe context', async () => {
    const repo = new MemoryPlatformAuthorizationAuditRepository()
    await repo.append(input())
    await repo.append(input({ decisionId: 'decision-2', actorId: 'ops-2', result: 'allow', method: 'ops.tasks.summary' }))
    expect(await repo.list({ result: 'allow' })).toHaveLength(1)
    await expect(repo.append(input({ workbench: 'workspace' }))).rejects.toThrow('PLATFORM_AUTHZ_AUDIT_WORKBENCH_INVALID')
    await expect(repo.append(input({ evidence: { huge: 'x'.repeat(33_000) } }))).rejects.toThrow('PLATFORM_AUTHZ_AUDIT_EVIDENCE_INVALID')
  })

  it('probes the pooled role and platform scope before executing audit SQL', async () => {
    const calls: string[] = []
    const client = {
      query: async (text: string) => {
        calls.push(text)
        if (text.startsWith('SELECT current_user')) return { rows: [{ current_user: 'merchant_ops', platform_scope: 'platform_ops' }] }
        if (text === 'BEGIN' || text.startsWith("SELECT set_config('app.platform_scope")) return { rows: [] }
        return { rows: [{ id: 'audit-1', decision_id: 'decision-1', policy_version: '2026-08-31.v2', actor_id: 'ops-1', workbench: 'platform', capability: 'platform.summary.read', method: 'ops.stores.list', result: 'deny', reason_code: 'AUTHZ_CAPABILITY_MISSING', resource_type: 'platform', resource_id: '*', resource_scope: { type: 'platform' }, request_id: 'request-1', trace_id: 'trace-1', evidence: { safe: true }, created_at: '2026-09-01T00:00:00.000Z' }] }
      },
      release: () => undefined,
    } as unknown as SqlClient
    const repo = new PostgresPlatformAuthorizationAuditRepository({ connect: async () => client } satisfies SqlPool)
    await repo.append(input())
    expect(calls.slice(0, 3)).toEqual(['BEGIN', "SELECT set_config('app.platform_scope', 'platform_ops', true)", "SELECT current_user AS current_user, current_setting('app.platform_scope', true) AS platform_scope"])
  })

  it.each([
    [{ current_user: 'merchant_app', platform_scope: 'platform_ops' }],
    [{ current_user: 'merchant_ops', platform_scope: 'tenant_scope' }],
    [{}],
  ])('fails closed when the connection probe is not exact: %o', async (probeRow) => {
    const calls: string[] = []
    const client = {
      query: async (text: string) => {
        calls.push(text)
        if (text.startsWith('SELECT current_user')) return { rows: [probeRow] }
        if (text === 'ROLLBACK') return { rows: [] }
        return { rows: [] }
      },
      release: () => undefined,
    } as unknown as SqlClient
    const repo = new PostgresPlatformAuthorizationAuditRepository({ connect: async () => client } satisfies SqlPool)
    await expect(repo.append(input())).rejects.toBeInstanceOf(PlatformAuthorizationAuditConnectionProbeError)
    expect(calls).not.toContain(expect.stringContaining('INSERT INTO platform_authorization_audit'))
    expect(calls).toContain('ROLLBACK')
  })
})
