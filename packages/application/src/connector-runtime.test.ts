import { describe, expect, it, vi } from 'vitest'
import { ConnectorRuntime } from './connector-runtime.js'

describe('ConnectorRuntime', () => {
  it('syncs through a selected profile and keeps platform identity', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true })
    const result = await runtime.sync('tmall', { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' })
    expect(result.platform).toBe('tmall')
    expect(result.items[0]?.platform).toBe('tmall')
  })

  it('uses the publish worker and returns a simulated receipt in fixture mode', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true })
    const result = await runtime.publish({ platform: 'taobao', context: { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' }, fields: { title: '更新标题', category: '女装 > 外套', price: 169, stock: 10 }, idempotencyKey: 'runtime-idem-1' })
    expect(result.connectorStatus?.state).toBe('succeeded')
  })

  it('creates new products and updates existing products based on remote identity', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true })
    const created = await runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' }, fields: { title: '新商品', category: '服饰 > 外套', price: 169, stock: 10 }, idempotencyKey: 'runtime-create-1' })
    const updated = await runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' }, remoteId: 'JD-FIXTURE-1001', fields: { title: '更新商品', category: '服饰 > 外套', price: 179, stock: 8 }, idempotencyKey: 'runtime-update-1' })
    expect(created.receipt.operation).toBe('create')
    expect(updated.receipt.operation).toBe('update')
  })

  it('assembles an OAuth-only HTTP connector and keeps catalog access closed without evidence or vault', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    const runtime = new ConnectorRuntime({ configSource: {
      TMALL_APP_KEY: 'tmall-app',
      TMALL_OAUTH_AUTHORIZE_URL: 'https://tmall.test/authorize',
      TMALL_OAUTH_TOKEN_URL: 'https://tmall.test/token',
      TMALL_API_BASE_URL: 'https://tmall.test/api',
    }, fetch: fetchMock })
    expect(runtime.isOAuthConfigured('tmall')).toBe(true)
    expect(runtime.isHttpConfigured('tmall')).toBe(false)
    expect(runtime.canRead('tmall')).toBe(false)
    expect(runtime.isHttpConfigured('taobao')).toBe(false)
    await expect(runtime.connector('tmall').authorize({ workspaceId: 'ws_1', actorId: 'actor', redirectUri: 'https://app.test/v1/oauth/callback/tmall', state: 'state' })).resolves.toMatchObject({ ok: true, mode: 'real' })
    await expect(runtime.sync('tmall', { workspaceId: 'ws_1', accountId: 'acct_1' })).rejects.toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts typed structured config without reading secrets into connector config', () => {
    const runtime = new ConnectorRuntime({ structuredConfig: {
      taobao: {
        clientId: 'taobao-app',
        oauth: { authorizeUrl: 'https://taobao.test/authorize', tokenUrl: 'https://taobao.test/token' },
        api: { baseUrl: 'https://taobao.test/api', syncPath: '/items', createPath: '/items/create', updatePath: '/items/update', queryPath: '/items/status' },
      },
    } })
    expect(runtime.isOAuthConfigured('taobao')).toBe(true)
    expect(runtime.isHttpConfigured('taobao')).toBe(false)
    expect(runtime.canRead('taobao')).toBe(false)
    expect(runtime.isHttpConfigured('tmall')).toBe(false)
  })
})
