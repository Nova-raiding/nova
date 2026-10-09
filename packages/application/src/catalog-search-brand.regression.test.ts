import { describe, expect, it } from 'vitest'
import { MerchantService } from './service.js'
import { PostgresBusinessRepository } from '../../persistence/src/business-repository.js'
import type { SqlClient, SqlPool } from '../../persistence/src/repository.js'

type Row = Record<string, unknown>
class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[] }> = []
  enqueue(...rows: Row[]) { this.responses.push({ rows }) }
  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}
class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

describe('catalog free-text brand search parity', () => {
  it('matches product brand and canonical workspace brand without crossing workspaces', () => {
    const service = new MerchantService()
    const product = service.importProduct({
      workspaceId: 'ws_catalog_brand_search', platform: 'jd', remoteId: 'remote-1',
      title: '便携折叠椅', storeName: '旗舰店', attributes: { brand: '山野制造' },
    })
    const profileOnlyProduct = service.importProduct({
      workspaceId: 'ws_catalog_brand_search', platform: 'taobao', remoteId: 'remote-2',
      title: '轻量露营桌', storeName: '户外店',
    })
    const otherWorkspaceProduct = service.importProduct({
      workspaceId: 'ws_catalog_brand_other', platform: 'jd', remoteId: 'remote-3',
      title: '山野制造 同款', storeName: '其他店',
    })
    service.upsertBrandProfile({ workspaceId: 'ws_catalog_brand_search', name: '山野生活' })

    expect(service.listProducts('ws_catalog_brand_search', { query: '制造' })).toEqual([product])
    expect(service.listProducts('ws_catalog_brand_search', { query: '山野生活' })).toEqual([product, profileOnlyProduct])
    expect(service.listProducts('ws_catalog_brand_search', { query: '山野制造' })).toEqual([product])
    expect(service.listProducts('ws_catalog_brand_other', { query: '山野生活' })).toEqual([])
    expect(otherWorkspaceProduct.workspaceId).toBe('ws_catalog_brand_other')
  })

  it('adds tenant-scoped product and canonical profile brand predicates to Postgres search', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // tenant scope
    client.enqueue({ total: '1' })
    client.enqueue({ data: { id: 'prod_brand' } })
    client.enqueue() // COMMIT

    await new PostgresBusinessRepository(new RecordingPool(client)).listProductsPage('ws_catalog_brand_search', {
      limit: 10, offset: 0, query: '山野%',
    })

    const countQuery = client.calls[2]!
    expect(countQuery.text).toContain("lower(coalesce(data#>>'{attributes,brand}', '')) LIKE '%' || lower($10) || '%' ESCAPE '!'")
    expect(countQuery.text).toContain("brand_profile.workspace_id = products.workspace_id")
    expect(countQuery.text).toContain("brand_profile.entity_id = 'brand_' || products.workspace_id")
    expect(countQuery.text).toContain("brand_profile.payload->>'name'")
    expect(countQuery.values).toEqual(['ws_catalog_brand_search', ...Array(10).fill('山野!%')])
    expect(client.calls[3]?.values).toEqual(['ws_catalog_brand_search', ...Array(10).fill('山野!%'), 10, 0])
    expect(client.calls[3]?.text).toContain('LIMIT $12 OFFSET $13')
  })
})
