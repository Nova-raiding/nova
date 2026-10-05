import { describe, expect, it, vi } from 'vitest'
import type { CapabilityId } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'
import type { CommercialCatalogSkuSnapshot } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import { handleCommercialOpsCatalogMethod, type CommercialOpsCatalogDependencies } from './mcp-commercial-ops-catalog.js'

function dependencies(capabilities: CapabilityId[], mutate: CommercialOpsCatalogDependencies['catalog'] extends infer Catalog
  ? Catalog extends { mutate: infer Mutate } ? Mutate : never
  : never, list = vi.fn().mockResolvedValue([])) {
  const catalog = { mutate, list } as unknown as NonNullable<ApiPersistence['commercialCatalog']>
  return {
    catalog,
    capabilities: () => capabilities,
    actor: () => 'actor-test',
    required: (params: Record<string, unknown>, key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${key}`)
      return value
    },
    parseJsonObjectParameter: () => ({ source: 'test' }),
    parseJsonArrayParameter: () => [],
    commercialOpsReadInput: <T>(project: () => T) => project(),
  } satisfies CommercialOpsCatalogDependencies
}

describe('commercial Ops catalog mutation authorization', () => {
  it('rejects retire for a draft-only capability before touching the repository', async () => {
    const mutate = vi.fn()
    const input = { action: 'retire', code: 'basic', reason: 'retire obsolete SKU', evidence_json: '{}', idempotency_key: 'retire-1' }

    await expect(handleCommercialOpsCatalogMethod(
      'ops.commercial.catalog-v2.mutate',
      input,
      dependencies(['commercial.catalog.draft'], mutate),
    )).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('versioned catalog actions', () => {
  const params = { code: 'basic', reason: 'approved price revision', evidence_json: '{}', idempotency_key: 'catalog-1', expected_revision: '2', version_id: 'basic-v2' }
  it('allows approval without publish capability and freezes the addressed version', async () => {
    const mutate = vi.fn().mockResolvedValue({ versionId: 'basic-v2', code: 'basic', kind: 'monthly', visibility: 'public', version: 2, priceFen: 200000, priceMode: 'fixed', durationDays: null, payload: {}, benefits: [], lifecycle: 'approved', checksum: 'sha', effectiveAt: null, executable: false })
    await handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.mutate', { ...params, action: 'approve' }, dependencies(['commercial.catalog.approve'], mutate))
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve', versionId: 'basic-v2', expectedRevision: 2, idempotencyKey: 'catalog-1' }))
  })
  it('does not let publishing permission bypass approval permission', async () => {
    const mutate = vi.fn()
    await expect(handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.mutate', { ...params, action: 'approve' }, dependencies(['commercial.catalog.publish'], mutate))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(mutate).not.toHaveBeenCalled()
  })
  it('does not let draft deletion archive a published product', async () => {
    const mutate = vi.fn()
    await expect(handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.mutate', { ...params, action: 'archive' }, dependencies(['commercial.catalog.draft'], mutate))).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(mutate).not.toHaveBeenCalled()
  })
  it('returns a successful empty catalog instead of a repository outage', async () => {
    const deps = dependencies(['commercial.catalog.read'], vi.fn())
    await expect(handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', {}, deps)).resolves.toMatchObject({ items: [], total: 0, next_cursor: null })
  })
})

describe('versioned catalog list filters', () => {
  const snapshot = (overrides: Partial<CommercialCatalogSkuSnapshot> = {}): CommercialCatalogSkuSnapshot => ({
    id: 'basic', code: 'basic', versionId: 'basic-v1', version: 1, kind: 'monthly', visibility: 'public',
    requiredCapability: null, lifecycle: 'approved', executable: true, priceFen: 200000, currency: 'CNY',
    priceMode: 'fixed', durationDays: null, payload: { name: '基础套餐', description: '适合起步商家' },
    checksum: 'sha-basic', effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', saleRevision: 1,
    currentSaleVersionId: 'basic-v1', benefits: [], ...overrides,
  })
  const rows = [
    snapshot(),
    snapshot({ id: 'growth', code: 'growth', versionId: 'growth-v1', payload: { name: '成长套餐', description: '扩展经营能力' }, saleState: 'off_sale', currentSaleVersionId: null }),
    snapshot({ id: 'opening', code: 'opening', versionId: 'opening-v1', kind: 'onboarding', payload: { name: '账户开通', description: '账户开通费用' } }),
    snapshot({ id: 'points', code: 'points', versionId: 'points-v1', kind: 'point_pack', payload: { name: '点数权益包', description: '补充创意点' } }),
  ]

  it('filters by search across SKU code, name and description before computing total', async () => {
    const deps = dependencies(['commercial.catalog.read'], vi.fn(), vi.fn().mockResolvedValue(rows))
    const result = await handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { search: '扩展经营' }, deps)
    expect(result).toMatchObject({ total: 1, items: [{ sku_code: 'growth' }], next_cursor: null })
  })

  it('filters by kind before pagination and reports a filtered total', async () => {
    const deps = dependencies(['commercial.catalog.read'], vi.fn(), vi.fn().mockResolvedValue(rows))
    const result = await handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { kind: 'point_pack' }, deps)
    expect(result).toMatchObject({ total: 1, items: [{ sku_code: 'points', type: 'point_pack' }] })
  })

  it('filters by sale state before pagination and reports a filtered total', async () => {
    const deps = dependencies(['commercial.catalog.read'], vi.fn(), vi.fn().mockResolvedValue(rows))
    const result = await handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { sale_state: 'off_sale' }, deps)
    expect(result).toMatchObject({ total: 1, items: [{ sku_code: 'growth', sale_state: 'off_sale' }] })
  })

  it('keeps total and cursor consistent across combined filters', async () => {
    const moreMonthly = snapshot({ id: 'premium', code: 'premium', versionId: 'premium-v1', payload: { name: '尊享套餐', description: '高阶经营' } })
    const deps = dependencies(['commercial.catalog.read'], vi.fn(), vi.fn().mockResolvedValue([...rows, moreMonthly]))
    const first = await handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { search: '套餐', kind: 'monthly', sale_state: 'on_sale', limit: '1' }, deps) as { total: number; items: Array<{ sku_code: string }>; next_cursor: string | null }
    expect(first).toMatchObject({ total: 2, items: [{ sku_code: 'basic' }] })
    expect(first.next_cursor).toBeTruthy()
    const second = await handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { search: '套餐', kind: 'monthly', sale_state: 'on_sale', limit: '1', cursor: first.next_cursor }, deps) as { total: number; items: Array<{ sku_code: string }>; next_cursor: string | null }
    expect(second).toMatchObject({ total: 2, items: [{ sku_code: 'premium' }], next_cursor: null })
  })

  it('rejects unsupported filters instead of silently returning an unfiltered page', async () => {
    const list = vi.fn().mockResolvedValue(rows)
    const deps = dependencies(['commercial.catalog.read'], vi.fn(), list)
    await expect(handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { kind: 'unknown' }, deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(handleCommercialOpsCatalogMethod('ops.commercial.catalog-v2.list', { sale_state: 'unknown' }, deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(list).not.toHaveBeenCalled()
  })
})
