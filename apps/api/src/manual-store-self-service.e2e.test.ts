import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, service, workspaceMembers, operationAudits } from './server.js'

type Envelope = {
  workspace_id?: string
  data: Record<string, any> | null
  error: { code: string; details?: Record<string, unknown> } | null
}

const route = (platform = 'taobao') => `/v1/platform-accounts/${platform}/manual-record`

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

async function configure(workspaceId: string, entries: Array<{ token: string; actor: string; role: 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' }>) {
  const grants: Record<string, { workspaces: string[]; actor_id: string; workbenches: ['workspace'] }> = {}
  for (const entry of entries) {
    grants[entry.token] = { workspaces: [workspaceId], actor_id: entry.actor, workbenches: ['workspace'] }
    await workspaceMembers.upsert({ workspaceId, externalSubject: entry.actor, displayName: entry.actor, role: entry.role, status: 'active', invitedBy: 'manual-store-self-service-test' })
  }
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
}

function request(base: string, token: string, workspaceId: string, value: Record<string, unknown>) {
  return fetch(`${base}${route()}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace', 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'manual-store-self-service-secret')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('merchant self-service manual store registration', () => {
  it('registers a credential-free record from the authenticated workspace and audits it; repeat conflicts', async () => {
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = `ws_self_store_${Date.now()}`
    const actor = `self-store-owner-${Date.now()}`
    await configure(workspaceId, [{ token: 'self-store-owner-token', actor, role: 'workspace_owner' }])
    const base = await start()
    const first = await request(base, 'self-store-owner-token', workspaceId, { account_id: 'merchant-store-1', store_name: '贵人鸟旗舰店' })

    expect(first.status).toBe(201)
    expect(first.body.error).toBeNull()
    expect(first.body.workspace_id).toBe(workspaceId)
    expect(first.body.data).toMatchObject({
      workspace_id: workspaceId,
      selectionKey: { platform: 'taobao', accountId: 'merchant-store-1' },
      connection: { mode: 'manual_store_record', token_state: 'manually_registered', credential_free: true, authorization_receipt: null },
      applies_to_store_boundary: true,
    })
    expect(JSON.stringify(first.body)).not.toContain('connected')
    const stored = service.getPlatformAccount(workspaceId, 'merchant-store-1', 'taobao')
    expect(stored.tokenState).toBe('manually_registered')
    expect(stored.credentialRef).toMatch(/^manual-store-record:no-credential:/u)
    expect(stored.storeAlias).toBe('贵人鸟旗舰店')
    expect(await operationAudits.find(workspaceId, 'platform.store.manual_record.create', 'platform_account', stored.id)).toMatchObject({ actorId: actor, reason: expect.any(String) })

    const repeat = await request(base, 'self-store-owner-token', workspaceId, { account_id: 'merchant-store-1', store_name: '贵人鸟旗舰店' })
    expect(repeat.status).toBe(409)
    expect(repeat.body.error?.code).toBe('MANUAL_STORE_RECORD_ALREADY_EXISTS')
  })

  it('rejects forged workspace and every unlisted or secret-bearing field without writing', async () => {
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = `ws_self_store_scope_${Date.now()}`
    const otherWorkspaceId = `${workspaceId}_other`
    const actor = `self-store-scope-owner-${Date.now()}`
    await configure(workspaceId, [{ token: 'self-store-scope-token', actor, role: 'merchant_admin' }])
    const base = await start()
    const forgedWorkspace = await request(base, 'self-store-scope-token', workspaceId, { account_id: 'forged-workspace-store', store_name: '伪造店铺', workspace_id: otherWorkspaceId })
    expect(forgedWorkspace.status).toBe(400)
    expect(forgedWorkspace.body.error?.code).toBe('MANUAL_STORE_RECORD_INPUT_INVALID')
    expect(() => service.getPlatformAccount(workspaceId, 'forged-workspace-store', 'taobao')).toThrowError(expect.objectContaining({ code: 'PLATFORM_ACCOUNT_NOT_FOUND' }))
    expect(() => service.getPlatformAccount(otherWorkspaceId, 'forged-workspace-store', 'taobao')).toThrowError(expect.objectContaining({ code: 'PLATFORM_ACCOUNT_NOT_FOUND' }))

    const withSecret = await request(base, 'self-store-scope-token', workspaceId, { account_id: 'secret-bearing-store', store_name: '不应写入', cookie: 'secret-cookie-value' })
    expect(withSecret.status).toBe(400)
    expect(withSecret.body.error?.code).toBe('MANUAL_STORE_RECORD_INPUT_INVALID')
    expect(JSON.stringify(withSecret.body)).not.toContain('secret-cookie-value')
    expect(() => service.getPlatformAccount(workspaceId, 'secret-bearing-store', 'taobao')).toThrowError(expect.objectContaining({ code: 'PLATFORM_ACCOUNT_NOT_FOUND' }))
  })

  it('denies support and operator roles because they lack store.connection.update', async () => {
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = `ws_self_store_denied_${Date.now()}`
    await configure(workspaceId, [
      { token: 'self-store-support-token', actor: 'self-store-support', role: 'support' },
      { token: 'self-store-operator-token', actor: 'self-store-operator', role: 'operator' },
    ])
    const base = await start()
    for (const [token, accountId] of [['self-store-support-token', 'support-store'], ['self-store-operator-token', 'operator-store']]) {
      const result = await request(base, token!, workspaceId, { account_id: accountId, store_name: '越权店铺' })
      expect(result.status).toBe(403)
      expect(result.body.error?.code).toBe('FORBIDDEN')
      expect(result.body.error?.details?.capability).toBe('store.connection.update')
      expect(() => service.getPlatformAccount(workspaceId, accountId!, 'taobao')).toThrowError(expect.objectContaining({ code: 'PLATFORM_ACCOUNT_NOT_FOUND' }))
    }
  })

  it('fails closed outside manual mode and never downgrades an existing OAuth account', async () => {
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'official_api')
    const workspaceId = `ws_self_store_official_${Date.now()}`
    const actor = `self-store-official-owner-${Date.now()}`
    await configure(workspaceId, [{ token: 'self-store-official-token', actor, role: 'workspace_owner' }])
    const base = await start()
    const disabled = await request(base, 'self-store-official-token', workspaceId, { account_id: 'manual-disabled-store', store_name: '不开启' })
    expect(disabled.status).toBe(409)
    expect(disabled.body.error?.code).toBe('MANUAL_STORE_RECORDS_DISABLED')
    expect(() => service.getPlatformAccount(workspaceId, 'manual-disabled-store', 'taobao')).toThrowError(expect.objectContaining({ code: 'PLATFORM_ACCOUNT_NOT_FOUND' }))

    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'oauth-store', credentialRef: 'vault://existing-oauth-secret', grantedScopes: ['read_items'] })
    const downgrade = await request(base, 'self-store-official-token', workspaceId, { account_id: 'oauth-store', store_name: '覆盖 OAuth' })
    expect(downgrade.status).toBe(409)
    expect(downgrade.body.error?.code).toBe('PLATFORM_ACCOUNT_ALREADY_EXISTS')
    expect(service.getPlatformAccount(workspaceId, 'oauth-store', 'taobao')).toMatchObject({ tokenState: 'connected', credentialRef: 'vault://existing-oauth-secret' })
  })
})
