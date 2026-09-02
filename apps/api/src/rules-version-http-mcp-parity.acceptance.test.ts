import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { server, setAuthorizationRepositoryForTests, setRuleRepositoryForTests, workspaceMembers, type RuleRepositoryPort } from './server.js'

type Envelope = {
  workspace_id?: string
  data: unknown | null
  error: { code: string; details?: Record<string, unknown> } | null
  request_id?: string
  trace_id?: string
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

const authHeaders = (token: string, workspaceId: string) => ({
  authorization: `Bearer ${token}`,
  'x-workspace-id': workspaceId,
  'x-ops-workbench': 'platform',
})

const ruleInput = {
  name: 'Parity rule',
  version: '1.0.0',
  scope: 'global',
  source_kind: 'internal',
  source_reference: 'test://rule-parity',
  source_checked_at: '2026-09-01T00:00:00.000Z',
  checks: {},
  reason: '验证 HTTP/MCP 授权一致性',
  status: 'draft',
}

async function read(response: Response) {
  return await response.json() as Envelope
}

describe('rule version HTTP/MCP authorization parity', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'rule-version-parity-secret')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setAuthorizationRepositoryForTests(undefined)
    setRuleRepositoryForTests(undefined)
    vi.unstubAllEnvs()
  })

  it('fails closed identically before repository access when rule.publish approval is denied', async () => {
    const workspaceId = `ws_rule_version_parity_${Date.now()}`
    const actorId = `rule-version-parity-${Date.now()}`
    const queried: string[] = []
    const repository: RuleRepositoryPort = {
      list: async () => [],
      insertVersion: async () => { throw new Error('not used') },
      insertVersionWithAudit: async () => { throw new Error('not used') },
      appendAudit: async () => { throw new Error('not used') },
      updateStatus: async () => { throw new Error('not used') },
      listAudit: async () => [],
    }
    setRuleRepositoryForTests({
      ...repository,
      insertVersionWithAudit: async () => {
        queried.push('insert')
        throw new Error('repository must not be reached')
      },
    })
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'rule-version-parity-token': {
        workspaces: [workspaceId], actor_id: actorId, roles: ['rules_admin'], workbenches: ['platform'],
        denied_capabilities: ['rule.publish.approve'],
      },
    }))
    const base = await start()

    const httpResponse = await fetch(`${base}/v1/rules/parity-pack/versions`, {
      method: 'POST',
      headers: { ...authHeaders('rule-version-parity-token', workspaceId), 'content-type': 'application/json' },
      body: JSON.stringify(ruleInput),
    })
    const http = await read(httpResponse)
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders('rule-version-parity-token', workspaceId), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'rule-version-parity', method: 'rule.publish', params: { ...ruleInput, pack_id: 'parity-pack', checks: undefined, checks_json: '{}' } }),
    })
    const mcp = await read(mcpResponse)

    for (const result of [{ response: httpResponse, body: http }, { response: mcpResponse, body: mcp }]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: {
          capability: 'rule.publish.approve',
          reason_code: 'AUTHZ_EXPLICIT_DENY',
          policy_version: AUTHZ_POLICY_VERSION,
          decision_id: expect.any(String),
        },
      })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }
    expect(queried).toEqual([])
  })
})
