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
  readonly decisionContract?: {
    readonly buyerQuestion: string
    readonly pageTask: string
    readonly claim: { readonly text: string; readonly factSourceIds: readonly string[]; readonly skuIds?: readonly string[]; readonly platforms: readonly string[]; readonly regions?: readonly string[]; readonly validUntil?: string; readonly limitations: readonly string[] }
    readonly evidence: { readonly type: 'real_image' | 'parameter' | 'test_report' | 'comparison' | 'usage_result' | 'manual_review'; readonly sourceIds: readonly string[]; readonly status: 'verified' | 'missing' | 'expired' | 'conflict' }
    readonly visualContract: { readonly requiredElements: readonly string[]; readonly protectedElements: readonly string[]; readonly prohibitedImplications: readonly string[]; readonly accessibilityText: string }
    readonly priority: number
    readonly optional: boolean
  }
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

const freezeDecisionContract = (contract: NonNullable<ContentModule['decisionContract']>): NonNullable<ContentModule['decisionContract']> => Object.freeze({
  ...contract,
  claim: Object.freeze({ ...contract.claim, factSourceIds: Object.freeze([...contract.claim.factSourceIds]), ...(contract.claim.skuIds ? { skuIds: Object.freeze([...contract.claim.skuIds]) } : {}), platforms: Object.freeze([...contract.claim.platforms]), ...(contract.claim.regions ? { regions: Object.freeze([...contract.claim.regions]) } : {}), limitations: Object.freeze([...contract.claim.limitations]) }),
  evidence: Object.freeze({ ...contract.evidence, sourceIds: Object.freeze([...contract.evidence.sourceIds]) }),
  visualContract: Object.freeze({ ...contract.visualContract, requiredElements: Object.freeze([...contract.visualContract.requiredElements]), protectedElements: Object.freeze([...contract.visualContract.protectedElements]), prohibitedImplications: Object.freeze([...contract.visualContract.prohibitedImplications]) }),
})

const freezeBody = (body: ContentBody): ContentBody => Object.freeze({ ...body, sellingPoints: Object.freeze([...body.sellingPoints]), ...(body.modules ? { modules: Object.freeze(body.modules.map(module => Object.freeze({ ...module, factSourceIds: Object.freeze([...module.factSourceIds]), ...(module.decisionContract ? { decisionContract: freezeDecisionContract(module.decisionContract) } : {}) }))) } : {}), ...(body.brief ? { brief: Object.freeze({ ...body.brief, visualHierarchy: Object.freeze([...body.brief.visualHierarchy]), protectedAreas: Object.freeze([...body.brief.protectedAreas]) }) } : {}) })

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
