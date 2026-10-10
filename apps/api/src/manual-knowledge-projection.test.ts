import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { manualKnowledgeProduct, projectImportedProductsToKnowledge } from '../../../packages/application/src/knowledge-import.js'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { handleCatalogImport, type CatalogImportDependencies } from './mcp-catalog-import.js'

const product = { id: 'qa', workspaceId: 'ws', platform: 'taobao', title: '蓝袋QA', stock: 0, skuCount: 0, storeName: '导入店铺' }
async function projected(supplied: Parameters<typeof manualKnowledgeProduct>[1]) {
  return projectImportedProductsToKnowledge({ repository: new MemoryKnowledgeRepository(), workspaceId: 'ws', products: [manualKnowledgeProduct(product, supplied)] })
}
describe('manual draft sparse knowledge projection', () => {
  it('omits normalized defaults from every knowledge representation without mutating the product', async () => {
    const before = structuredClone(product)
    const result = await projected({ attributes: { visual_observation: '蓝色袋体、拉链、QA标识', ocr_text: 'QA' } })
    expect(result.assets[0]!.content).not.toHaveProperty('stock')
    expect(result.assets[0]!.content).not.toHaveProperty('skuCount')
    expect(result.assets[0]!.content).not.toHaveProperty('storeName')
    for (const content of [result.documents[0]!.extractedText, result.chunks[0]!.content]) {
      expect(content).not.toMatch(/库存|价格|导入店铺/u)
      expect(content).toContain('蓝色袋体、拉链、QA标识')
      expect(content).toContain('ocr_text')
    }
    expect(result.documents[0]).toMatchObject({ approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued' })
    expect(result.chunks[0]!.contentHash).toBe(result.documents[0]!.contentHash)
    expect(product).toEqual(before)
  })
  it.each([0, 7])('preserves explicitly supplied stock and price including zero: %s', async value => {
    const result = await projected({ stock: value, price: value, skuCount: value })
    expect(result.assets[0]!.content).toMatchObject({ stock: value, price: value, skuCount: value })
    expect(result.documents[0]!.extractedText).toContain(`商品库存：${value}`)
    expect(result.documents[0]!.extractedText).toContain(`商品价格：${value}`)
  })
  it('does not turn invalid supplied numbers into normalized zero facts', () => {
    for (const value of [-1, NaN, Infinity]) expect(manualKnowledgeProduct(product, { stock: value, price: value })).not.toHaveProperty('stock')
  })
  it('preserves explicit SKU facts but does not infer aggregate stock', async () => {
    const result = await projected({ skus: [{ id: 'sku', name: '蓝色', price: 0, stock: 2 }] })
    expect(result.assets[0]!.content).not.toHaveProperty('stock')
    expect(result.documents).toHaveLength(2)
    expect(result.documents[1]!.extractedText).toContain('库存：2')
  })
  it.each([undefined, '', '0', '5'])('uses request presence at the actual draft import handler: %s', async stock => {
    const repository = new MemoryKnowledgeRepository()
    const seen: unknown[] = []
    const deps = {
      service: { importProduct: (input: Record<string, unknown>) => { seen.push(input); return { ...structuredClone(product), stock: typeof input.stock === 'number' ? input.stock : 0 } } },
      supportedPlatforms: ['taobao'], isProduction: () => false, knowledgeRepository: repository,
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      scanImportedProductRules: async () => undefined,
      persistSnapshot: async (_workspace: string, _type: string, value: unknown) => { seen.push(structuredClone(value)) },
    } as unknown as CatalogImportDependencies
    const result = await handleCatalogImport('ws', { platform: 'taobao', title: '蓝袋QA', draft_only: 'true', ...(stock !== undefined ? { stock } : {}) }, deps)
    const expectedStock = stock === '5' ? 5 : 0
    expect(result.stock).toBe(expectedStock)
    expect(seen[1]).toEqual({ ...product, stock: expectedStock })
    const [document] = await repository.listDocuments('ws')
    if (stock === '0' || stock === '5') expect(document!.extractedText).toContain(`商品库存：${stock}`)
    else expect(document!.extractedText).not.toContain('库存')
  })
  it('checks workspace access for source assets before creating a draft product', async () => {
    const importProduct = vi.fn(() => structuredClone(product))
    const enforceAssetAccess = vi.fn(async () => { throw new DomainError('ASSET_ACCESS_DENIED', '素材不存在或不属于当前工作区', 404) })
    const deps = {
      service: { importProduct },
      supportedPlatforms: ['taobao'], isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      enforceBrandAccess: async () => undefined,
      enforceAssetAccess,
      scanImportedProductRules: vi.fn(async () => undefined),
      persistSnapshot: vi.fn(async () => undefined),
    } as unknown as CatalogImportDependencies

    await expect(handleCatalogImport('ws', {
      platform: 'taobao', title: '蓝袋QA', draft_only: 'true', asset_ids_json: '["asset_other_workspace"]',
    }, deps)).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws', 'asset_other_workspace', 'viewer')
    expect(importProduct).not.toHaveBeenCalled()
  })
  it('checks workspace access for SKU source assets before creating a product', async () => {
    const importProduct = vi.fn(() => structuredClone(product))
    const enforceAssetAccess = vi.fn(async () => { throw new DomainError('ASSET_ACCESS_DENIED', '素材不存在或不属于当前工作区', 404) })
    const deps = {
      service: { importProduct },
      supportedPlatforms: ['taobao'], isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      enforceBrandAccess: async () => undefined,
      enforceAssetAccess,
      assetForWorkspace: vi.fn(),
      scanImportedProductRules: vi.fn(async () => undefined),
      persistSnapshot: vi.fn(async () => undefined),
    } as unknown as CatalogImportDependencies

    await expect(handleCatalogImport('ws', {
      platform: 'taobao', title: '蓝袋QA', skus_json: JSON.stringify([{ id: 'sku_1', name: '蓝色', price: 10, stock: 1, sourceAssetIds: ['asset_other_workspace'] }]),
    }, deps)).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws', 'asset_other_workspace', 'viewer')
    expect(importProduct).not.toHaveBeenCalled()
  })
  it('checks target-workspace ownership for permitted product and SKU source assets', async () => {
    const importProduct = vi.fn(() => structuredClone(product))
    const enforceAssetAccess = vi.fn(async () => undefined)
    const assetForWorkspace = vi.fn((_workspaceId: string, assetId: string) => {
      if (assetId === 'asset_other_workspace') throw new DomainError('ASSET_NOT_FOUND', '素材不存在或不属于当前工作区', 404)
      return {}
    })
    const deps = {
      service: { importProduct },
      supportedPlatforms: ['taobao'], isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      enforceBrandAccess: async () => undefined,
      enforceAssetAccess,
      assetForWorkspace,
      scanImportedProductRules: vi.fn(async () => undefined),
      persistSnapshot: vi.fn(async () => undefined),
    } as unknown as CatalogImportDependencies

    await expect(handleCatalogImport('ws', {
      platform: 'taobao', title: '蓝袋QA', asset_ids_json: '["asset_in_workspace"]',
      skus_json: JSON.stringify([{ id: 'sku_1', name: '蓝色', price: 10, stock: 1, sourceAssetIds: ['asset_other_workspace'] }]),
    }, deps)).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })

    expect(enforceAssetAccess).toHaveBeenNthCalledWith(1, 'ws', 'asset_in_workspace', 'viewer')
    expect(enforceAssetAccess).toHaveBeenNthCalledWith(2, 'ws', 'asset_other_workspace', 'viewer')
    expect(assetForWorkspace).toHaveBeenNthCalledWith(1, 'ws', 'asset_in_workspace')
    expect(assetForWorkspace).toHaveBeenNthCalledWith(2, 'ws', 'asset_other_workspace')
    expect(importProduct).not.toHaveBeenCalled()
  })
  it.each([
    ['price', 'not-a-number'],
    ['sku_count', '1e999'],
    ['stock', ' '],
    ['price', '-0.01'],
    ['stock', '-1'],
    ['sku_count', '1.5'],
    ['stock', '9007199254740992'],
  ])('rejects invalid numeric %s before creating a product', async (field, value) => {
    let importCalls = 0
    const deps = {
      service: { importProduct: () => { importCalls += 1; return structuredClone(product) } },
      supportedPlatforms: ['taobao'], isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      scanImportedProductRules: async () => undefined,
      persistSnapshot: async () => undefined,
    } as unknown as CatalogImportDependencies

    await expect(handleCatalogImport('ws', { platform: 'taobao', title: '蓝袋QA', [field]: value }, deps))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', details: { field } })
    expect(importCalls).toBe(0)
  })
  it('does not create knowledge for an ordinary import', async () => {
    const repository = new MemoryKnowledgeRepository()
    await handleCatalogImport('ws', { platform: 'taobao', title: '蓝袋QA' }, {
      service: { importProduct: () => structuredClone(product) }, supportedPlatforms: ['taobao'], isProduction: () => false,
      knowledgeRepository: repository, required: (params: Record<string, unknown>, key: string) => String(params[key]),
      scanImportedProductRules: async () => undefined, persistSnapshot: async () => undefined,
    } as unknown as CatalogImportDependencies)
    expect(await repository.listDocuments('ws')).toEqual([])
  })
})
