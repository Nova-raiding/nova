import { err, ok, type Result } from './result.js'
import type { DomainRuntime } from './clock.js'

export interface ContentBody {
  readonly title: string
  readonly detail: string
  readonly sellingPoints: readonly string[]
  readonly modules?: readonly ContentModule[]
  readonly brief?: StaticBrief
}

export interface ContentModule {
  readonly key: string
  readonly title: string
  readonly purpose: string
  readonly body: string
  readonly factSourceIds: readonly string[]
  readonly contentKind?: 'fact' | 'creative' | 'pending'
  readonly pendingReason?: string
  readonly imageGuidance?: string
}

export interface StaticBrief {
  readonly platform: string
  readonly placement: string
  readonly targetDimensions: string
  readonly visualHierarchy: readonly string[]
  readonly productImageGuidance: string
  readonly logoSafety: string
  readonly headline: string
  readonly subheadline: string
  readonly coreSellingPoint: string
  readonly priceExpression?: string
  readonly cta: string
  readonly textDensity: string
  readonly safeArea: string
  readonly protectedAreas: readonly string[]
}

export interface ContentVersion {
  readonly id: string
  readonly taskId: string
  readonly version: number
  readonly parentId?: string
  readonly body: ContentBody
  readonly state: 'draft' | 'review_required' | 'approved' | 'delivered'
  readonly createdAt: string
  readonly createdBy: string
  readonly reason: string
}

const freezeBody = (body: ContentBody): ContentBody => Object.freeze({ ...body, sellingPoints: Object.freeze([...body.sellingPoints]), ...(body.modules ? { modules: Object.freeze(body.modules.map(module => Object.freeze({ ...module, factSourceIds: Object.freeze([...module.factSourceIds]) }))) } : {}), ...(body.brief ? { brief: Object.freeze({ ...body.brief, visualHierarchy: Object.freeze([...body.brief.visualHierarchy]), protectedAreas: Object.freeze([...body.brief.protectedAreas]) }) } : {}) })

const create = (input: Omit<ContentVersion, 'body'> & { body: ContentBody }): ContentVersion =>
  Object.freeze({ ...input, body: freezeBody(input.body) })

export const createContentVersion = (
  input: { taskId: string; body: ContentBody; createdBy: string; reason: string },
  runtime: DomainRuntime,
): ContentVersion => create({
  id: runtime.nextId('cv'), taskId: input.taskId, version: 1, body: input.body,
  state: 'draft', createdAt: runtime.now(), createdBy: input.createdBy, reason: input.reason,
})

export const createChildContentVersion = (
  parent: ContentVersion,
  input: { body: ContentBody; createdBy: string; reason: string; version: number },
  runtime: DomainRuntime,
): Result<ContentVersion> => {
  if (input.version <= parent.version) return err('CONTENT_VERSION_INVALID', 'child version must be greater than its parent')
  return ok(create({
    id: runtime.nextId('cv'), taskId: parent.taskId, version: input.version, parentId: parent.id,
    body: input.body, state: 'draft', createdAt: runtime.now(), createdBy: input.createdBy, reason: input.reason,
  }))
}

export const restoreContentVersion = (
  target: ContentVersion,
  nextVersion: number,
  restoredBy: string,
  runtime: DomainRuntime,
): Result<ContentVersion> => createChildContentVersion(target, {
  version: nextVersion, body: target.body, createdBy: restoredBy, reason: `restore:${target.id}`,
}, runtime)

export const approveContentVersion = (version: ContentVersion): Result<ContentVersion> => {
  if (version.state !== 'review_required') return err('CONTENT_VERSION_INVALID', 'only review_required content can be approved')
  return ok(Object.freeze({ ...version, state: 'approved' as const }))
}

export const submitContentVersionForReview = (version: ContentVersion): Result<ContentVersion> => {
  if (version.state !== 'draft') return err('CONTENT_VERSION_INVALID', 'only draft content can enter review')
  return ok(Object.freeze({ ...version, state: 'review_required' as const }))
}

export const markContentVersionDelivered = (version: ContentVersion): Result<ContentVersion> => {
  if (version.state !== 'approved') return err('CONTENT_VERSION_INVALID', 'only approved content can be delivered')
  return ok(Object.freeze({ ...version, state: 'delivered' as const }))
}
