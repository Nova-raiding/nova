import type { ContentGenerationInput } from '../../../packages/ai/src/generator.js'

export class GenerationInputSchemaError extends Error {
  readonly code = 'GENERATION_INPUT_SCHEMA_INVALID'
  constructor(message: string) { super(message); this.name = 'GenerationInputSchemaError' }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new GenerationInputSchemaError(`generation input ${field} is required`)
  return value.trim()
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
  const stock = nonNegativeInteger(product.stock, 'product.stock')
  const skuCount = nonNegativeInteger(product.skuCount, 'product.skuCount')
  const facts = root.confirmedFactSourceIds
  if (!Array.isArray(facts) || facts.length === 0 || facts.some(value => typeof value !== 'string' || !value.trim())) throw new GenerationInputSchemaError('generation input confirmedFactSourceIds must contain at least one non-empty reference')
  const usage = record(root.usageContext)
  if (!usage || usage.workspaceId !== expectedWorkspaceId || usage.actionId !== expectedActionId || usage.runKey !== expectedRunKey) throw new GenerationInputSchemaError('generation input usageContext does not match the durable event')
  if (root.referenceAssets !== undefined && (!Array.isArray(root.referenceAssets) || root.referenceAssets.some(value => {
    const asset = record(value)
    return !asset || typeof asset.id !== 'string' || !asset.id.trim() || !Number.isSafeInteger(asset.revision) || (asset.revision as number) < 1
  }))) throw new GenerationInputSchemaError('generation input referenceAssets contains an invalid frozen asset reference')
  return { ...input as ContentGenerationInput, platform, directionId, product: { ...input as ContentGenerationInput['product'], title, stock, skuCount }, confirmedFactSourceIds: facts.map(value => (value as string).trim()) }
}
