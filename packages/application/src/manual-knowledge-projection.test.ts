import { describe, expect, it } from 'vitest'
import { manualKnowledgeProduct, projectImportedProductsToKnowledge } from './knowledge-import.js'
import { MemoryKnowledgeRepository } from '../../persistence/src/knowledge.js'
import { handleCatalogImport, type CatalogImportDependencies } from '../../../apps/api/src/mcp-catalog-import.js'

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
