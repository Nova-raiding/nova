import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'
import { server, setAuthorizationRepositoryForTests, setRuleRepositoryForTests, workspaceMembers, type RuleRepositoryPort } from './server.js'

type Envelope = {
  data: unknown
  error: { code: string; message?: string } | null
}

class EmptyRuleRepository implements RuleRepositoryPort {
  async list(_workspaceId: string, _packId?: string) { return [] }
  async insertVersion(_input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<PersistedRuleVersion> { throw new Error('write not expected') }
  async appendAudit(_input: PersistedRuleAudit): Promise<PersistedRuleAudit> { throw new Error('write not expected') }
  async listAudit(_workspaceId: string, _packId?: string) { return [] }
  async updateStatus(_input: { workspaceId: string; id: string; status: string; revision: number; updatedAt?: string; activatedAt?: string | null; deactivatedAt?: string | null }): Promise<PersistedRuleVersion> { throw new Error('write not expected') }
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

async function body(response: Response) {
  return { status: response.status, body: await response.json() as Envelope }
}

const workspaceId = 'ws_rule_read_no_commercial_facts'
const token = 'rule-read-no-commercial-facts-token'

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'rule-read-commercial-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    [token]: { actor_id: 'rule-read-merchant', roles: ['merchant_admin'], workbenches: ['workspace'], workspaces: [workspaceId] },
  }))
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
  setRuleRepositoryForTests(new EmptyRuleRepository())
  await workspaceMembers.upsert({ workspaceId, externalSubject: 'rule-read-merchant', displayName: 'rule read merchant', role: 'merchant_admin', status: 'active', invitedBy: 'rule-read-commercial-parity-test' })
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  setRuleRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('rule read commercial parity', () => {
  it('keeps authenticated HTTP and MCP rule reads available without commercial facts', async () => {
    const base = await start()
    const headers = { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId }

    const [http, mcp] = await Promise.all([
      fetch(`${base}/v1/rules`, { headers }).then(body),
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'rule-read-parity', method: 'rule.list', params: {} }),
      }).then(body),
    ])

    expect(http.status, JSON.stringify(http.body)).toBe(200)
    expect(http.body).toMatchObject({ data: [], error: null })
    expect(mcp.status, JSON.stringify(mcp.body)).toBe(200)
    expect(mcp.body).toMatchObject({ data: { result: [] }, error: null })
  })

  it('does not weaken authentication, tenant scope, or rule writes', async () => {
    const base = await start()

    const unauthenticated = await fetch(`${base}/v1/rules`, { headers: { 'x-workspace-id': workspaceId } }).then(body)
    expect(unauthenticated.status).toBe(401)

    const crossWorkspace = await fetch(`${base}/v1/rules`, {
      headers: { authorization: `Bearer ${token}`, 'x-workspace-id': 'ws_rule_read_other' },
    }).then(body)
    expect(crossWorkspace.status).toBe(403)

    const write = await fetch(`${base}/v1/rules/catalog/versions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'unauthorized write', version: '1', scope: 'global', status: 'draft', source_kind: 'internal',
        source_reference: 'internal://unauthorized', source_checked_at: '2026-09-22T00:00:00.000Z', checks: {}, reason: 'must stay denied',
      }),
    }).then(body)
    expect(write.status).toBe(403)
    expect(write.body.error?.code).toBe('FORBIDDEN')
  })
})
