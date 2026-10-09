import { createHash } from 'node:crypto'

export interface ImageGenerationIdempotencyIntent {
  workspaceId: string
  productId: string
  direction: string
  size?: string
  sourceAssetIds?: readonly string[]
  count: number
  imageMode: 'create' | 'optimize'
  taskId?: string
  taskVersion?: number
  contentVersionId?: string
  contentVersionVersion?: number
  skuIds?: readonly string[]
  productVersion?: number
  marketingBrief?: {
    sellingPoints?: readonly string[]
    trafficKeywords?: readonly string[]
    promotionLabels?: readonly string[]
    marketingLabels?: readonly string[]
    headline?: string
    subheadline?: string
    cta?: string
  }
}

/**
 * Fallback key for callers that omit an explicit idempotency key. Include the
 * server-resolved intent fields that affect enqueueImageGeneration so a changed
 * request cannot accidentally replay an older job under the same key.
 */
export function imageGenerationIdempotencyKey(intent: ImageGenerationIdempotencyIntent): string {
  const normalized = {
    schema: 1,
    workspaceId: intent.workspaceId.trim(),
    productId: intent.productId.trim(),
    direction: intent.direction.trim(),
    size: intent.size ?? null,
    sourceAssetIds: intent.sourceAssetIds ? [...intent.sourceAssetIds] : null,
    count: intent.count,
    imageMode: intent.imageMode,
    taskId: intent.taskId ?? null,
    taskVersion: intent.taskVersion ?? null,
    contentVersionId: intent.contentVersionId ?? null,
    contentVersionVersion: intent.contentVersionVersion ?? null,
    skuIds: intent.skuIds ? [...intent.skuIds] : null,
    productVersion: intent.productVersion ?? null,
    marketingBrief: intent.marketingBrief ?? null,
  }
  const digest = createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
  return `image-intent-${digest}`
}
