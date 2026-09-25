import type { IncomingMessage } from 'node:http'
import { DomainError, type BrandVisualRules, type MerchantService } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { brandProfileWithUnit as brandProfileWithUnitHelper } from './brand-product-helpers.js'

type LinkedBrandProfile = Awaited<ReturnType<typeof brandProfileWithUnitHelper>>
type BrandProfile = NonNullable<ReturnType<MerchantService['getBrandProfile']>>

type Dependencies = {
  service: MerchantService
  required: (params: Record<string, unknown>, key: string) => string
  enforceBrandAccess: (req: IncomingMessage, workspaceId: string, brandUnitId: string, role: 'viewer' | 'editor') => Promise<unknown>
  brandProfileWithUnit: (workspaceId: string, profile: BrandProfile, ensure?: boolean) => Promise<LinkedBrandProfile>
  persistSnapshot: (workspaceId: string, entityType: 'brand_profile', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
}

export const MCP_BRAND_PROFILE_METHODS = new Set(['brand.get', 'brand.extract', 'brand.upsert', 'brand.tone.preview'])

export async function handleMcpBrandProfileMethod(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, dependencies: Dependencies): Promise<unknown> {
  const { service, required, enforceBrandAccess, brandProfileWithUnit, persistSnapshot, persistEvent } = dependencies
  if (method === 'brand.get') {
      const brandUnitId = typeof params.brand_unit_id === 'string' && params.brand_unit_id.trim() ? params.brand_unit_id.trim() : undefined
      if (brandUnitId) await enforceBrandAccess(req, workspaceId, brandUnitId, 'viewer')
      const profile = service.getBrandProfile(workspaceId, brandUnitId)
      return (profile ? await brandProfileWithUnit(workspaceId, profile, false) : null)
    }
  if (method === 'brand.extract') {
      let assetIds: string[] | undefined
      if (typeof params.asset_ids_json === 'string') {
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.length > 50 || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('asset_ids_json')
          assetIds = parsed.map(value => String(value).trim())
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是 1～50 个素材 ID 的字符串数组 JSON', 400) }
      }
      return (service.extractBrandProfile(workspaceId, assetIds))
    }
  if (method === 'brand.upsert') {
      const parseStringArray = (key: string) => {
        const value = params[key]
        if (value === undefined) return undefined
        if (typeof value !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是 JSON 数组`, 400)
        try { const parsed = JSON.parse(value); if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('invalid array'); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串数组 JSON`, 400) }
      }
      let details: Record<string, unknown> | undefined
      if (typeof params.details_json === 'string') {
        try { const parsed = JSON.parse(params.details_json); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('details_json'); details = parsed as Record<string, unknown> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'details_json 必须是 JSON 对象', 400) }
      }
      let visualRules: BrandVisualRules | undefined
      if (typeof params.visual_rules_json === 'string') {
        try { const parsed = JSON.parse(params.visual_rules_json); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('visual_rules_json'); visualRules = parsed as BrandVisualRules } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_rules_json 必须是 JSON 对象', 400) }
      }
      let resolutions: Record<string, 'existing' | 'candidate'> | undefined
      if (typeof params.conflict_resolutions_json === 'string') {
        try {
          const parsed = JSON.parse(params.conflict_resolutions_json)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => value !== 'existing' && value !== 'candidate')) throw new Error('conflict_resolutions_json')
          resolutions = parsed as Record<string, 'existing' | 'candidate'>
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'conflict_resolutions_json 必须是字段到 existing/candidate 的 JSON 对象', 400) }
      }
      const brandUnitId = typeof params.brand_unit_id === 'string' && params.brand_unit_id.trim() ? params.brand_unit_id.trim() : undefined
      if (brandUnitId) {
        await enforceBrandAccess(req, workspaceId, brandUnitId, 'editor')
      }
      const profile = service.upsertBrandProfile({ workspaceId, name: required(params, 'name'), ...(typeof params.positioning === 'string' ? { positioning: params.positioning } : {}), ...(typeof params.audience === 'string' ? { audience: params.audience } : {}), ...(parseStringArray('tone_json') ? { tone: parseStringArray('tone_json') } : {}), ...(parseStringArray('forbidden_terms_json') ? { forbiddenTerms: parseStringArray('forbidden_terms_json') } : {}), ...(details ? { details } : {}), ...(visualRules ? { visualRules } : {}), ...(brandUnitId ? { brandUnitId } : {}), ...(typeof params.source === 'string' ? { source: params.source } : {}), ...(resolutions ? { resolutions } : {}) })
      const linkedProfile = await brandProfileWithUnit(workspaceId, profile)
      await persistSnapshot(workspaceId, 'brand_profile', linkedProfile, linkedProfile as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, linkedProfile.id, 'brand_profile.updated', linkedProfile.revision, { brand_profile_id: linkedProfile.id, brand_unit_id: linkedProfile.brandUnitId, revision: linkedProfile.revision })
      return (linkedProfile)
    }
  if (method === 'brand.tone.preview') {
      return (service.previewBrandTone(workspaceId, { ...(typeof params.topic === 'string' ? { topic: params.topic } : {}), ...(typeof params.product_id === 'string' ? { productId: params.product_id } : {}) }))
    }
  throw new Error(`Unsupported brand profile MCP method: ${method}`)
}
