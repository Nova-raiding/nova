import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { server, setRuleRepositoryForTests, type RuleRepositoryPort } from './server.js'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'

const bases = new Set<string>()
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (![...bases].some(base => url.startsWith(base))) return nativeFetch(input, init)
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
  headers.set('x-test-commercial-fixture', 'server-e2e')
  return nativeFetch(input, { ...init, headers })
}

function fixtureRule(): PersistedRuleVersion {
  const checks = { forbiddenTerms: ['全网最低'] }
  return {
    id: 'public-review-rule', workspaceId: '__platform_rules__', packId: 'pdd-claims', name: 'PDD claims', version: '4',
    scope: 'platform', status: 'draft', sourceKind: 'internal', sourceReference: 'manual://review.md#PDD-4',
    sourceCheckedAt: '2026-09-25T10:00:00.000Z', checksum: createHash('sha256').update(JSON.stringify(checks)).digest('hex'), checks: { ...checks, __public_scope: 'platform' },
    createdAt: '2026-09-25T10:01:00.000Z', updatedAt: '2026-09-25T10:01:00.000Z', createdBy: 'author-1', revision: 1,
    scopeValue: 'pinduoduo', severity: 'error', action: 'block',
  }
}

function fixtureAudit(): PersistedRuleAudit {
  return {
    id: 'public-review-audit', workspaceId: '__platform_rules__', rulePackId: 'pdd-claims', ruleVersionId: 'public-review-rule', version: '4',
    action: 'created', actorId: 'author-1', reason: 'submitted for review', occurredAt: '2026-09-25T10:01:00.000Z', data: {},
  }
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API did not bind')
  const base = `http://127.0.0.1:${address.port}`
  bases.add(base)
  return base
}

async function call(base: string, token: string, workbench: string, method = 'ops.rules.public.drafts.get', params: Record<string, unknown> = { platform: 'pinduoduo', pack_id: 'pdd-claims', version: '4' }) {
  return nativeFetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-test-commercial-fixture': 'server-e2e',
      'x-workspace-id': 'ws_public_rule_review',
      'x-ops-workbench': workbench,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${token}-${workbench}`, method, params }),
  }).then(response => response.json() as Promise<{ data?: { result?: unknown }; result?: unknown; error?: { code: string } }>)
}

describe('authenticated public rule draft preview MCP boundary', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setRuleRepositoryForTests(undefined)
    vi.unstubAllEnvs()
  })

  it('allows a platform rules_admin to read the exact shared draft and audit trail', async () => {
    const get = vi.fn(async () => fixtureRule())
    const listAudit = vi.fn(async () => [fixtureAudit()])
    setRuleRepositoryForTests({
      list: async () => [],
      listPublicDraftsForReview: async () => ({ items: [fixtureRule()] }),
      getPublicRuleForReview: get,
      listPublicRuleAuditForReview: listAudit,
    } as unknown as RuleRepositoryPort)
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'public-rule-review-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ reviewer: { workspaces: ['ws_public_rule_review'], roles: ['rules_admin'], workbenches: ['platform'], actor_id: 'reviewer-2' } }))
    const base = await start()
    const listResponse = await call(base, 'reviewer', 'platform', 'ops.rules.public.drafts.list', { platform: 'pinduoduo', limit: '10' })
    expect(listResponse.error).toBeNull()
    expect(get).not.toHaveBeenCalled()
    const listed = listResponse.data?.result ?? listResponse.result
    expect(listed).toMatchObject({ items: [{ pack_id: 'pdd-claims', status: 'draft' }] })
    const response = await call(base, 'reviewer', 'platform')
    expect(response.error).toBeNull()
    expect(get).toHaveBeenCalledWith('pinduoduo', 'pdd-claims', '4')
    expect(listAudit).toHaveBeenCalledWith('pinduoduo', 'pdd-claims', '4')
    const output = response.data?.result ?? response.result
    expect(output).toMatchObject({ rule: { pack_id: 'pdd-claims', status: 'draft', source: { trust: 'manual_pending_review' } }, audit: [{ actor_id: 'author-1', action: 'created' }] })
    expect(JSON.stringify(output)).not.toContain('__platform_rules__')

    const nativeTools = await nativeFetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer reviewer', 'x-workspace-id': 'ws_public_rule_review', 'x-ops-workbench': 'platform', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'list-tools', method: 'tools/list', params: {} }),
    }).then(response => response.json() as Promise<{ result?: { tools?: Array<{ name: string }> } }>)
    expect(nativeTools.result?.tools?.some(tool => tool.name.startsWith('ops.rules.public.drafts.'))).toBe(false)
  })

  it('rejects a workspace rules_admin even when the request spoofs the platform workbench header', async () => {
    const get = vi.fn(async () => fixtureRule())
    setRuleRepositoryForTests({ list: async () => [], getPublicRuleForReview: get } as unknown as RuleRepositoryPort)
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'public-rule-review-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ tenant_admin: { workspaces: ['ws_public_rule_review'], roles: ['rules_admin'], workbenches: ['workspace'], actor_id: 'tenant-user' } }))
    const base = await start()
    const response = await call(base, 'tenant_admin', 'platform')
    expect(response.error?.code).toBeTruthy()
    expect(get).not.toHaveBeenCalled()
  })

  it('denies a tenant rules_admin from creating or deactivating public platform rules', async () => {
    const insertPublicVersionWithAudit = vi.fn(async () => { throw new Error('public rule write must not be reached') })
    const transitionPublicStatus = vi.fn(async () => { throw new Error('public rule status write must not be reached') })
    setRuleRepositoryForTests({
      list: async () => [],
      insertPublicVersionWithAudit,
      transitionPublicStatus,
    } as unknown as RuleRepositoryPort)
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'public-rule-review-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ tenant_admin: { workspaces: ['ws_public_rule_review'], roles: ['rules_admin'], workbenches: ['workspace'], actor_id: 'tenant-user' } }))
    const base = await start()
    const createParams = {
      pack_id: 'tenant-public-attempt', name: 'Tenant attempted public rule', version: '1',
      scope: 'platform', category: 'platform', public_scope: 'platform', target_id: 'pinduoduo',
      source_reference: 'manual://rules.md#tenant-attempt', source_checked_at: '2026-09-25T10:00:00.000Z',
      checks_json: JSON.stringify({ forbiddenTerms: ['claim'] }), reason: 'tenant public rule attempt',
    }
    const deactivateParams = {
      pack_id: 'tenant-public-attempt', version: '1', status: 'inactive', public_scope: 'platform',
      platform: 'pinduoduo', expected_revision: '1', reason: 'tenant deactivate attempt',
    }

    // Spoofed platform workbench is rejected by token-bound workbench authorization.
    const spoofedCreate = await call(base, 'tenant_admin', 'platform', 'rule.publish', createParams)
    const spoofedDeactivate = await call(base, 'tenant_admin', 'platform', 'rule.status', deactivateParams)
    expect(spoofedCreate.error?.code).toBeTruthy()
    expect(spoofedDeactivate.error?.code).toBeTruthy()

    // With the real workspace principal selected, the handler's platform reviewer guard must also deny these public writes.
    const workspaceCreate = await call(base, 'tenant_admin', 'workspace', 'rule.publish', createParams)
    const workspaceDeactivate = await call(base, 'tenant_admin', 'workspace', 'rule.status', deactivateParams)
    expect(workspaceCreate.error?.code).toBeTruthy()
    expect(workspaceDeactivate.error?.code).toBeTruthy()
    expect(insertPublicVersionWithAudit).not.toHaveBeenCalled()
    expect(transitionPublicStatus).not.toHaveBeenCalled()
  })

  it('denies an authenticated platform role without rules_admin before repository access', async () => {
    const get = vi.fn(async () => fixtureRule())
    setRuleRepositoryForTests({ list: async () => [], getPublicRuleForReview: get } as unknown as RuleRepositoryPort)
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'public-rule-review-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ ops: { workspaces: ['ws_public_rule_review'], roles: ['ops_admin'], workbenches: ['platform'], actor_id: 'ops-user' } }))
    const base = await start()
    const response = await call(base, 'ops', 'platform')
    expect(response.error?.code).toBeTruthy()
    expect(get).not.toHaveBeenCalled()
  })

  it('denies ordinary workspace operators before repository access', async () => {
    const get = vi.fn(async () => fixtureRule())
    setRuleRepositoryForTests({ list: async () => [], getPublicRuleForReview: get } as unknown as RuleRepositoryPort)
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'public-rule-review-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ operator: { workspaces: ['ws_public_rule_review'], roles: ['operator'], workbenches: ['workspace'], actor_id: 'operator-1' } }))
    const base = await start()
    const response = await call(base, 'operator', 'workspace')
    expect(response.error?.code).toBeTruthy()
    expect(get).not.toHaveBeenCalled()
  })
})
