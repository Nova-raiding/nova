import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BrandVisualRules } from '../../../packages/application/src/service.js'
import type { assetHttpRuntime } from './server.js'

type AssetHttpRuntime = ReturnType<typeof assetHttpRuntime>

export async function routeBrandProfileHttp(req: IncomingMessage, res: ServerResponse, path: string, runtime: AssetHttpRuntime): Promise<void> {
  const { body, resolveWorkspace, enforceBrandProfileHttpAccess, service, brandProfileWithUnit, send, DomainError, ERROR_CODES, isObject, required, persistSnapshot, persistEvent } = runtime
  if (req.method === 'GET' && path === '/v1/brand-profile') {
    const workspaceId = resolveWorkspace(req)
    await enforceBrandProfileHttpAccess(req, workspaceId)
    const currentProfile = service.getBrandProfile(workspaceId)
    return send(res, 200, workspaceId, { profile: currentProfile ? await brandProfileWithUnit(workspaceId, currentProfile, false) : null }, null, req)
  }
  if (req.method === 'POST' && path === '/v1/brand-profile/extract') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    await enforceBrandProfileHttpAccess(req, workspaceId)
    const assetIds = input.asset_ids === undefined ? undefined : Array.isArray(input.asset_ids) && input.asset_ids.length > 0 && input.asset_ids.length <= 50 && input.asset_ids.every(value => typeof value === 'string' && value.trim()) ? input.asset_ids.map(value => String(value).trim()) : null
    if (assetIds === null) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids 必须是 1～50 个素材 ID 的字符串数组', 400)
    return send(res, 200, workspaceId, service.extractBrandProfile(workspaceId, assetIds), null, req)
  }
  if (req.method === 'PUT' && path === '/v1/brand-profile') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    await enforceBrandProfileHttpAccess(req, workspaceId, true)
    const tone = Array.isArray(input.tone) ? input.tone.filter((value): value is string => typeof value === 'string') : undefined
    const forbiddenTerms = Array.isArray(input.forbidden_terms) ? input.forbidden_terms.filter((value): value is string => typeof value === 'string') : undefined
    const details = isObject(input.details) ? input.details : undefined
    const visualRules = isObject(input.visual_rules) ? input.visual_rules as unknown as BrandVisualRules : undefined
    if (input.visual_rules !== undefined && !visualRules) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_rules 必须是对象', 400)
    const resolutions = isObject(input.conflict_resolutions) && Object.values(input.conflict_resolutions).every(value => value === 'existing' || value === 'candidate') ? input.conflict_resolutions as Record<string, 'existing' | 'candidate'> : undefined
    if (input.conflict_resolutions !== undefined && !resolutions) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'conflict_resolutions 必须是字段到 existing/candidate 的对象', 400)
    const profile = service.upsertBrandProfile({ workspaceId, name: required(input, 'name'), ...(typeof input.positioning === 'string' ? { positioning: input.positioning } : {}), ...(typeof input.audience === 'string' ? { audience: input.audience } : {}), ...(tone ? { tone } : {}), ...(forbiddenTerms ? { forbiddenTerms } : {}), ...(details ? { details } : {}), ...(visualRules ? { visualRules } : {}), ...(typeof input.source === 'string' ? { source: input.source } : {}), ...(resolutions ? { resolutions } : {}) })
    const linkedProfile = await brandProfileWithUnit(workspaceId, profile)
    await persistSnapshot(workspaceId, 'brand_profile', linkedProfile, linkedProfile as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, linkedProfile.id, 'brand_profile.updated', linkedProfile.revision, { brand_profile_id: linkedProfile.id, brand_unit_id: linkedProfile.brandUnitId, revision: linkedProfile.revision, source: typeof input.source === 'string' ? input.source : 'merchant_studio' })
    return send(res, 200, workspaceId, linkedProfile, null, req)
  }
}
