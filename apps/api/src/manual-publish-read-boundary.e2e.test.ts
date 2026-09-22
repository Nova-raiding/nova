import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, workspaceMembers } from './server.js'

type Envelope<T = Record<string, any>> = {
  workspace_id: string
  data: T | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
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

async function configureMerchant(token: string, workspaceId: string) {
  const actorId = `${token}-actor`
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    [token]: { workspaces: [workspaceId], actor_id: actorId, workbenches: ['workspace'] },
  }))
  await workspaceMembers.upsert({
    workspaceId,
    externalSubject: actorId,
    displayName: actorId,
    role: 'workspace_owner',
    status: 'active',
    invitedBy: 'manual-publish-read-boundary-test',
  })
  await grantCreativePointsForTests(workspaceId)
  grantContinuousFeatureEntitlementForTests(workspaceId)
}

async function call(base: string, token: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: response.status, body: await response.json() as Envelope<{ result: any }> }
}

beforeEach(() => {
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('manual publish read boundary', () => {
  it.each(['publish.manual.list', 'publish.manual.get'])('keeps %s confined to the authenticated workspace', async method => {
    const workspaceId = `ws_manual_publish_scope_${Date.now()}`
    const token = 'manual-publish-scope-owner'
    await configureMerchant(token, workspaceId)
    const base = await start()
    const response = await call(base, token, `${workspaceId}_foreign`, method,
      method === 'publish.manual.get' ? { manual_publish_report_id: 'foreign-record' } : { limit: '10', offset: '0' })

    expect(response.status).toBe(403)
    expect(response.body.error).not.toBeNull()
    expect(response.body.data).toBeNull()
  })

  it('lets a production manual-mode merchant without a store read an empty manual-publish page', async () => {
    const workspaceId = `ws_manual_publish_list_${Date.now()}`
    const token = 'manual-publish-list-owner'
    await configureMerchant(token, workspaceId)
    const base = await start()

    const response = await call(base, token, workspaceId, 'publish.manual.list', { limit: '100', offset: '0' })

    expect(response.status).toBe(200)
    expect(response.body.error).toBeNull()
    expect(response.body.data?.result).toEqual({ items: [], total: 0, limit: 100, offset: 0 })
  })

  it('returns the resource-level 404 for a missing manual-publish record instead of a store-boundary 428', async () => {
    const workspaceId = `ws_manual_publish_get_${Date.now()}`
    const token = 'manual-publish-get-owner'
    await configureMerchant(token, workspaceId)
    const base = await start()

    const response = await call(base, token, workspaceId, 'publish.manual.get', { manual_publish_report_id: 'manual-report-missing' })

    expect(response.status).toBe(404)
    expect(response.body.error).toMatchObject({ code: 'MANUAL_PUBLISH_RECORD_NOT_FOUND' })
  })

  it('keeps platform-acting writes store-gated and gives manual-mode recovery guidance', async () => {
    const workspaceId = `ws_manual_publish_write_${Date.now()}`
    const token = 'manual-publish-write-owner'
    await configureMerchant(token, workspaceId)
    const base = await start()

    const response = await call(base, token, workspaceId, 'task.create', { product_id: 'product-without-manual-store', platform: 'taobao' })

    expect(response.status).toBe(428)
    expect(response.body.error).toMatchObject({
      code: 'STORE_ONBOARDING_REQUIRED',
      message: '请先由平台运营为你的商家建立人工店铺记录，再继续使用商品同步、正式任务与发布能力',
    })
  })
})
