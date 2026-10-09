import type { CommercialOperationPolicy } from './commercial-access.js'

/** Registered capabilities whose consumers below are existing enabled paths.
 * HTTP routes inherit their exact MCP authorization reference. No prefix matching. */
export const COMMERCIAL_FEATURE_DEFINITIONS = [
  { code: 'feature.content_generation', name: '内容生成', unit: 'permission', consumer: 'commercial-access/content-generation', methods: ['content.generate', 'content.draft.generate'] },
  { code: 'feature.image_generation', name: '图片生成与编辑', unit: 'permission', consumer: 'commercial-access/image-generation', methods: ['catalog.image.generate', 'multimodal.image.edit'] },
  { code: 'feature.video_generation', name: '视频生成', unit: 'permission', consumer: 'commercial-access/video-generation', methods: ['multimodal.video.request', 'multimodal.video.get'] },
  { code: 'feature.knowledge', name: '知识库', unit: 'permission', consumer: 'commercial-access/knowledge', methods: ['knowledge.rule.create', 'knowledge.rule.list', 'knowledge.asset.create', 'knowledge.asset.update', 'knowledge.asset.list', 'knowledge.product.list', 'knowledge.product.update', 'knowledge.brand.preference.get', 'knowledge.brand.preference.update', 'knowledge.feedback.record', 'knowledge.learning.list', 'knowledge.learning.confirm', 'knowledge.learning.dismiss', 'knowledge.competitor.create', 'knowledge.competitor.list', 'knowledge.competitor.reference'] },
  { code: 'feature.automation', name: '自动化', unit: 'permission', consumer: 'commercial-access/automation', methods: ['automation.policy.get', 'automation.policy.list', 'automation.policy.update', 'automation.pause', 'automation.scan', 'automation.tick'] },
  { code: 'feature.publish', name: '发布', unit: 'permission', consumer: 'commercial-access/publish', methods: ['publish.prepare', 'publish.batch.prepare', 'publish.batch.confirm', 'publish.batch.get', 'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed', 'publish.confirm', 'publish.get', 'publish.manual.get', 'publish.manual.list'] },
] as const
export type CommercialFeatureCode = (typeof COMMERCIAL_FEATURE_DEFINITIONS)[number]['code']
export const COMMERCIAL_FEATURE_CODES: readonly CommercialFeatureCode[] = COMMERCIAL_FEATURE_DEFINITIONS.map(definition => definition.code)
export type CommercialFeatureModality = 'text' | 'image' | 'video'
const modalities: Record<CommercialFeatureModality, CommercialFeatureCode> = {
  text: 'feature.content_generation', image: 'feature.image_generation', video: 'feature.video_generation',
}
const workerFeatures: Readonly<Record<string, readonly CommercialFeatureCode[]>> = {
  'generation.execute': ['feature.content_generation'],
  'image_generation.execute': ['feature.image_generation'],
  'publish.execute': ['feature.publish'],
  'automation.tick.execute': ['feature.automation'],
  'knowledge.embedding.execute': ['feature.knowledge'],
}

export function requiredCommercialFeatures(policy: CommercialOperationPolicy, validatedModality?: CommercialFeatureModality): readonly CommercialFeatureCode[] {
  if (policy.domain !== 'COMMERCIAL' || !policy.enabled || policy.classification === 'RECOVERY_CONTROL') return []
  const method = policy.surface === 'HTTP' ? policy.authorization_policy_ref : policy.operation
  if (method === 'multimodal.generate' || (policy.surface === 'WORKER' && policy.operation === 'generation.execute')) {
    // An unclassified shared generator cannot silently select text permissions.
    // API/Worker passes modality only after its existing input/job validation.
    return validatedModality ? [modalities[validatedModality]] : ['feature.content_generation', 'feature.image_generation', 'feature.video_generation']
  }
  if (policy.surface === 'WORKER') return workerFeatures[policy.operation] ?? []
  return COMMERCIAL_FEATURE_DEFINITIONS.filter(definition => (definition.methods as readonly string[]).includes(method ?? '')).map(definition => definition.code)
}
