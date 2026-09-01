import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server, setRuleRepositoryForTests, workspaceMembers, type RuleRepositoryPort } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import type { PersistedRuleAudit } from '../../../packages/persistence/src/index.js'

type Envelope<T = unknown> = {
  workspace_id: string
  data: T | null
  error: { code: string; details?: Record<string, unknown> } | null
  request_id?: string
  trace_id?: string
}

const audit = (workspaceId: string, rulePackId: string): PersistedRuleAudit => ({
  id: `audit-${workspaceId}`,
  workspaceId,
  rulePackId,
  ruleVersionId: 'rule-version-catalog-1',
  version: '1.0.0',
  action: 'activated',
  actorId: 'rules-admin-1',
  reason: '本地 acceptance fixture',
  data: { source: 'test-only' },
  occurredAt: '2026-09-01T00:00:00.000Z',
})

function repositoryFor(audits: PersistedRuleAudit[]): RuleRepositoryPort {
  return {
    list: async () => [],
    insertVersion: async () => { throw new Error('not used') },
    appendAudit: async input => input,
    updateStatus: async () => { throw new Error('not used') },
    listAudit: async (workspaceId, packId) => audits.filter(item => item.workspaceId === workspaceId && (!packId || item.rulePackId === packId)),
  } as RuleRepositoryPort
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function read<T>(response: Response) { return await response.json() as Envelope<T> }

async function callMcp<T>(base: string, token: string, workspaceId: string, packId?: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `rules-audit-parity-${Date.now()}`,
      method: 'ops.rules.workspace.audit',
      params: packId ? { pack_id: packId } : {},
    }),
  })
  return { response, body: await response.json() as Envelope<T> }
}

describe('ops RBAC rules audit HTTP acceptance', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'rules-audit-acceptance-secret')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setRuleRepositoryForTests(undefined)
    vi.unstubAllEnvs()
  })

  it('allows rules_admin audit reads and scopes the repository query to the requested workspace/pack', async () => {
    const workspaceId = `ws_rules_audit_allow_${Date.now()}`
    const queried: Array<{ workspaceId: string; packId?: string }> = []
    const audits = [audit(workspaceId, 'catalog'), audit('ws_other', 'catalog')]
    setRuleRepositoryForTests({
      ...repositoryFor(audits),
      listAudit: async (queriedWorkspaceId, packId) => {
        queried.push({ workspaceId: queriedWorkspaceId, ...(packId ? { packId } : {}) })
        return audits.filter(item => item.workspaceId === queriedWorkspaceId && (!packId || item.rulePackId === packId))
      },
    })
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'rules-admin-1', displayName: 'Rules audit admin', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'rules-audit-admin-token': { workspaces: [workspaceId], actor_id: 'rules-admin-1', roles: ['rules_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()

    const response = await fetch(`${base}/v1/rules/audit?pack_id=catalog`, {
      headers: { authorization: 'Bearer rules-audit-admin-token', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' },
    })
    const body = await read<PersistedRuleAudit[]>(response)

    expect(response.status).toBe(200)
    expect(body.error).toBeNull()
    expect(body.data).toEqual([expect.objectContaining({ workspaceId, rulePackId: 'catalog' })])
    expect(queried).toEqual([{ workspaceId, packId: 'catalog' }])
  })

  it('denies non-admin and cross-workspace audit reads before repository access without leaking audit identity', async () => {
    const workspaceId = `ws_rules_audit_deny_${Date.now()}`
    const queried: string[] = []
    setRuleRepositoryForTests({
      ...repositoryFor([audit(workspaceId, 'catalog')]),
      listAudit: async queriedWorkspaceId => { queried.push(queriedWorkspaceId); return [audit(queriedWorkspaceId, 'catalog')] },
    })
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'reader-1', displayName: 'Rules audit reader', role: 'operator', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'rules-admin-1', displayName: 'Rules audit admin', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'rules-audit-reader-token': { workspaces: [workspaceId], actor_id: 'reader-1', roles: ['operator'], denied_capabilities: ['rule.read'], workbenches: ['workspace'] },
      'rules-audit-admin-token': { workspaces: [workspaceId], actor_id: 'rules-admin-1', roles: ['rules_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const headers = { authorization: 'Bearer rules-audit-reader-token', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' }

    const deniedRoleResponse = await fetch(`${base}/v1/rules/audit?pack_id=secret-pack`, { headers })
    const deniedRole = await read(deniedRoleResponse)
    expect(deniedRoleResponse.status).toBe(403)
    expect(deniedRole.data).toBeNull()
    expect(deniedRole.error).toMatchObject({ code: 'FORBIDDEN', details: { decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION } })
    expect(deniedRole.error?.details).not.toHaveProperty('workspace_id')
    expect(deniedRole.error?.details).not.toHaveProperty('pack_id')
    expect(deniedRole.request_id).toMatch(/^req_/)
    expect(deniedRole.trace_id).toBe(deniedRole.request_id)

    const crossWorkspaceResponse = await fetch(`${base}/v1/rules/audit?pack_id=secret-pack`, {
      headers: { ...headers, authorization: 'Bearer rules-audit-admin-token', 'x-workspace-id': 'ws_other_rules_audit' },
    })
    const crossWorkspace = await read(crossWorkspaceResponse)
    expect(crossWorkspaceResponse.status).toBe(403)
    expect(crossWorkspace.data).toBeNull()
    // The token/workspace boundary rejects this before a capability decision
    // can be minted; it must still be an opaque deny rather than an audit read.
    expect(crossWorkspace.error).toMatchObject({ code: 'FORBIDDEN' })
    expect(crossWorkspace.error?.details ?? {}).not.toHaveProperty('workspace_id')
    expect(crossWorkspace.error?.details ?? {}).not.toHaveProperty('pack_id')
    expect(crossWorkspace.request_id).toMatch(/^req_/)
    expect(crossWorkspace.trace_id).toBe(crossWorkspace.request_id)
    expect(queried).toEqual([])
  })

  it('keeps HTTP and MCP audit reads decision-parity with allow, deny, and audit evidence', async () => {
    const workspaceId = `ws_rules_audit_parity_${Date.now()}`
    const allowedActorId = `rules-audit-parity-allow-${Date.now()}`
    const deniedActorId = `rules-audit-parity-deny-${Date.now()}`
    const packId = 'parity-pack'
    const audits = [audit(workspaceId, packId), audit('ws_other_rules_audit_parity', packId)]
    setRuleRepositoryForTests(repositoryFor(audits))
    await workspaceMembers.upsert({ workspaceId, externalSubject: allowedActorId, displayName: 'Rules parity allow', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: 'Rules parity deny', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'rules-audit-parity-allow-token': { workspaces: [workspaceId], actor_id: allowedActorId, roles: ['rules_admin'], workbenches: ['workspace'] },
      'rules-audit-parity-deny-token': { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['rules_admin'], denied_capabilities: ['rule.read'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const httpHeaders = { authorization: 'Bearer rules-audit-parity-allow-token', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' }

    const allowedHttp = await fetch(`${base}/v1/rules/audit?pack_id=${packId}`, { headers: httpHeaders })
    const allowedHttpBody = await read<PersistedRuleAudit[]>(allowedHttp)
    const allowedMcp = await callMcp<PersistedRuleAudit[]>(base, 'rules-audit-parity-allow-token', workspaceId, packId)
    const allowedMcpResult = allowedMcp.body.data && 'result' in allowedMcp.body.data ? allowedMcp.body.data.result : null

    expect(allowedHttp.status).toBe(200)
    expect(allowedMcp.response.status).toBe(200)
    expect(allowedHttpBody.error).toBeNull()
    expect(allowedMcp.body.error).toBeNull()
    expect(allowedHttpBody.data).toEqual(allowedMcpResult)
    expect(allowedHttpBody.data).toEqual([expect.objectContaining({ workspaceId, rulePackId: packId })])

    const deniedHttp = await fetch(`${base}/v1/rules/audit?pack_id=${packId}`, {
      headers: { ...httpHeaders, authorization: 'Bearer rules-audit-parity-deny-token' },
    })
    const deniedHttpBody = await read(deniedHttp)
    const deniedMcp = await callMcp(base, 'rules-audit-parity-deny-token', workspaceId, packId)

    for (const result of [
      { response: deniedHttp, body: deniedHttpBody },
      deniedMcp,
    ]) {
      expect(result.response.status).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: {
          capability: 'rule.read',
          reason_code: 'AUTHZ_EXPLICIT_DENY',
          decision_id: expect.any(String),
          policy_version: AUTHZ_POLICY_VERSION,
          workbench: 'workspace',
        },
      })
      expect(result.body.error?.details).not.toHaveProperty('workspace_id')
      expect(result.body.error?.details).not.toHaveProperty('pack_id')
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }

    const denialAudits = (await operationAudits.list(workspaceId)).filter(item => item.action === 'authz.decision' && item.actorId === deniedActorId)
    expect(denialAudits).toHaveLength(2)
    for (const denialAudit of denialAudits) {
      expect(denialAudit.after).toMatchObject({
        capability: 'rule.read',
        result: 'deny',
        reason_code: 'AUTHZ_EXPLICIT_DENY',
        policy_version: AUTHZ_POLICY_VERSION,
        decision_id: expect.any(String),
        request_id: expect.stringMatching(/^req_/),
        trace_id: expect.stringMatching(/^req_/),
      })
      expect(denialAudit.after).not.toHaveProperty('workspace_id')
      expect(denialAudit.after).not.toHaveProperty('pack_id')
    }
  })
})
