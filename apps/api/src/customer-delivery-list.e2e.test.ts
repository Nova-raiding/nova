import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'

const token = 'customer-delivery-list-options-test-token'
type Rpc<T = unknown> = { data: { result: T } | null; error: { code: string } | null }
let api: typeof import('./server.js')
let base = ''

async function call<T>(workspaceId: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { target_workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Rpc<T> }
}

function success<T>(response: Awaited<ReturnType<typeof call<T>>>) {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  return response.body.data!.result
}

async function createDelivery(workspaceId: string, companyName: string, owner: string, support: string) {
  const created = success(await call<CustomerDelivery>(workspaceId, 'ops.customer-delivery.create', { company_name: companyName }))
  return success(await call<CustomerDelivery>(workspaceId, 'ops.customer-delivery.update', {
    delivery_id: created.id,
    expected_revision: String(created.revision),
    patch_json: JSON.stringify({ projectOwner: owner, supportOwner: support }),
  }))
}

describe('customer delivery list owner options', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST']) {
      if (process.env[key]) throw new Error(`Run safe-tests: inherited ${key} is forbidden`)
    }
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'customer-delivery-list-options-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { actor_id: 'delivery-platform-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
    }))
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('customer delivery list test listener did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('returns complete same-workspace owner options independent of page, search and owner filters', async () => {
    const workspaceId = `ws_delivery_options_${randomUUID()}`
    const otherWorkspaceId = `ws_delivery_options_other_${randomUUID()}`
    const first = await createDelivery(workspaceId, 'Options alpha customer', '项目负责人甲', '售后负责人甲')
    const second = await createDelivery(workspaceId, 'Options beta customer', '项目负责人乙', '售后负责人乙')
    await createDelivery(otherWorkspaceId, 'Other tenant customer', '其他租户项目负责人', '其他租户售后负责人')

    const list = (params: Record<string, unknown> = {}) => call<{
      items: CustomerDelivery[]
      total: number
      project_owner_options: string[]
      support_owner_options: string[]
    }>(workspaceId, 'ops.customer-delivery.list', params)
    const filteredBySearch = success(await list({ query: 'alpha', offset: '0', limit: '1' }))
    const filteredByOwner = success(await list({ project_owner: '项目负责人乙', offset: '0', limit: '1' }))
    const laterPage = success(await list({ offset: '1', limit: '1' }))

    for (const response of [filteredBySearch, filteredByOwner, laterPage]) {
      expect(response.project_owner_options).toEqual(['项目负责人乙', '项目负责人甲'].sort((a, b) => a.localeCompare(b, 'zh-CN')))
      expect(response.support_owner_options).toEqual(['售后负责人乙', '售后负责人甲'].sort((a, b) => a.localeCompare(b, 'zh-CN')))
      expect(response.project_owner_options.every(value => typeof value === 'string')).toBe(true)
      expect(response.support_owner_options.every(value => typeof value === 'string')).toBe(true)
      expect(JSON.stringify(response)).not.toContain('其他租户')
    }
    expect(filteredBySearch.items.map(item => item.id)).toEqual([first.id])
    expect(filteredByOwner.items.map(item => item.id)).toEqual([second.id])
    expect(laterPage.items.map(item => item.id)).toEqual([first.id])
  })
})
