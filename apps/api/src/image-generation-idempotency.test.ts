import { describe, expect, it } from 'vitest'
import { imageGenerationIdempotencyKey, type ImageGenerationIdempotencyIntent } from './image-generation-idempotency.js'

const baseIntent: ImageGenerationIdempotencyIntent = {
  workspaceId: 'workspace-1',
  productId: 'product-1',
  direction: 'white background',
  size: '1024x1024',
  sourceAssetIds: ['asset-1'],
  count: 2,
  imageMode: 'optimize',
  taskId: 'task-1',
  taskVersion: 3,
  contentVersionId: 'content-1',
  contentVersionVersion: 2,
  skuIds: ['sku-blue'],
  productVersion: 7,
  marketingBrief: { headline: 'Confirmed headline', sellingPoints: ['Confirmed point'] },
}

describe('image generation fallback idempotency key', () => {
  it('is stable for the same normalized business intent', () => {
    expect(imageGenerationIdempotencyKey(baseIntent)).toBe(imageGenerationIdempotencyKey({ ...baseIntent, workspaceId: ' workspace-1 ', direction: ' white background ' }))
  })

  it.each([
    ['size', { size: '1536x1024' }],
    ['source assets', { sourceAssetIds: ['asset-2'] }],
    ['count', { count: 3 }],
    ['mode', { imageMode: 'create' as const }],
    ['task association', { taskId: 'task-2' }],
    ['task revision', { taskVersion: 4 }],
    ['content version', { contentVersionId: 'content-2' }],
    ['SKU scope', { skuIds: ['sku-red'] }],
    ['product version', { productVersion: 8 }],
    ['confirmed brief', { marketingBrief: { headline: 'Different confirmed headline' } }],
  ])('changes when %s changes', (_field, patch) => {
    expect(imageGenerationIdempotencyKey({ ...baseIntent, ...patch })).not.toBe(imageGenerationIdempotencyKey(baseIntent))
  })
})
