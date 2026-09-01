import type { ContentGenerationInput } from '../../../packages/ai/src/generator.js'

export class GenerationInputSchemaError extends Error {
  readonly code = 'GENERATION_INPUT_SCHEMA_INVALID'
  constructor(message: string) { super(message); this.name = 'GenerationInputSchemaError' }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new GenerationInputSchemaError(`generation input ${field} is required and must not contain control characters`)
  return value.trim()
}
function stringList(value: unknown, field: string, options: { min?: number; unique?: boolean } = {}): string[] {
  if (!Array.isArray(value) || value.length < (options.min ?? 0) || value.some(item => typeof item !== 'string' || !item.trim() || /[\u0000-\u001f\u007f]/u.test(item))) {
    throw new GenerationInputSchemaError(`generation input ${field} must contain valid string references`)
  }
  const result = value.map(item => (item as string).trim())
  if (options.unique && new Set(result).size !== result.length) throw new GenerationInputSchemaError(`generation input ${field} must be unique`)
  return result
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new GenerationInputSchemaError(`generation input ${field} must be a non-negative integer`)
  return value as number
}

/** Validate the frozen prompt envelope immediately before provider I/O. */
export function assertGenerationInput(input: unknown, expectedWorkspaceId: string, expectedActionId: string, expectedRunKey: string): ContentGenerationInput {
  const root = record(input)
  if (!root) throw new GenerationInputSchemaError('generation input must be an object')
  const platform = requiredString(root.platform, 'platform')
  const directionId = requiredString(root.directionId, 'directionId')
  const product = record(root.product)
  if (!product) throw new GenerationInputSchemaError('generation input product is required')
  const title = requiredString(product.title, 'product.title')
  if (product.id !== undefined) requiredString(product.id, 'product.id')
  const stock = nonNegativeInteger(product.stock, 'product.stock')
  const skuCount = nonNegativeInteger(product.skuCount, 'product.skuCount')
  if (product.skuIds !== undefined) {
    if (!Array.isArray(product.skuIds) || product.skuIds.some(value => typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value))) throw new GenerationInputSchemaError('generation input product.skuIds contains an invalid frozen SKU reference')
    if (new Set(product.skuIds.map(value => (value as string).trim())).size !== product.skuIds.length) throw new GenerationInputSchemaError('generation input product.skuIds must be unique')
  }
  const facts = stringList(root.confirmedFactSourceIds, 'confirmedFactSourceIds', { min: 1, unique: true })
  const usage = record(root.usageContext)
  if (!usage || usage.workspaceId !== expectedWorkspaceId || usage.actionId !== expectedActionId || usage.runKey !== expectedRunKey) throw new GenerationInputSchemaError('generation input usageContext does not match the durable event')
  if (root.referenceAssets !== undefined && (!Array.isArray(root.referenceAssets) || root.referenceAssets.some(value => {
    const asset = record(value)
    if (!asset || typeof asset.id !== 'string' || !asset.id.trim() || /[\u0000-\u001f\u007f]/u.test(asset.id) || !Number.isSafeInteger(asset.revision) || (asset.revision as number) < 1) return true
    if (asset.preference !== undefined) {
      const preference = record(asset.preference)
      if (!preference || (preference.verdict !== 'excellent' && preference.verdict !== 'disliked') || !Array.isArray(preference.reasons) || preference.reasons.length === 0 || preference.reasons.some(reason => typeof reason !== 'string' || !reason.trim() || /[\u0000-\u001f\u007f]/u.test(reason))) return true
      if (preference.note !== undefined && (typeof preference.note !== 'string' || /[\u0000-\u001f\u007f]/u.test(preference.note))) return true
    }
    return false
  }))) throw new GenerationInputSchemaError('generation input referenceAssets contains an invalid frozen asset reference')
  if (root.promotions !== undefined && (!Array.isArray(root.promotions) || root.promotions.some(value => {
    const promotion = record(value)
    if (!promotion) return true
    try {
      requiredString(promotion.kind, 'promotions.kind')
      requiredString(promotion.label, 'promotions.label')
      stringList(promotion.skuIds, 'promotions.skuIds', { min: 1, unique: true })
      for (const field of ['validFrom', 'validTo'] as const) if (promotion[field] !== undefined) requiredString(promotion[field], `promotions.${field}`)
      for (const field of ['originalPriceCny', 'priceCny', 'couponPriceCny', 'depositCny', 'balanceCny', 'giftValueCny'] as const) if (promotion[field] !== undefined && (typeof promotion[field] !== 'number' || !Number.isFinite(promotion[field]) || promotion[field] < 0)) throw new GenerationInputSchemaError(`generation input promotions.${field} must be a non-negative number`)
      if (promotion.giftDescription !== undefined) requiredString(promotion.giftDescription, 'promotions.giftDescription')
      return false
    } catch { return true }
  }))) throw new GenerationInputSchemaError('generation input promotions contains an invalid frozen promotion')
  if (root.knowledgeContext !== undefined) {
    const knowledge = record(root.knowledgeContext)
    if (!knowledge || !Array.isArray(knowledge.rules) || !Array.isArray(knowledge.assets) || !Array.isArray(knowledge.confirmedLearningSuggestions)) throw new GenerationInputSchemaError('generation input knowledgeContext is malformed')
    for (const rule of knowledge.rules) {
      const item = record(rule)
      if (!item) throw new GenerationInputSchemaError('generation input knowledgeContext.rules contains an invalid rule')
      requiredString(item.id, 'knowledgeContext.rules.id'); requiredString(item.content, 'knowledgeContext.rules.content'); requiredString(item.version, 'knowledgeContext.rules.version'); requiredString(item.sourceReference, 'knowledgeContext.rules.sourceReference')
    }
    for (const asset of knowledge.assets) {
      const item = record(asset)
      if (!item || item.confirmed !== false || !['brand', 'customer'].includes(String(item.kind))) throw new GenerationInputSchemaError('generation input knowledgeContext.assets contains an invalid reference-only asset')
      requiredString(item.id, 'knowledgeContext.assets.id'); requiredString(item.name, 'knowledgeContext.assets.name'); nonNegativeInteger(item.revision, 'knowledgeContext.assets.revision')
    }
  }
  return { ...input as ContentGenerationInput, platform, directionId, product: { ...input as ContentGenerationInput['product'], title, stock, skuCount }, confirmedFactSourceIds: facts }
}
