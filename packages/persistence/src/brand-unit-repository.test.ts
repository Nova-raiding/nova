import { describe, expect, it } from 'vitest'
import { MemoryBrandUnitRepository, PostgresBrandUnitRepository, type BrandUnitPlatform } from './brand-unit-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class Client implements SqlClient {
  readonly calls: string[] = []
  private responses: Array<{ rows: any[] }> = []
  enqueue(...rows: any[]) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string) { this.calls.push(text); return (this.responses.shift() ?? { rows: [] }) as { rows: T[] } }
  release() {}
}

describe('PostgresBrandUnitRepository', () => {
  it('groups every selected brand column when aggregating store bindings', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ id: 'brand_1', workspaceId: 'ws_1', name: '户外品', revision: 1, bindings: [], createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z' })
    client.enqueue() // COMMIT

    await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).listBrands({ workspaceId: 'ws_1' })

    const select = client.calls.find(call => call.includes('FROM brands b'))
    expect(select).toContain('GROUP BY b.workspace_id, b.id, b.name, b.revision, b.created_at, b.updated_at')
  })

  it('returns the binding from the same transaction after inserting it', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // binding upsert
    client.enqueue({ id: 'brand_1', workspaceId: 'ws_1', name: '户外品', revision: 2, createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z' })
    client.enqueue({ platform: 'taobao' as BrandUnitPlatform, accountId: 'acct_1' })
    client.enqueue() // COMMIT
    const result = await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).bindStore({ workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'acct_1' })
    expect(result.storeBindings).toEqual([{ platform: 'taobao', accountId: 'acct_1' }])
    expect(client.calls.filter(call => call === 'BEGIN')).toHaveLength(1)
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('rejects idempotency reuse for a different campaign intent', async () => {
    const repository = new MemoryBrandUnitRepository()
    const base = { id: 'campaign_1', workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao' as BrandUnitPlatform, accountId: 'acct_1', productIds: ['product_1'], state: 'draft' as const, idempotencyKey: 'campaign-idem-1' }
    const created = await repository.createCampaign(base)
    expect(created.campaign.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(created.campaign.manifestHash).not.toBe('0'.repeat(64))
    expect(created.campaign.items).toMatchObject([{ productId: 'product_1', ordinal: 1, state: 'pending' }])
    await expect(repository.createCampaign({ ...base, id: 'campaign_2', productIds: ['product_2'] })).rejects.toMatchObject({ code: 'CAMPAIGN_IDEMPOTENCY_CONFLICT' })
  })

  it('persists per-item task assignments so campaign generation can resume without a process map', async () => {
    const repository = new MemoryBrandUnitRepository()
    const created = await repository.createCampaign({ id: 'campaign_resume', workspaceId: 'ws_resume', brandId: 'brand_resume', platform: 'taobao', accountId: 'acct_resume', productIds: ['product_a', 'product_b'], state: 'draft' })
    await repository.updateCampaignTasks({ workspaceId: 'ws_resume', id: created.campaign.id, taskIds: ['task_a', 'task_b'], state: 'generating' })
    const resumed = await repository.getCampaign({ workspaceId: 'ws_resume', id: created.campaign.id })
    expect(resumed?.taskIds).toEqual(['task_a', 'task_b'])
    expect(resumed?.items).toMatchObject([{ taskId: 'task_a', state: 'generating' }, { taskId: 'task_b', state: 'generating' }])
  })

  it('enforces increasing brand access roles in memory', async () => {
    const repository = new MemoryBrandUnitRepository()
    await repository.createBrand({ workspaceId: 'ws_access', id: 'brand_access', name: '权限品' })
    expect(await repository.hasBrandAccess({ workspaceId: 'ws_access', brandId: 'brand_access', externalSubject: 'member_1' })).toBe(false)
    await repository.grantBrandAccess({ workspaceId: 'ws_access', brandId: 'brand_access', externalSubject: 'member_1', role: 'editor' })
    expect(await repository.hasBrandAccess({ workspaceId: 'ws_access', brandId: 'brand_access', externalSubject: 'member_1', minimumRole: 'viewer' })).toBe(true)
    expect(await repository.hasBrandAccess({ workspaceId: 'ws_access', brandId: 'brand_access', externalSubject: 'member_1', minimumRole: 'publisher' })).toBe(false)
  })
})
