import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, setRuleRepositoryForTests, workspaceMembers, type RuleRepositoryPort } from './server.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { setAuthorizationRepositoryForTests } from './server.js'

type Envelope = { data: unknown | null; error: { code: string } | null; request_id?: string; trace_id?: string }

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

const headers = (workspaceId: string) => ({ authorization: 'Bearer rules-audit-pack-token', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })

describe('rules audit HTTP/MCP pack_id validation parity', () => {
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'rules-audit-pack-parity-secret')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
    const workspaceId = 'ws_rules_audit_pack_parity'
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'rules-audit-pack-actor', displayName: 'Rules audit pack actor', role: 'merchant_admin', status: 'active', invitedBy: 'parity-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'rules-audit-pack-token': { workspaces: [workspaceId], actor_id: 'rules-audit-pack-actor', roles: ['rules_admin'], workbenches: ['workspace'] } }))
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setAuthorizationRepositoryForTests(undefined)
    setRuleRepositoryForTests(undefined)
    vi.unstubAllEnvs()
  })

  it('rejects an overlong pack_id before HTTP or MCP repository access', async () => {
    const workspaceId = 'ws_rules_audit_pack_parity'
    const queried: string[] = []
    const repository: RuleRepositoryPort = {
      list: async () => [],
      insertVersion: async () => { throw new Error('not used') },
      insertVersionWithAudit: async () => { throw new Error('not used') },
      appendAudit: async () => { throw new Error('not used') },
      updateStatus: async () => { throw new Error('not used') },
      listAudit: async () => { queried.push('repository'); return [] },
    }
    setRuleRepositoryForTests(repository)
    const base = await start()
    const packId = 'x'.repeat(257)
    const httpResponse = await fetch(`${base}/v1/rules/audit?pack_id=${packId}`, { headers: headers(workspaceId) })
    const http = await httpResponse.json() as Envelope
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers(workspaceId), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'rules-audit-pack-parity', method: 'ops.rules.workspace.audit', params: { pack_id: packId } }),
    })
    const mcp = await mcpResponse.json() as Envelope

    for (const result of [{ response: httpResponse, body: http }, { response: mcpResponse, body: mcp }]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(400)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }
    expect(queried).toEqual([])
  })
})
