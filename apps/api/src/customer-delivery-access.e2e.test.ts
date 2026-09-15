import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryCustomerDeliveryRepository, type CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'

type Envelope = { data: { result?: unknown; [key: string]: unknown } | null; error: { code: string; message?: string } | null }
const tokens = { a: 'delivery-access-merchant-a', b: 'delivery-access-merchant-b', ops: 'delivery-access-platform' }
const actors = { a: 'delivery-access-external-a', b: 'delivery-access-external-b', ops: 'delivery-access-external-ops' }
let api: typeof import('./server.js')
let base = ''
let workspaceId = ''
let delivery: CustomerDelivery
let identities: { a: string; b: string }
const states = new Map<string, CustomerDelivery | Error | null>()
const projection = vi.spyOn(MemoryCustomerDeliveryRepository.prototype, 'getByIdentity')

async function rpc(method: string, params: Record<string, unknown> = {}, caller: keyof typeof tokens = 'a', headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[caller]}`, ...(caller !== 'ops' ? { 'x-workspace-id': workspaceId } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { ...(caller === 'ops' ? { target_workspace_id: workspaceId } : {}), ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}
async function products(caller: 'a' | 'b' = 'a', headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/v1/products`, { headers: { authorization: `Bearer ${tokens[caller]}`, 'x-workspace-id': workspaceId, ...headers } })
  return { status: response.status, body: await response.json() as Envelope }
}
function success(response: { status: number; body: Envelope }) {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  return response.body.data?.result
}
function commercialStillRequired(response: { status: number; body: Envelope }) {
  expect(response.status, JSON.stringify(response.body)).toBe(503)
  expect(response.body.error?.code).toBe('CREATIVE_POINTS_UNAVAILABLE')
}
function bound(caller: 'a' | 'b', ready = false): CustomerDelivery {
  return { ...delivery, targetAccountId: `account-${caller}`, targetIdentityId: identities[caller], targetAccountLogin: `merchant-${caller}@example.test`, effectiveAt: ready ? '2026-09-15T00:00:00.000Z' : null }
}

// Real strict registered-token authentication, identity observation, membership,
// HTTP transport and authorization. Only the repository's trusted access
// projection is controlled; these are NOT PostgreSQL/evidence/runtime proofs.
describe('account delivery access on strict loopback MCP and HTTP', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST']) if (process.env[key]) throw new Error(`Run safe-tests: inherited ${key} is forbidden`)
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_ENFORCEMENT', 'strict'); vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'delivery-access-session-hash-secret')
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => { api.server.once('error', reject); api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() }) })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('Delivery access test listener did not bind')
    base = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    workspaceId = `ws_delivery_access_${randomUUID()}`
    states.clear(); projection.mockReset()
    projection.mockImplementation(async (_workspace, identity) => {
      const state = states.get(identity)
      if (state instanceof Error) throw state
      return state ?? null
    })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [tokens.a]: { actor_id: actors.a, roles: ['workspace_owner'], workbenches: ['workspace'], workspaces: [workspaceId] },
      [tokens.b]: { actor_id: actors.b, roles: ['workspace_owner'], workbenches: ['workspace'], workspaces: [workspaceId] },
      [tokens.ops]: { actor_id: actors.ops, roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
    }))
    for (const caller of ['a', 'b'] as const) await api.workspaceMembers.upsert({ workspaceId, externalSubject: actors[caller], displayName: `isolated merchant ${caller}`, role: 'workspace_owner', status: 'active', invitedBy: 'delivery-access-test' })
    delivery = success(await rpc('ops.customer-delivery.create', { company_name: '隔离交付门禁测试企业' }, 'ops')) as CustomerDelivery
    identities = { a: '', b: '' }
    for (const caller of ['a', 'b'] as const) {
      // No paid entitlement or points are fabricated for this test. Getting
      // past delivery must retain the original commercial rejection.
      commercialStillRequired(await rpc('catalog.search', { scope: 'workspace' }, caller))
      const call = projection.mock.calls.at(-1)
      expect(call?.[0]).toBe(workspaceId)
      expect(call?.[1]).toBeTruthy()
      // Learn the identity from the authenticated server projection, never
      // derive it from a supplied actor/account/workspace field.
      identities[caller] = call![1]
      expect(identities[caller]).not.toBe(actors[caller])
    }
    expect(identities.a).not.toBe(identities.b)
    // The pre-existing HTTP catalog read is not the same commercial operation
    // as MCP catalog.search. Preserve its actual baseline without changing it.
    success(await products('b'))
    projection.mockClear()
  })
  afterAll(async () => {
    try { if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve())) }
    finally { projection.mockRestore(); vi.unstubAllEnvs() }
  })

  it('denies only the pending account, not another merchant in the same workspace', async () => {
    states.set(identities.a, bound('a'))
    const rejected = await rpc('catalog.search', { scope: 'workspace' })
    expect(rejected.status).toBe(403); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
    commercialStillRequired(await rpc('catalog.search', { scope: 'workspace' }, 'b'))
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a], [workspaceId, identities.b]])
  })
  it('preserves self-session discovery for pending members and platform operators without a workspace', async () => {
    states.set(identities.a, bound('a'))
    const member = await rpc('ops.session')
    expect(member.body.error?.code).not.toBe('CUSTOMER_DELIVERY_REQUIRED')
    expect(member.body.error?.code).not.toBe('CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE')
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.ops}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'platform-session-without-workspace', method: 'ops.session', params: {} }) })
    expect(response.status).toBe(200)
    expect(projection).not.toHaveBeenCalled()
  })
  it('denies before either test-only commercial grant path can mint points', async () => {
    states.set(identities.a, bound('a'))
    api.enableCommercialFixtureHarnessForTests()
    const grant = vi.spyOn(api.creativePointsForTests, 'grant')
    try {
      const response = await rpc('catalog.search', { scope: 'workspace' }, 'a', { 'x-test-commercial-fixture': 'server-e2e' })
      expect(response.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
      expect(grant).not.toHaveBeenCalled()
    } finally { grant.mockRestore() }
  })
  it('does not recover or requeue durable automation claims during pre-admission hydration', async () => {
    states.set(identities.a, bound('a'))
    const persistence = await api.persistenceReady
    const originalBusiness = persistence.business
    const originalSave = persistence.persistSnapshotAndEvent
    const save = vi.fn<NonNullable<typeof persistence.persistSnapshotAndEvent>>().mockRejectedValue(new Error('UNEXPECTED_AUTOMATION_WRITE'))
    persistence.persistSnapshotAndEvent = save
    const policy = { workspaceId, id: `policy-${randomUUID()}`, enabled: true, syncEnabled: true, mode: 'scan_sync_alert_manual_retry', frequencyMinutes: 60, retryLimit: 1, claimedAt: '2026-09-14T00:00:00Z', nextRunAt: '2026-09-16T00:00:00Z', revision: 4, updatedAt: '2026-09-14T00:00:00Z' }
    const loadWorkspace = vi.fn().mockResolvedValue([{ workspaceId, entityType: 'automation_policy', entityId: policy.id, entityVersion: 4, payload: policy }])
    persistence.business = { loadWorkspace } as unknown as NonNullable<typeof persistence.business>
    try {
      // Asset reads deliberately force a fresh durable hydration even when the
      // one-second workspace cache was populated by the baseline requests.
      const response = await rpc('asset.list')
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
      expect(loadWorkspace).toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(policy).toMatchObject({ claimedAt: '2026-09-14T00:00:00Z', revision: 4 })
    } finally { persistence.business = originalBusiness; persistence.persistSnapshotAndEvent = originalSave }
  })
  it('enforces the same single-account rule on HTTP product reads', async () => {
    states.set(identities.a, bound('a'))
    const rejected = await products()
    expect(rejected.status).toBe(403); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
    success(await products('b'))
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a], [workspaceId, identities.b]])
  })
  it('passes ready delivery while preserving each entry path and the MCP commercial restriction', async () => {
    states.set(identities.a, bound('a', true))
    commercialStillRequired(await rpc('catalog.search', { scope: 'workspace' })); success(await products())
    expect(projection.mock.calls.every(([scope, identity]) => scope === workspaceId && identity === identities.a)).toBe(true)
  })
  it('rechecks live delivery evidence after ready is withdrawn without restarting the session', async () => {
    states.set(identities.a, bound('a', true))
    success(await products())
    states.set(identities.a, bound('a'))
    const rejected = await products()
    expect(rejected.status).toBe(403); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a], [workspaceId, identities.a]])
  })
  it.each(['MCP', 'HTTP'] as const)('fails closed with 503 when the delivery repository fails on %s', async surface => {
    states.set(identities.a, new Error('controlled repository outage'))
    const rejected = surface === 'MCP' ? await rpc('catalog.search', { scope: 'workspace' }) : await products()
    expect(rejected.status).toBe(503); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE')
    expect(JSON.stringify(rejected.body)).not.toContain('controlled repository outage')
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a]])
  })
  it.each(['identity', 'workspace'] as const)('rejects a corrupt %s projection without cross-account fallback', async mismatch => {
    states.set(identities.a, { ...bound('a', true), ...(mismatch === 'identity' ? { targetIdentityId: identities.b } : { workspaceId: 'ws_other' }) })
    const rejected = await rpc('catalog.search', { scope: 'workspace' })
    expect(rejected.status).toBe(503); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE')
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a]])
  })
  it('keeps the authenticated identity when callers spoof identity/account parameters or headers', async () => {
    states.set(identities.a, bound('a'))
    const headers = { 'x-identity-id': identities.b, 'x-account-id': 'account-b' }
    const rejected = await rpc('catalog.search', { scope: 'workspace' }, 'a', headers)
    expect(rejected.status).toBe(403); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
    const actor = await rpc('catalog.search', { scope: 'workspace' }, 'a', { 'x-actor-id': actors.b })
    expect(actor.status).toBe(403)
    for (const extra of [{ identity_id: identities.b }, { target_identity_id: identities.b }, { actor_id: actors.b }]) {
      const malformed = await rpc('catalog.search', { scope: 'workspace', ...extra })
      expect(malformed.status).toBeGreaterThanOrEqual(400)
    }
    expect(projection.mock.calls.every(([, identity]) => identity === identities.a)).toBe(true)
    const otherScope = await products('a', { 'x-workspace-id': 'ws_other' })
    expect(otherScope.status).toBe(403)
  })
  it('returns a reduced recovery projection for merchant.start without an intent', async () => {
    states.set(identities.a, bound('a'))
    const value = success(await rpc('merchant.start')) as Record<string, unknown>
    expect(value).toMatchObject({ status: 'delivery_pending', delivery_access: { allowed: false, state: 'pending' }, business_access: { allowed: false, blocked_by: ['customer_delivery'] } })
    expect(value).not.toHaveProperty('intent'); expect(value).not.toHaveProperty('products'); expect(value).not.toHaveProperty('tasks')
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a]])
  })
  it.each([{ requested_goal: '为商品生成说明' }, { requested_platform: 'douyin' }, { attachment_count: '0' }])('blocks intent-bearing merchant.start before effects: %j', async params => {
    states.set(identities.a, bound('a'))
    const rejected = await rpc('merchant.start', params)
    expect(rejected.status).toBe(403); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
    expect(projection.mock.calls).toEqual([[workspaceId, identities.a]])
  })
  it('blocks real first-value data while preserving the static example recovery route', async () => {
    states.set(identities.a, bound('a'))
    const rejected = await rpc('merchant.first_value', { platform: 'douyin', account_id: 'not-read', product_id: 'not-read' })
    expect(rejected.status).toBe(403); expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_REQUIRED')
    projection.mockClear()
    success(await rpc('merchant.first_value', { example: 'true' }))
    expect(projection).not.toHaveBeenCalled()
  })
  it('does not subject exact platform delivery list and binding handlers to the merchant gate', async () => {
    projection.mockRejectedValue(new Error('would block merchant access'))
    const listed = success(await rpc('ops.customer-delivery.list', {}, 'ops')) as { items: CustomerDelivery[] }
    expect(listed.items.map(item => item.id)).toContain(delivery.id)
    // An invalid target is deliberately NOT a successful binding. Its domain
    // rejection proves the authorized ops handler ran, without a gate bypass
    // or fabricated merchant directory/evidence in this transport-only suite.
    const missingTarget = await rpc('ops.customer-delivery.account.bind', { delivery_id: delivery.id, target_account_id: randomUUID(), expected_revision: String(delivery.revision), reason: '核验不存在账号的隔离错误路径' }, 'ops')
    expect(missingTarget.status).toBeGreaterThanOrEqual(400)
    expect(missingTarget.body.error?.code).toBe('CUSTOMER_DELIVERY_ACCOUNT_NOT_BINDABLE')
    expect(projection).not.toHaveBeenCalled()
  })
})
