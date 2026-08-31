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

  it('uses the brand revision as an optional optimistic concurrency guard', async () => {
    const client = new Client()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue({ id: 'brand_1', workspaceId: 'ws_1', name: '户外品', revision: 3, createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z' }); client.enqueue({ platform: 'taobao', accountId: 'acct_1' }); client.enqueue()
    const result = await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).bindStore({ workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'acct_1', expectedRevision: 2 })
    expect(result.revision).toBe(3)
    expect(client.calls[3]).toContain('AND ($3::int IS NULL OR revision=$3)')
  })

  it('rolls back the binding upsert when the expected revision is stale', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // binding upsert (rolled back)
    client.enqueue() // stale brand update returns no row
    client.enqueue() // ROLLBACK

    await expect(new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).bindStore({
      workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'acct_1', expectedRevision: 1,
    })).rejects.toThrow('BRAND_STORE_REVISION_CONFLICT')
    expect(client.calls.at(-1)).toBe('ROLLBACK')
  })

  it('creates a listing only through a workspace and brand matched canonical product', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ id: 'listing_1', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao', accountId: 'acct_1', state: 'draft' })
    client.enqueue() // COMMIT

    await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).createListing({
      workspaceId: 'ws_1', id: 'listing_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao', accountId: 'acct_1',
    })

    const insert = client.calls.find(call => call.includes('INSERT INTO product_listings'))
    expect(insert).toContain('SELECT $1,$2,$3,$4,$5,$6,$7 FROM canonical_products canonical')
    expect(insert).toContain('canonical.workspace_id=$2 AND canonical.brand_id=$3 AND canonical.id=$4')
  })

  it('updates a canonical title with a facts revision CAS', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ id: 'canonical_1', workspaceId: 'ws_1', brandId: 'brand_1', title: '新标题', facts: {}, factsVersion: 2 })
    client.enqueue() // COMMIT
    const result = await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).updateCanonicalProductTitle({ workspaceId: 'ws_1', id: 'canonical_1', title: '新标题', expectedFactsVersion: 1 })
    expect(result).toMatchObject({ id: 'canonical_1', title: '新标题', factsVersion: 2 })
    expect(client.calls.find(call => call.startsWith('UPDATE canonical_products'))).toContain('AND facts_revision=$4')
  })

  it('rolls back a canonical title update when its revision is stale', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // update returns no row
    client.enqueue({ factsVersion: 2 }) // current revision lookup
    client.enqueue() // ROLLBACK
    await expect(new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).updateCanonicalProductTitle({ workspaceId: 'ws_1', id: 'canonical_1', title: '新标题', expectedFactsVersion: 1 })).rejects.toThrow('CANONICAL_PRODUCT_REVISION_CONFLICT')
    expect(client.calls.at(-1)).toBe('ROLLBACK')
  })

  it('updates canonical facts with the same revision CAS', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ id: 'canonical_1', workspaceId: 'ws_1', brandId: 'brand_1', title: '商品', facts: { category: '服装' }, factsVersion: 2 })
    client.enqueue() // COMMIT
    const result = await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).updateCanonicalProductFacts({ workspaceId: 'ws_1', id: 'canonical_1', facts: { category: '服装' }, expectedFactsVersion: 1 })
    expect(result).toMatchObject({ id: 'canonical_1', facts: { category: '服装' }, factsVersion: 2 })
    expect(client.calls.find(call => call.startsWith('UPDATE canonical_products'))).toContain('facts=$3::jsonb')
  })

  it('rejects a listing when its canonical product does not match the workspace and brand', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // INSERT SELECT returns no row
    client.enqueue() // ROLLBACK

    await expect(new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).createListing({
      workspaceId: 'ws_1', id: 'listing_cross_brand', brandId: 'brand_2', canonicalProductId: 'canonical_brand_1', platform: 'taobao', accountId: 'acct_2',
    })).rejects.toThrow('PRODUCT_LISTING_CANONICAL_NOT_FOUND')
    expect(client.calls.at(-1)).toBe('ROLLBACK')
  })

  it('loads all consistency rows in one workspace-scoped read transaction', async () => {
    const client = new Client()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ id: 'legacy_1', workspaceId: 'ws_1' })
    client.enqueue({ id: 'canonical_1', workspaceId: 'ws_1', brandId: 'brand_1', legacyProductId: 'legacy_1' })
    client.enqueue({ id: 'listing_1', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao', accountId: 'acct_1' })
    client.enqueue({ id: 'item_1', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', listingId: 'listing_1' })
    client.enqueue({ id: 'task_1', workspaceId: 'ws_1', productId: 'legacy_1' })
    client.enqueue({ id: 'publish_1', workspaceId: 'ws_1', taskId: 'task_1', platform: 'taobao', accountId: 'acct_1' })
    client.enqueue() // COMMIT

    const rows = await new PostgresBrandUnitRepository({ connect: async () => client } satisfies SqlPool).listCanonicalChainConsistencyRows({ workspaceId: 'ws_1' })
    expect(rows).toMatchObject({ canonicalProducts: [{ id: 'canonical_1' }], listings: [{ id: 'listing_1' }], campaignItems: [{ id: 'item_1' }], tasks: [{ id: 'task_1' }] })
    expect(client.calls.filter(call => call.includes('workspace_id=$1'))).toHaveLength(7)
    expect(client.calls.filter(call => call.includes('workspace_id=$1')).every(call => !call.includes('UPDATE') && !call.includes('INSERT') && !call.includes('DELETE'))).toBe(true)
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

  it('persists campaign pause/resume/retry with CAS and durable idempotent replay', async () => {
    const repository = new MemoryBrandUnitRepository()
    const created = await repository.createCampaign({ id: 'campaign_lifecycle', workspaceId: 'ws_lifecycle', brandId: 'brand_lifecycle', platform: 'taobao', accountId: 'acct_lifecycle', productIds: ['product_a', 'product_b'], state: 'draft' })
    expect(created.campaign.revision).toBe(1)
    const paused = await repository.transitionCampaignLifecycle({ workspaceId: 'ws_lifecycle', id: created.campaign.id, operation: 'pause', expectedRevision: 1, idempotencyKey: 'pause-key-1', reason: 'operator pause' })
    expect(paused).toMatchObject({ replayed: false, campaign: { state: 'paused', revision: 2, items: [{ state: 'paused' }, { state: 'paused' }] } })
    await expect(repository.transitionCampaignLifecycle({ workspaceId: 'ws_lifecycle', id: created.campaign.id, operation: 'pause', expectedRevision: 1, idempotencyKey: 'pause-key-1', reason: 'operator pause' })).resolves.toMatchObject({ replayed: true, campaign: { revision: 2 } })
    await expect(repository.transitionCampaignLifecycle({ workspaceId: 'ws_lifecycle', id: created.campaign.id, operation: 'pause', expectedRevision: 2, idempotencyKey: 'pause-key-1', reason: 'different intent' })).rejects.toMatchObject({ code: 'CAMPAIGN_LIFECYCLE_IDEMPOTENCY_CONFLICT' })
    await expect(repository.transitionCampaignLifecycle({ workspaceId: 'ws_lifecycle', id: created.campaign.id, operation: 'resume', expectedRevision: 1, idempotencyKey: 'resume-key-stale', reason: 'stale resume' })).rejects.toMatchObject({ code: 'CAMPAIGN_REVISION_CONFLICT' })
    const resumed = await repository.transitionCampaignLifecycle({ workspaceId: 'ws_lifecycle', id: created.campaign.id, operation: 'resume', expectedRevision: 2, idempotencyKey: 'resume-key-1', reason: 'operator resume' })
    expect(resumed.campaign).toMatchObject({ state: 'draft', revision: 3, items: [{ state: 'pending' }, { state: 'pending' }] })
    await repository.updateCampaignProgress({ workspaceId: 'ws_lifecycle', id: created.campaign.id, state: 'failed', items: resumed.campaign.items!.map((item, index) => ({ id: item.id, state: index === 0 ? 'failed' : 'published', ...(index === 0 ? { error: { code: 'REMOTE_TIMEOUT', message: 'timeout' } } : {}) })) })
    const retried = await repository.transitionCampaignLifecycle({ workspaceId: 'ws_lifecycle', id: created.campaign.id, operation: 'retry_failed', expectedRevision: 4, idempotencyKey: 'retry-key-1', reason: 'retry failed only' })
    expect(retried.campaign).toMatchObject({ state: 'generating', revision: 5, items: [{ state: 'pending', error: undefined }, { state: 'published' }] })
    await expect(repository.getCampaign({ workspaceId: 'ws_other', id: created.campaign.id })).resolves.toBeUndefined()
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

describe('MemoryBrandUnitRepository consistency projections', () => {
  it('includes task and publish edges supplied by the in-memory application service', async () => {
    const repository = new MemoryBrandUnitRepository()
    repository.setConsistencyProjections({
      tasks: () => [{ id: 'task_1', workspaceId: 'ws_1', productId: 'legacy_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', listingId: 'listing_1', campaignItemId: 'item_1', platform: 'taobao', accountId: 'acct_1' }],
      publishJobs: () => [{ id: 'publish_1', workspaceId: 'ws_1', taskId: 'task_1', canonicalProductId: 'canonical_1', listingId: 'listing_1', platform: 'taobao', accountId: 'acct_1' }],
    })
    const rows = await repository.listCanonicalChainConsistencyRows({ workspaceId: 'ws_1' })
    expect(rows.tasks).toEqual([expect.objectContaining({ id: 'task_1', canonicalProductId: 'canonical_1', listingId: 'listing_1' })])
    expect(rows.publishJobs).toEqual([expect.objectContaining({ id: 'publish_1', taskId: 'task_1', listingId: 'listing_1' })])
  })
})

describe('MemoryBrandUnitRepository', () => {
  it('updates canonical titles only when the expected facts revision is current', async () => {
    const repository = new MemoryBrandUnitRepository()
    await repository.createCanonicalProduct({ workspaceId: 'ws_title', id: 'canonical_1', brandId: 'brand_1', title: '旧标题', facts: { category: '服装' } })
    const updated = await repository.updateCanonicalProductTitle({ workspaceId: 'ws_title', id: 'canonical_1', title: '新标题', expectedFactsVersion: 1 })
    expect(updated).toMatchObject({ title: '新标题', factsVersion: 2 })
    await expect(repository.updateCanonicalProductTitle({ workspaceId: 'ws_title', id: 'canonical_1', title: '冲突标题', expectedFactsVersion: 1 })).rejects.toThrow('CANONICAL_PRODUCT_REVISION_CONFLICT')
  })

  it('updates canonical facts only when the expected revision is current', async () => {
    const repository = new MemoryBrandUnitRepository()
    await repository.createCanonicalProduct({ workspaceId: 'ws_facts', id: 'canonical_1', brandId: 'brand_1', title: '商品' })
    const updated = await repository.updateCanonicalProductFacts({ workspaceId: 'ws_facts', id: 'canonical_1', facts: { category: '服装', sku_ids: ['sku_1'] }, expectedFactsVersion: 1 })
    expect(updated).toMatchObject({ facts: { category: '服装', sku_ids: ['sku_1'] }, factsVersion: 2 })
    await expect(repository.updateCanonicalProductFacts({ workspaceId: 'ws_facts', id: 'canonical_1', facts: { category: '鞋' }, expectedFactsVersion: 1 })).rejects.toThrow('CANONICAL_PRODUCT_REVISION_CONFLICT')
  })

  it('allows only one concurrent binding writer for the same expected revision', async () => {
    const repository = new MemoryBrandUnitRepository()
    await repository.createBrand({ workspaceId: 'ws_concurrent', id: 'brand_1', name: '并发品' })
    const outcomes = await Promise.allSettled([
      repository.bindStore({ workspaceId: 'ws_concurrent', brandId: 'brand_1', platform: 'taobao', accountId: 'acct_1', expectedRevision: 1 }),
      repository.bindStore({ workspaceId: 'ws_concurrent', brandId: 'brand_1', platform: 'jd', accountId: 'acct_2', expectedRevision: 1 }),
    ])
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
    await expect(repository.listBrands({ workspaceId: 'ws_concurrent', brandId: 'brand_1' })).resolves.toMatchObject([{ revision: 2 }])
  })

  it('rejects a stale store-binding revision without overwriting current state', async () => {
    const repository = new MemoryBrandUnitRepository()
    await repository.createBrand({ workspaceId: 'ws_1', id: 'brand_1', name: '户外品' })
    await repository.bindStore({ workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'acct_1', expectedRevision: 1 })
    await expect(repository.bindStore({ workspaceId: 'ws_1', brandId: 'brand_1', platform: 'jd', accountId: 'acct_2', expectedRevision: 1 })).rejects.toThrow('BRAND_STORE_REVISION_CONFLICT')
    await expect(repository.listBrands({ workspaceId: 'ws_1', brandId: 'brand_1' })).resolves.toMatchObject([{ revision: 2, storeBindings: [{ platform: 'taobao', accountId: 'acct_1' }] }])
  })
})
