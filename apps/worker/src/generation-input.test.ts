import { describe, expect, it } from 'vitest'
import { assertGenerationInput } from './generation-input.js'

const valid = () => ({ platform: 'taobao', directionId: 'A', product: { id: 'product_1', title: '商品', stock: 3, skuCount: 1 }, confirmedFactSourceIds: ['product:product_1:v1'], usageContext: { workspaceId: 'ws_1', actionId: 'model:job_1', runKey: 'task_1' } })

describe('durable generation prompt schema', () => {
  it('accepts a tenant-bound frozen input envelope', () => {
    expect(assertGenerationInput(valid(), 'ws_1', 'model:job_1', 'task_1')).toMatchObject({ platform: 'taobao', directionId: 'A' })
  })
  it.each([
    ['missing product', { product: undefined }],
    ['missing fact references', { confirmedFactSourceIds: [] }],
    ['wrong workspace usage', { usageContext: { workspaceId: 'ws_other', actionId: 'model:job_1', runKey: 'task_1' } }],
    ['invalid stock', { product: { title: '商品', stock: -1, skuCount: 1 } }],
    ['invalid asset revision', { referenceAssets: [{ id: 'asset_1', revision: 0 }] }],
    ['duplicate frozen SKU references', { product: { ...valid().product, skuIds: ['sku-1', 'sku-1'] } }],
    ['control character in product identity', { product: { ...valid().product, id: 'product\u0001' } }],
    ['malformed asset preference', { referenceAssets: [{ id: 'asset_1', revision: 1, preference: { verdict: 'excellent', reasons: [] } }] }],
    ['control character in asset preference', { referenceAssets: [{ id: 'asset_1', revision: 1, preference: { verdict: 'disliked', reasons: ['bad\u0001'] } }] }],
  ])('rejects %s before provider input is accepted', (_label, override) => {
    expect(() => assertGenerationInput({ ...valid(), ...override }, 'ws_1', 'model:job_1', 'task_1')).toThrowError(expect.objectContaining({ code: 'GENERATION_INPUT_SCHEMA_INVALID' }))
  })
})
