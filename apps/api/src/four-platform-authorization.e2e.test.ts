import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let server: typeof import('./server.js').server

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

type JsonRpcResponse = {
  data?: { result?: Record<string, any> }
  error?: { code?: string; message?: string }
}

async function call(base: string, workspace: string, method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-id': workspace, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  })
  return response.json() as Promise<JsonRpcResponse>
}

function reviewedFixtureBody(product: { id: string; version?: number }, platform: string) {
  const factSourceId = `product:${product.id}:v${product.version ?? 1}`
  return {
    title: `${platform} 已确认商品`, detail: '根据已确认商品参数生成。', sellingPoints: ['商品参数已确认'],
    modules: [{
      key: 'product_facts', title: '商品事实', purpose: '回答商品参数问题', body: '商品参数已确认。', factSourceIds: [factSourceId], contentKind: 'fact',
      decisionContract: {
        buyerQuestion: '商品有哪些已确认参数？', pageTask: '展示已确认商品参数',
        claim: { text: '商品参数已确认。', factSourceIds: [factSourceId], platforms: [platform], limitations: ['仅适用于当前商品快照'] },
        evidence: { type: 'parameter', sourceIds: [factSourceId], status: 'verified' },
        visualContract: { requiredElements: ['商品'], protectedElements: ['商品外观'], prohibitedImplications: ['不得虚构效果'], accessibilityText: '商品图' },
        priority: 1, optional: false,
      },
    }],
  }
}

describe('four-platform fixture authorization lifecycle', () => {
  beforeAll(async () => {
    process.env.CONNECTOR_FIXTURE_MODE = 'true'
    process.env.DEPLOYMENT_PROFILE = 'local_acceptance'
    process.env.LOCAL_COMPOSE = 'true'
    process.env.ALLOW_LOCAL_ASSET_SCAN_FIXTURE = 'true'
    vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'false')
    server = (await import('./server.js')).server
  })

  beforeEach(() => {
    // Mapping governance has its own strict end-to-end suite. These fixture
    // scenarios isolate authorization, store scoping, entitlements, and the
    // six-platform content lifecycle from that independent production gate.
    vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'false')
  })

  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('authorizes, syncs, blocks after revoke, and recovers after reauthorization for every profile', async () => {
    const base = await start()
    const workspace = 'ws_four_platform_authorization_e2e'
    const platforms = ['jd', 'taobao', 'tmall', 'pinduoduo'] as const

    for (const platform of platforms) {
      const connected = await call(base, workspace, 'platform.connect', { platform })
      expect(connected.error == null).toBe(true)
      expect(connected.data?.result).toMatchObject({ mode: 'fixture', simulated: true })
      const account = connected.data?.result?.account
      expect(account).toMatchObject({ platform, tokenState: 'connected' })
      expect(JSON.stringify(connected.data?.result)).not.toContain('credentialRef')

      const synced = await call(base, workspace, 'catalog.sync.start', { platform, account_id: account.id, mode: 'full' })
      expect(synced.data?.result).toMatchObject({ state: 'succeeded', simulated: true, itemsUpserted: 1, itemsFailed: 0 })

      const revoked = await call(base, workspace, 'platform.revoke', { platform, account_id: account.id })
      expect(revoked.data?.result).toMatchObject({ platform, accountId: account.id, state: 'revoked', remoteRevoked: true })

      const revokedMetrics = await call(base, workspace, 'workspace.metrics', { platform, account_id: account.id })
      expect(revokedMetrics.data?.result?.stores).toEqual([expect.objectContaining({ connection: expect.objectContaining({ state: 'revoked', readable: false }) })])

      const blocked = await call(base, workspace, 'catalog.sync.start', { platform, account_id: account.id, mode: 'full' })
      expect(blocked.error).toMatchObject({ code: 'PLATFORM_ACCOUNT_REAUTH_REQUIRED' })

      const reconnected = await call(base, workspace, 'platform.connect', { platform })
      expect(reconnected.data?.result).toMatchObject({ mode: 'fixture', simulated: true })
      expect(reconnected.data?.result?.account).toMatchObject({ platform, tokenState: 'connected' })
    }
  })

  it('keeps two fixture stores on the same platform isolated', async () => {
    const base = await start()
    const workspace = 'ws_same_platform_multiple_stores_e2e'
    const north = await call(base, workspace, 'platform.connect', { platform: 'taobao', store_key: 'north' })
    const south = await call(base, workspace, 'platform.connect', { platform: 'taobao', store_key: 'south' })
    const northAccount = north.data?.result?.account
    const southAccount = south.data?.result?.account
    expect(northAccount?.id).toBeTruthy()
    expect(southAccount?.id).toBeTruthy()
    expect(northAccount?.id).not.toBe(southAccount?.id)
    const health = await call(base, workspace, 'workspace.health')
    const stores = health.data?.result?.storeDirectory?.filter((item: { platform: string }) => item.platform === 'taobao')
    expect(stores).toHaveLength(2)
    expect(new Set(stores.map((item: { accountId: string }) => item.accountId)).size).toBe(2)
    const northSync = await call(base, workspace, 'catalog.sync.start', { platform: 'taobao', account_id: northAccount.id, mode: 'full' })
    const southSync = await call(base, workspace, 'catalog.sync.start', { platform: 'taobao', account_id: southAccount.id, mode: 'full' })
    expect(northSync.data?.result?.products?.[0]).toMatchObject({ accountId: northAccount.id })
    expect(southSync.data?.result?.products?.[0]).toMatchObject({ accountId: southAccount.id })
    const scoped = await call(base, workspace, 'catalog.search', { platform: 'taobao', account_id: northAccount.id })
    expect(scoped.data?.result).toMatchObject({ scope: 'store', selection: { platform: 'taobao', accountId: northAccount.id }, products: expect.any(Array), product_actions: expect.arrayContaining([expect.objectContaining({ action: expect.objectContaining({ method: 'catalog.facts.confirm' }) })]) })
    expect(scoped.data?.result?.products).toHaveLength(1)
    expect(scoped.data?.result?.products?.[0]).toMatchObject({ accountId: northAccount.id })
    const aggregate = await call(base, workspace, 'catalog.search', { scope: 'workspace', platform: 'taobao' })
    expect(aggregate.data?.result).toMatchObject({ scope: 'workspace', selection: null, products: expect.any(Array) })
    expect(aggregate.data?.result?.products).toHaveLength(2)
  })

  it('keeps first-run read-only sync available before wallet recharge', async () => {
    const base = await start()
    const workspace = `ws_zero_balance_sync_${Date.now()}`
    const account = (await import('./server.js')).service.registerPlatformAccount({
      workspaceId: workspace,
      platform: 'taobao',
      remoteAccountId: `zero-balance-store-${workspace}`,
      credentialRef: `fixture-secret/taobao/${workspace}`,
    })

    try {
      vi.stubEnv('SESSION_ID_HASH_SECRET', 'four-platform-e2e-session-hash-secret')
      vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'zero-balance-token': { workspaces: [workspace], actor_id: 'zero-balance-user' } }))
      await (await import('./server.js')).workspaceMembers.upsert({ workspaceId: workspace, externalSubject: 'zero-balance-user', displayName: '零余额测试', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
      const auth = { authorization: 'Bearer zero-balance-token' }
      const statusBefore = await call(base, workspace, 'billing.status', {}, auth)
      expect(statusBefore.data?.result).toMatchObject({ balance_cny: '0.00' })

      const synced = await call(base, workspace, 'catalog.sync.start', { platform: 'taobao', account_id: account.id, mode: 'full' }, auth)
      expect(synced.error).toBeNull()
      expect(synced.data?.result).toMatchObject({ state: 'succeeded', simulated: true })

      const transactions = await call(base, workspace, 'billing.transactions', {}, auth)
      expect(transactions.data?.result?.transactions ?? []).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('covers the XHS and Douyin fixture authorization and sync lifecycle', async () => {
    const base = await start()
    const workspace = `ws_social_authorization_${Date.now()}`
    for (const platform of ['xiaohongshu', 'douyin'] as const) {
      const connected = await call(base, workspace, 'platform.connect', { platform })
      expect(connected.error).toBeNull()
      expect(connected.data?.result).toMatchObject({ mode: 'fixture', simulated: true, account: { platform, tokenState: 'connected' } })
      const accountId = connected.data?.result?.account?.id as string
      const synced = await call(base, workspace, 'catalog.sync.start', { platform, account_id: accountId, mode: 'full' })
      expect(synced.error).toBeNull()
      expect(synced.data?.result).toMatchObject({ state: 'succeeded', simulated: true })
      const revoked = await call(base, workspace, 'platform.revoke', { platform, account_id: accountId })
      expect(revoked.error).toBeNull()
      const reconnected = await call(base, workspace, 'platform.connect', { platform })
      expect(reconnected.error).toBeNull()
      expect(reconnected.data?.result?.account).toMatchObject({ platform, tokenState: 'connected' })
    }
  })

  it('settles platform and bulk-sync addon units on their real API actions', async () => {
    const base = await start()
    const workspace = 'ws_entitlement_action_e2e'
    const opsHeaders = { 'x-actor-id': 'operator_1' }
    const platformAddon = await call(base, workspace, 'ops.commercial.addon.upsert', { code: 'taobao_platform_pack', name: '平台连接包', kind: 'platform', price_cny: '19.00', units: '1', reason: '权益消费回归' }, opsHeaders)
    expect(platformAddon.error == null).toBe(true)
    const syncAddon = await call(base, workspace, 'ops.commercial.addon.upsert', { code: 'bulk_sync_pack', name: '同步包', kind: 'bulk_sync', price_cny: '29.00', units: '1', reason: '权益消费回归' }, opsHeaders)
    expect(syncAddon.error == null).toBe(true)
    const offer = await call(base, workspace, 'ops.commercial.offer.upsert', { code: 'entitlement_test', name: '权益测试套餐', billing_cycle: 'monthly', price_cny: '99.00', included_stores: '1', included_tasks: '10', reason: '权益消费回归' }, opsHeaders)
    expect(offer.error == null).toBe(true)
    const orderResponse = await call(base, workspace, 'subscription.order.create', { plan_code: 'entitlement_test', billing_cycle: 'monthly', channel: 'alipay', addon_codes_json: '["taobao_platform_pack","bulk_sync_pack"]', idempotency_key: 'entitlement-order-1' }, opsHeaders)
    expect(orderResponse.error == null).toBe(true)
    const order = orderResponse.data?.result
    const paid = await fetch(`${base}/v1/subscriptions/callback/alipay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspace, order_id: order?.orderNo, provider_trade_id: 'entitlement-trade-1', amount_fen: 14700, state: 'SUCCESS' }) })
    expect((await paid.json()).error == null).toBe(true)
    const connected = await call(base, workspace, 'platform.connect', { platform: 'taobao' })
    expect(connected.error == null).toBe(true)
    const accountId = connected.data?.result?.account?.id
    const synced = await call(base, workspace, 'catalog.sync.start', { platform: 'taobao', account_id: accountId, mode: 'full' })
    expect(synced.error == null).toBe(true)
    const reconciliation = await call(base, workspace, 'billing.reconciliation')
    expect(reconciliation.data?.result?.action_ledger?.by_kind_settlement_state).toEqual(expect.objectContaining({ 'platform_connect:entitlement:settled': 1, 'catalog_sync:entitlement:settled': 1 }))
    const subscription = await call(base, workspace, 'subscription.get')
    expect(subscription.data?.result?.entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ addonCode: 'taobao_platform_pack', usedUnits: 1, remainingUnits: 0 }),
      expect.objectContaining({ addonCode: 'bulk_sync_pack', usedUnits: 1, remainingUnits: 0 }),
    ]))
  })

  it('returns a selectable store context after a browser OAuth callback', async () => {
    const base = await start()
    const workspace = 'ws_browser_callback_store_context_e2e'
    const state = (await import('./server.js')).oauthStates.issue({ workspaceId: workspace, actorId: 'actor_demo', platform: 'taobao' })
    const response = await fetch(`${base}/v1/oauth/callback/taobao?state=${encodeURIComponent(state)}&code=fixture`)
    const body = await response.json() as { data?: { accountId?: string; store?: { platform: string; accountId: string }; nextActions?: string[] }; error?: unknown }
    expect(response.status).toBe(200)
    expect(body.error).toBeNull()
    expect(body.data).toMatchObject({
      platform: 'taobao',
      connected: true,
      tokenState: 'stored_in_vault',
      store: { platform: 'taobao' },
      nextActions: expect.arrayContaining(['refresh_workspace_health', 'select_store_by_platform_and_account_id']),
    })
    expect(body.data?.store?.accountId).toBe(body.data?.accountId)
  })

  it('returns a safe browser continuation page when OAuth requests HTML', async () => {
    const base = await start()
    const workspace = 'ws_browser_callback_html_e2e'
    const state = (await import('./server.js')).oauthStates.issue({ workspaceId: workspace, actorId: 'actor_demo', platform: 'taobao' })
    const success = await fetch(`${base}/v1/oauth/callback/taobao?state=${encodeURIComponent(state)}&code=fixture`, { headers: { accept: 'text/html' } })
    const successHtml = await success.text()
    expect(success.status).toBe(200)
    expect(success.headers.get('content-type')).toContain('text/html')
    expect(success.headers.get('cache-control')).toContain('no-store')
    expect(success.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(successHtml).toContain('店铺授权成功')
    expect(successHtml).toContain('淘宝')
    expect(successHtml).not.toContain('credentialRef')

    const failure = await fetch(`${base}/v1/oauth/callback/taobao?state=unused`, { headers: { accept: 'text/html' } })
    const failureHtml = await failure.text()
    expect(failure.status).toBe(400)
    expect(failure.headers.get('content-type')).toContain('text/html')
    expect(failureHtml).toContain('授权失败')
    expect(failureHtml).not.toContain('unused')
  })

  it('runs all six platforms from mock authorization through reviewed content and simulated publish receipt', async () => {
    const base = await start()
    const workspace = 'ws_six_platform_complete_flow_e2e'
    const platforms = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
    const accountIds = new Map<(typeof platforms)[number], string>()

    for (const platform of platforms) {
      const connected = await call(base, workspace, 'platform.connect', { platform })
      const account = connected.data?.result?.account
      expect(account).toMatchObject({ platform, tokenState: 'connected' })
      accountIds.set(platform, account.id)

      const synced = await call(base, workspace, 'catalog.sync.start', { platform, account_id: account.id, mode: 'full' })
      const product = synced.data?.result?.products?.[0]
      expect(product).toMatchObject({ platform, accountId: account.id })

      const confirmedFacts = await call(base, workspace, 'catalog.facts.confirm', { product_id: product.id })
      expect(confirmedFacts.data?.result).toMatchObject({ factsConfirmed: true })

      const image = await call(base, workspace, 'catalog.image.generate', { product_id: product.id, count: '1', direction: '平台主图' })
      expect(image.data?.result).toMatchObject({ images: [expect.stringMatching(/^data:image\/webp;base64,/u)] })
      const imageReview = await call(base, workspace, 'catalog.image.review', { product_id: product.id, images: JSON.stringify(image.data?.result?.images) })
      expect(imageReview.data?.result).toMatchObject({ findings: [] })

      const created = await call(base, workspace, 'task.create', { product_id: product.id, platform, account_id: account.id })
      const task = created.data?.result
      if (!task) throw new Error(`${platform} fixture task was not created`)
      expect(task).toMatchObject({ productId: product.id, platform, accountId: account.id })
      if (product.skus?.length > 1) {
        const answered = await call(base, workspace, 'task.answer', { task_id: task.id, answers_json: JSON.stringify({ sku_id: product.skus[0].id }), expected_version: String(task.version) })
        expect(answered.data?.result).toMatchObject({ answers: { sku_id: product.skus[0].id } })
      }
      const selected = await call(base, workspace, 'task.select_direction', { task_id: task.id, direction_id: 'A' })
      expect(selected.data?.result).toMatchObject({ state: 'direction_selected' })
      const plan = await call(base, workspace, 'task.plan.confirm', { task_id: task.id, actor_id: 'fixture-merchant', expected_version: String(selected.data?.result?.version ?? 2) })
      expect(plan.data?.result).toMatchObject({ state: 'plan_confirmed' })

      const generated = await call(base, workspace, 'content.codex.commit', { task_id: task.id, body_json: JSON.stringify(reviewedFixtureBody(product, platform)) })
      const content = generated.data?.result
      if (!content) throw new Error(`${platform} fixture content was not generated`)
      expect(content).toMatchObject({ taskId: task.id })
      const reviewed = await call(base, workspace, 'content.review', { content_version_id: content.id })
      expect(reviewed.data?.result).toMatchObject({ blocking: false })
      const versions = await call(base, workspace, 'content.versions', { task_id: task.id })
      expect(versions.data?.result).toHaveLength(1)
      const diff = await call(base, workspace, 'content.diff', { content_version_id: content.id })
      expect(diff.data?.result).toMatchObject({ toVersionId: content.id })
      const exported = await call(base, workspace, 'content.export', { content_version_id: content.id, format: 'manifest' })
      expect(exported.data?.result).toMatchObject({ fileName: 'manifest-v1.json' })
      const approved = await call(base, workspace, 'content.approve', { task_id: task.id, content_version_id: content.id })
      expect(approved.data?.result?.task).toMatchObject({ state: 'approved' })

      const preview = await call(base, workspace, 'publish.prepare', { task_id: task.id })
      expect(preview.data?.result).toMatchObject({ task: { id: task.id, platform }, operation: 'update' })
      const publish = await call(base, workspace, 'publish.confirm', {
        task_id: task.id,
        content_version_id: content.id,
        confirmation_hash: preview.data?.result?.confirmationHash,
        remote_snapshot_hash: preview.data?.result?.remoteSnapshotHash,
      }, { 'idempotency-key': `six-platform-${platform}-publish` })
      expect(publish.data?.result).toMatchObject({ state: 'queued', platform })
      await new Promise(resolve => setTimeout(resolve, 100))
      const receipt = await call(base, workspace, 'publish.get', { publish_job_id: publish.data?.result?.id })
      expect(receipt.data?.result).toMatchObject({ state: 'submitted', remoteState: 'submitted', remoteSimulated: true })
    }

    const revoked = await call(base, workspace, 'platform.revoke', { platform: 'jd', account_id: accountIds.get('jd') })
    expect(revoked.data?.result).toMatchObject({ platform: 'jd', state: 'revoked' })

    const unbound = await call(base, workspace, 'catalog.import', {
      platform: 'jd',
      remote_id: 'unbound-shared-sku',
      title: '京选轻量防晒外套',
      stock: '1',
      sku_count: '1',
      skus_json: JSON.stringify([{ id: 'JD-SKU-BLACK-M', name: '黑色/M', price: 199, stock: 1 }]),
      store_name: 'jd 店铺',
    })
    expect(unbound.data?.result).toMatchObject({ platform: 'jd', title: '京选轻量防晒外套' })
    expect(unbound.data?.result?.accountId).toBeUndefined()

    const metrics = await call(base, workspace, 'workspace.metrics', {
      date_from: '2020-01-01T00:00:00.000Z',
      date_to: '2100-01-01T00:00:00.000Z',
      risk_limit: '1',
    })
    const result = metrics.data?.result
    expect(result).toMatchObject({
      source: 'memory_service',
      dataCompleteness: 'process_local',
      hydration: { status: 'not_available', attempted: false, invalidSnapshotCount: 0 },
      comparisonAvailable: false,
      period: { activityFiltered: true, productRisksAreCurrentSnapshot: true },
      productSummary: { total: 7 },
      taskFunnel: { publishing: 6 },
      jobs: { sync: 6, publish: 6 },
      dataCoverage: { products: 7, tasks: 6, syncJobs: 6, publishJobs: 6, fixtureDataPresent: true },
      unboundLocalData: { products: 1, tasks: 0, publishJobs: 0 },
      riskSummary: { returned: 1, truncated: true, limit: 1 },
    })
    expect(result?.snapshotHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(result?.stores).toHaveLength(6)
    expect(result?.stores.map((store: Record<string, any>) => store.platform).sort()).toEqual([...platforms].sort())
    expect(new Set(result?.stores.map((store: Record<string, any>) => store.accountId)).size).toBe(6)
    for (const store of result?.stores ?? []) expect(store.product.total).toBe(1)
    expect(result?.riskItems).toEqual([
      expect.objectContaining({ type: 'AUTH_RECONNECT', platform: 'jd', accountId: accountIds.get('jd') }),
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('credentialRef')
    expect(serialized).not.toContain('rawPlatformFields')

    const healthBeforeAlias = await call(base, workspace, 'workspace.health')
    const directory = healthBeforeAlias.data?.result?.storeDirectory
    expect(directory).toHaveLength(6)
    const taobaoStore = directory.find((store: Record<string, any>) => store.platform === 'taobao')
    expect(taobaoStore).toMatchObject({
      accountId: accountIds.get('taobao'), state: 'connected', readable: true, revision: expect.any(Number),
      authorization: { state: 'fixture', reauthorizationRequired: false, scopeState: 'reported_by_provider', grantedScopes: ['fixture.product.read', 'fixture.product.write'], lastKnownExpiryState: 'valid', renewalMode: 'automatic', refreshSupported: true, lastAuthorizedAt: expect.any(String), metadataObservedAt: expect.any(String), metadataFreshness: 'last_known', stateChangedAt: expect.any(String), revokedAt: null, lastKnownAccessTokenExpiresAt: expect.any(String) },
      sync: { latestState: 'succeeded', lastAttemptAt: expect.any(String), lastSuccessfulAt: expect.any(String), lastUsableAt: expect.any(String), failedItems: 0 },
    })
    const scopedBeforeAlias = await call(base, workspace, 'workspace.metrics', { platform: 'taobao', account_id: taobaoStore.accountId, risk_limit: '20' })
    expect(scopedBeforeAlias.data?.result).toMatchObject({ selection: { mode: 'single_store', platform: 'taobao', accountId: taobaoStore.accountId, matchedStores: 1 }, productSummary: { total: 1 } })
    expect(scopedBeforeAlias.data?.result?.stores).toHaveLength(1)

    const renamed = await call(base, workspace, 'platform.store.alias.set', { platform: 'taobao', account_id: taobaoStore.accountId, alias: '北区内容店', expected_revision: String(taobaoStore.revision) })
    expect(renamed.data?.result?.store).toMatchObject({ platform: 'taobao', accountId: taobaoStore.accountId, alias: '北区内容店', label: '北区内容店' })
    const scopedAfterAlias = await call(base, workspace, 'workspace.metrics', { platform: 'taobao', account_id: taobaoStore.accountId, risk_limit: '20' })
    expect(scopedAfterAlias.data?.result?.stores).toEqual([expect.objectContaining({ storeAlias: '北区内容店' })])
    expect(scopedAfterAlias.data?.result?.snapshotHash).toBe(scopedBeforeAlias.data?.result?.snapshotHash)

    const missingPlatform = await call(base, workspace, 'workspace.metrics', { account_id: taobaoStore.accountId })
    expect(missingPlatform.error).toMatchObject({ code: 'STORE_PLATFORM_REQUIRED' })
    const mismatchedPlatform = await call(base, workspace, 'workspace.metrics', { platform: 'jd', account_id: taobaoStore.accountId })
    expect(mismatchedPlatform.error).toMatchObject({ code: 'PLATFORM_ACCOUNT_NOT_FOUND' })
  }, 30_000)
})
