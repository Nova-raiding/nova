/**
 * Manual operations mode: the paid-customer deadlock and its fix.
 *
 * `PLATFORM_OPERATIONS_MODE=manual` is the documented production mode while no
 * platform OAuth is wired. Before this capability existed a paid merchant in
 * that mode could not use a single platform-side method:
 *
 *   1. `requireStoreOnboarding` required an account with `tokenState ===
 *      'connected'`;
 *   2. the only writer of `platform_accounts` with that state is
 *      `service.registerPlatformAccount`, reached from `ensureFixtureAccount`
 *      (fixture only), `platform.connect` (fixture only, and hidden from the
 *      merchant plugin) and the official OAuth callback (not wired in manual
 *      mode);
 *   3. `workspaceOnboarding` measured "bound store" a different way
 *      (`dataMode === 'account_record_only'`), so the merchant was told to ask
 *      operations for a store record that no code path could create.
 *
 * The tests below pin the reproduction (the deadlock is real and the ops surface
 * had no way out of it), the fix (operations can register a credential-free
 * record and the two surfaces then agree), the official-mode non-regression, and
 * the security property that a merchant can never create one for itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_METHODS } from '../../../packages/contracts/src/mcp.js'
import { MCP_OPS_CONTROL_METHODS } from '../../../packages/contracts/src/commercial-operation-registry.js'
import { MCP_METHOD_SCHEMAS } from '../../../packages/contracts/src/mcp.js'
import { MANUAL_STORE_RECORD_TOKEN_STATE, isManualStoreRecord } from '../../../packages/application/src/service.js'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, operationAudits, platformAuthorizationAuditForTests, server, service, workspaceMembers, workspaceStoreDirectory } from './server.js'

type Envelope<T = Record<string, any>> = { workspace_id: string; data: T | null; error: { code: string; details?: Record<string, unknown> } | null }

const MANUAL_RECORD_METHOD = 'ops.platform.store.record.create'

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

/**
 * `platform_ops` is the canonical platform-workbench operator role; the other
 * entries are merchant roles used for the negative cases.
 */
async function configureMembers(entries: Array<{ token: string; workspaceId: string; role: 'workspace_owner' | 'merchant_admin' | 'operator' | 'platform_ops'; grantWorkspaces?: string[] }>) {
  const grants: Record<string, { workspaces: string[]; actor_id: string; roles?: string[]; workbenches: Array<'platform' | 'workspace'> }> = {}
  for (const entry of entries) {
    // A platform workbench principal authorizes through its *gateway* role
    // (`platform_ops`), which is what `requireOperationsRole` canonicalizes and
    // what grants the `platform:['*']` authorization scope. The same string is
    // also a workspace membership role that carries no canonical form, which is
    // exactly the confusion `requireOperationsRole` guards against; both are set
    // here so the positive case exercises the real operator path.
    grants[entry.token] = {
      workspaces: entry.grantWorkspaces ?? [entry.workspaceId],
      actor_id: `${entry.token}-actor`,
      ...(entry.role === 'platform_ops' ? { roles: ['platform_ops'] } : {}),
      workbenches: entry.role === 'platform_ops' ? ['platform'] : ['workspace'],
    }
    await workspaceMembers.upsert({ workspaceId: entry.workspaceId, externalSubject: `${entry.token}-actor`, displayName: entry.token, role: entry.role, status: 'active', invitedBy: 'manual-store-record-test' })
  }
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
}

function mcpAt(base: string, headers: Record<string, string>, method: string, params: Record<string, unknown>) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(async response => ({ status: response.status, body: await response.json() as Envelope<{ result: any }> }))
}

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('manual operations store records', () => {
  it('reproduces the manual-mode deadlock: no bound store, and no operations method that could create one', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = 'ws_manual_deadlock'
    await configureMembers([{ token: 'deadlock-owner', workspaceId, role: 'workspace_owner' }])
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer deadlock-owner', 'x-workspace-id': workspaceId }

    // The deadlock itself. This stays true before and after the fix (the
    // workspace genuinely has no store) and is the control that proves the
    // positive cases below are not passing for an unrelated reason.
    const gated = await mcpAt(base, ownerHeaders, 'task.create', { product_id: 'prod_manual_missing', platform: 'taobao' })
    expect(gated.body.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    expect(gated.status).toBe(428)

    // There is no OAuth path in this mode, and the only method that writes a
    // usable platform account is the manual-store-record method under test.
    // Every other `ops.*` method that touches the store boundary is read-only,
    // so before this method existed the operator had nothing to call either.
    const storeWritingOpsMethods = MCP_OPS_CONTROL_METHODS.filter(method => /\.store\.record\.create$|\.account\.create$|\.platform\.connect$/.test(method))
    expect(storeWritingOpsMethods).toEqual([MANUAL_RECORD_METHOD])

    // The merchant cannot even guess it: the method is absent from the merchant
    // contract surface the plugin builds `tools/list` from, because the bridge
    // and the native MCP surface both drop every `ops.` method.
    const listed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    }).then(response => response.json() as Promise<{ result?: { tools?: Array<{ name: string }> } }>)
    const merchantVisibleNames = (listed.result?.tools ?? []).map(tool => tool.name)
    expect(merchantVisibleNames).not.toContain(MANUAL_RECORD_METHOD)
    expect(merchantVisibleNames.some(name => name.startsWith('ops.'))).toBe(false)
    // And calling it is an unknown tool for the merchant surface, not a
    // permission error: the merchant plugin never forwards it.
    const merchantCall = await mcpAt(base, ownerHeaders, MANUAL_RECORD_METHOD, { workspace_id: workspaceId, platform: 'taobao', account_id: 'store_manual_1', reason: '商家自行登记店铺' })
    expect(merchantCall.body.error).not.toBeNull()
  })

  it('lets operations register a credential-free store record that unblocks the merchant', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = 'ws_manual_unblocked'
    const platform = 'taobao'
    const storeKey = `store_manual_${Date.now()}`
    await configureMembers([
      { token: 'unblock-owner', workspaceId, role: 'workspace_owner' },
      { token: 'unblock-ops', workspaceId, role: 'platform_ops' },
    ])
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer unblock-owner', 'x-workspace-id': workspaceId }
    const opsHeaders = { authorization: 'Bearer unblock-ops', 'x-workspace-id': workspaceId, 'x-actor-id': 'unblock-ops-actor' }

    const registered = await mcpAt(base, opsHeaders, MANUAL_RECORD_METHOD, {
      workspace_id: workspaceId,
      platform,
      account_id: storeKey,
      store_alias: '人工登记店铺',
      reason: '商家确认了目标店铺编号，运营登记人工店铺记录',
    })
    expect(registered.status).toBe(200)
    expect(registered.body.error, JSON.stringify(registered.body.error)).toBeNull()
    const accountId = registered.body.data!.result.selectionKey.accountId as string
    expect(accountId).toBe(storeKey)

    // The record says exactly what it is: registered by operations, no
    // credential, no authorization receipt. It must never claim `connected`.
    expect(registered.body.data!.result.connection).toMatchObject({ mode: 'manual_store_record', token_state: MANUAL_STORE_RECORD_TOKEN_STATE, credential_free: true, authorization_receipt: null })
    expect(registered.body.data!.result.applies_to_store_boundary).toBe(true)
    const stored = service.getPlatformAccount(workspaceId, accountId, platform)
    expect(stored.tokenState).toBe(MANUAL_STORE_RECORD_TOKEN_STATE)
    expect(isManualStoreRecord(stored)).toBe(true)
    expect(stored.credentialRef).toMatch(/^manual-store-record:no-credential:/u)
    expect(stored.credentialRef.startsWith('vault://')).toBe(false)
    expect(stored.lastAuthorizedAt).toBeUndefined()
    expect(stored.grantedScopes).toBeUndefined()
    expect(stored.accessTokenExpiresAt).toBeUndefined()
    expect(stored.credentialRefreshable).toBeUndefined()
    expect(stored.authRevision).toBeUndefined()

    // Persistence actually happened, so `listPlatformAccounts` returns it.
    expect(service.listPlatformAccounts(workspaceId).map(account => account.id)).toContain(accountId)

    // A durable round trip must not invent an authorization generation. The
    // hydration path fills `authRevision` from `revision` for legacy OAuth rows
    // that predate the field; doing that to a credential-free record would make
    // it look like a grant a publish job could pin itself to.
    service.hydrateSnapshot({ entityType: 'platform_account', entity: { ...stored } })
    const hydrated = service.getPlatformAccount(workspaceId, accountId, platform)
    expect(hydrated.tokenState).toBe(MANUAL_STORE_RECORD_TOKEN_STATE)
    expect(hydrated.authRevision).toBeUndefined()
    expect(hydrated.credentialRef).toMatch(/^manual-store-record:no-credential:/u)

    // The store boundary is gone for this workspace.
    const task = await mcpAt(base, ownerHeaders, 'task.create', { product_id: 'prod_manual_missing', platform })
    expect(task.body.error?.code).not.toBe('STORE_ONBOARDING_REQUIRED')
    expect(task.status).not.toBe(428)

    // Both surfaces must reach the same conclusion about this store: this is
    // the assertion that pins the single source of truth. Before the fix
    // `requireStoreOnboarding` compared `tokenState` while `workspaceOnboarding`
    // compared `dataMode`.
    const directory = workspaceStoreDirectory(workspaceId)
    const directoryEntry = directory.find(store => store.accountId === accountId)
    expect(directoryEntry?.state).toBe(MANUAL_STORE_RECORD_TOKEN_STATE)
    const health = await mcpAt(base, ownerHeaders, 'workspace.health', {})
    const onboarding = health.body.data!.result.onboarding_v2 as { current_step: { id: string }; steps: Array<{ id: string; state: string; summary: string }> }
    const bindStore = onboarding.steps.find(step => step.id === 'connect_store')
    expect(bindStore?.state, JSON.stringify(bindStore)).toBe('complete')
    expect(bindStore?.summary).toContain('人工运营')
    expect(service.listPlatformAccounts(workspaceId).some(account => account.tokenState === MANUAL_STORE_RECORD_TOKEN_STATE)).toBe(true)

    // Audited twice, on purpose: the authorization decision (allow_and_deny
    // policy) lands in `platform_authorization_audit`, and the operator's stated
    // reason lands in the workspace operation audit that `ops.audit.*` reads.
    const decisions = await platformAuthorizationAuditForTests.list({ method: MANUAL_RECORD_METHOD })
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions[0]).toMatchObject({ method: MANUAL_RECORD_METHOD, workbench: 'platform', capability: 'store.connection.update' })
    const audit = await operationAudits.find(workspaceId, 'platform.store.record.create', 'platform_account', accountId)
    expect(audit).toMatchObject({ reason: '商家确认了目标店铺编号，运营登记人工店铺记录' })
  })

  it('lets a paid manual-mode customer import a product and create a task against the registered store', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = 'ws_manual_customer_flow'
    const platform = 'taobao'
    const storeKey = `store_manual_flow_${Date.now()}`
    await configureMembers([
      { token: 'flow-owner', workspaceId, role: 'workspace_owner' },
      { token: 'flow-ops', workspaceId, role: 'platform_ops' },
    ])
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer flow-owner', 'x-workspace-id': workspaceId }
    const opsHeaders = { authorization: 'Bearer flow-ops', 'x-workspace-id': workspaceId }
    expect((await mcpAt(base, opsHeaders, MANUAL_RECORD_METHOD, { workspace_id: workspaceId, platform, account_id: storeKey, reason: '为该商家建立人工店铺范围以便导入商品' })).body.error).toBeNull()

    // The documented first step of the manual flow (`docs/manual-six-platform-
    // operations.md` §4: `account_id` is required, "没有时先由运营建立人工店铺
    // 记录"). It has to pass BOTH the store boundary and the "is this account
    // actionable" gate that used to answer PLATFORM_ACCOUNT_REAUTH_REQUIRED.
    const imported = await mcpAt(base, ownerHeaders, 'catalog.import', { platform, account_id: storeKey, title: `人工运营商品 ${storeKey}`, price: '99', stock: '5' })
    expect(imported.body.error, JSON.stringify(imported.body.error)).toBeNull()
    const product = imported.body.data!.result as { id: string; accountId?: string }
    expect(product.accountId).toBe(storeKey)

    // And the next platform-side step, which is what the deadlock made
    // unreachable. `task.create` is derived from the imported product, so the
    // store scope the operator registered carries through.
    const task = await mcpAt(base, ownerHeaders, 'task.create', { product_id: product.id, platform, account_id: storeKey })
    expect(task.body.error?.code, JSON.stringify(task.body.error)).not.toBe('STORE_ONBOARDING_REQUIRED')
    expect(task.body.error?.code, JSON.stringify(task.body.error)).not.toBe('PLATFORM_ACCOUNT_REAUTH_REQUIRED')
    expect(task.body.error, JSON.stringify(task.body.error)).toBeNull()
    expect(task.body.data!.result).toMatchObject({ platform, accountId: storeKey })
  })

  it('keeps the credential-issuing and remote-revoke paths closed to a credential-free record', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = 'ws_manual_credential_boundary'
    const platform = 'taobao'
    const storeKey = `store_manual_credential_${Date.now()}`
    await configureMembers([
      { token: 'credential-owner', workspaceId, role: 'workspace_owner' },
      { token: 'credential-ops', workspaceId, role: 'platform_ops' },
    ])
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer credential-owner', 'x-workspace-id': workspaceId }
    const opsHeaders = { authorization: 'Bearer credential-ops', 'x-workspace-id': workspaceId }
    expect((await mcpAt(base, opsHeaders, MANUAL_RECORD_METHOD, { workspace_id: workspaceId, platform, account_id: storeKey, reason: '登记人工店铺记录以核对凭据边界' })).body.error).toBeNull()

    // The two worker execution-context endpoints and the worker-side publish
    // gate still call the strict `getActivePlatformAccount`. That is what keeps
    // the placeholder ref inside the API: nothing can hand it to a worker.
    expect(() => service.getActivePlatformAccount(workspaceId, storeKey, platform)).toThrowError(expect.objectContaining({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED' }))
    expect(service.getActionablePlatformAccount(workspaceId, storeKey, platform).credentialRef).toMatch(/^manual-store-record:no-credential:/u)

    // Revoking a manual record must not call a connector with a value that is
    // not a credential, and must not report a remote revocation that never
    // happened.
    const revoked = await mcpAt(base, ownerHeaders, 'platform.revoke', { platform, account_id: storeKey })
    expect(revoked.body.error).toBeNull()
    expect(revoked.body.data!.result).toMatchObject({ remoteRevoked: false, remoteRevocation: 'not_applicable_manual_store_record', state: 'revoked' })
  })

  it('does not relax the store boundary outside manual mode', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'official_api')
    const workspaceId = 'ws_official_api_store_record'
    const platform = 'taobao'
    const storeKey = `store_official_${Date.now()}`
    await configureMembers([
      { token: 'official-owner', workspaceId, role: 'workspace_owner' },
      { token: 'official-ops', workspaceId, role: 'platform_ops' },
    ])
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer official-owner', 'x-workspace-id': workspaceId }
    const opsHeaders = { authorization: 'Bearer official-ops', 'x-workspace-id': workspaceId }

    // Register the record through the same service writer the ops method uses,
    // proving the assertion is about the gate and not about the writer.
    service.registerManualPlatformAccount({ workspaceId, platform, remoteAccountId: storeKey })
    expect(service.getPlatformAccount(workspaceId, storeKey, platform).tokenState).toBe(MANUAL_STORE_RECORD_TOKEN_STATE)
    expect(await mcpAt(base, opsHeaders, MANUAL_RECORD_METHOD, { workspace_id: workspaceId, platform, account_id: `${storeKey}_2`, reason: '官方接口档不应放宽店铺门禁' })).toBeDefined()

    const gated = await mcpAt(base, ownerHeaders, 'task.create', { product_id: 'prod_official_missing', platform })
    expect(gated.body.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    expect(gated.status).toBe(428)

    // The onboarding view must agree: an official-API deployment does not treat
    // the credential-free record as a bound store either.
    const health = await mcpAt(base, ownerHeaders, 'workspace.health', {})
    const onboarding = health.body.data!.result.onboarding_v2 as { steps: Array<{ id: string; state: string }> }
    expect(onboarding.steps.find(step => step.id === 'connect_store')?.state).toBe('required')
  })

  it('refuses the merchant, and refuses it for who it is rather than for a missing field', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    const workspaceId = 'ws_manual_merchant_denied'
    await configureMembers([
      { token: 'denied-owner', workspaceId, role: 'workspace_owner' },
      { token: 'denied-merchant-admin', workspaceId, role: 'merchant_admin' },
      { token: 'denied-operator', workspaceId, role: 'operator' },
    ])
    const base = await start()
    // Fully-formed, schema-valid payload: the refusal must not depend on a
    // missing or malformed parameter.
    const request = { workspace_id: workspaceId, platform: 'taobao', account_id: `store_self_${Date.now()}`, reason: '商家尝试自行登记店铺范围' }
    for (const token of ['denied-owner', 'denied-merchant-admin', 'denied-operator']) {
      const attempt = await mcpAt(base, { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId }, MANUAL_RECORD_METHOD, request)
      expect(attempt.status, `${token} must be refused`).toBe(403)
      expect(attempt.body.error?.code).toBe('FORBIDDEN')
      expect(attempt.body.error?.details?.reason_code).toBe('AUTHZ_WORKBENCH_MISMATCH')
      expect(attempt.body.data).toBeNull()
    }
    // Nothing was written: no merchant path turned itself into a bound store.
    expect(service.listPlatformAccounts(workspaceId).some(account => account.tokenState === MANUAL_STORE_RECORD_TOKEN_STATE)).toBe(false)
    const gated = await mcpAt(base, { authorization: 'Bearer denied-owner', 'x-workspace-id': workspaceId }, 'task.create', { product_id: 'prod_self_register', platform: 'taobao' })
    expect(gated.body.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('declares the method once, on the operations surface only, with an audit reason obligation', () => {
    expect(MCP_METHODS.filter(method => method === MANUAL_RECORD_METHOD)).toHaveLength(1)
    expect(MCP_METHODS).not.toContain('platform.store.record.create')
    expect(MCP_OPS_CONTROL_METHODS).toContain(MANUAL_RECORD_METHOD)
    expect(MCP_METHOD_SCHEMAS[MANUAL_RECORD_METHOD].required).toEqual(['workspace_id', 'platform', 'account_id', 'reason'])
    expect(MCP_METHOD_SCHEMAS[MANUAL_RECORD_METHOD].additionalProperties).toBe(false)
  })
})
