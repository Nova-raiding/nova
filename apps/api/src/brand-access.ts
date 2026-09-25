import type { IncomingMessage } from 'node:http'
import { DomainError, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES, canonicalizeRole } from '../../../packages/contracts/src/index.js'
import type { BrandAccessRole } from '../../../packages/persistence/src/index.js'
import { localComposeOpsCustomerDataAccess } from './customer-data-access.js'
import type { ApiPersistence, RequestPrincipal } from './server.js'

export interface BrandAccessDependencies {
  principal(req: IncomingMessage): RequestPrincipal | undefined
  brandUnits(): NonNullable<ApiPersistence['brandUnits']>
  requiresStrictAuth(): boolean
  rememberProviderResourceAccess(req: IncomingMessage, scope: readonly string[], recheck: () => Promise<void>): void
  platformLabels: Record<Platform, string>
}

export function createBrandAccess(deps: BrandAccessDependencies) {
  function hasWorkspaceWideBrandAccess(req: IncomingMessage) {
    const principal = deps.principal(req)
    const role = principal?.memberRole ? canonicalizeRole(principal.memberRole, 'membership') : undefined
    if (role === 'workspace_owner' || role === 'workspace_admin') return true
    return localComposeOpsCustomerDataAccess()
      && (principal?.roles ?? []).some(candidate => candidate === 'workspace_owner' || candidate === 'merchant_admin' || candidate === 'platform_ops')
  }

  async function assertBrandAccess(req: IncomingMessage, workspaceId: string, brandId: string, minimumRole: BrandAccessRole) {
    if (!deps.requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)) return
    const principal = deps.principal(req)
    if (!principal?.actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '品权限校验缺少成员身份', 401)
    const allowed = await deps.brandUnits().hasBrandAccess({ workspaceId, brandId, externalSubject: principal.actorId, minimumRole })
    if (!allowed) throw new DomainError('BRAND_ACCESS_REQUIRED', '当前成员没有该品所需权限', 403, { brand_id: brandId, required_role: minimumRole })
  }

  async function enforceBrandAccess(req: IncomingMessage, workspaceId: string, brandId: string, minimumRole: BrandAccessRole = 'viewer') {
    await assertBrandAccess(req, workspaceId, brandId, minimumRole)
    deps.rememberProviderResourceAccess(req, ['brand', workspaceId, brandId, minimumRole], () => assertBrandAccess(req, workspaceId, brandId, minimumRole))
  }

  async function filterByBrandAccess<T>(req: IncomingMessage, workspaceId: string, rows: T[], brandIdOf: (row: T) => string, minimumRole: BrandAccessRole = 'viewer'): Promise<T[]> {
    if (!deps.requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)) return rows
    const actorId = deps.principal(req)?.actorId
    if (!actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '品权限筛选缺少成员身份', 401)
    const grantedBrandIds = await deps.brandUnits().hasBrandAccessMany({ workspaceId, brandIds: rows.map(brandIdOf), externalSubject: actorId, minimumRole })
    return rows.filter(row => grantedBrandIds.has(brandIdOf(row)))
  }

  async function accessibleBrandNavigation(req: IncomingMessage, workspaceId: string) {
    const brands = await deps.brandUnits().listBrands({ workspaceId })
    const visible = await filterByBrandAccess(req, workspaceId, brands, brand => brand.id)
    return visible.map(brand => ({
      id: brand.id,
      title: brand.name,
      revision: brand.revision,
      action: { method: 'brand-unit.listing.list', arguments: { brand_id: brand.id } },
      platforms: Object.entries(brand.storeBindings.reduce<Record<string, typeof brand.storeBindings>>((groups, store) => { (groups[store.platform] ??= []).push(store); return groups }, {})).map(([platform, stores]) => ({
        id: `${brand.id}:${platform}`,
        platform,
        title: deps.platformLabels[platform as Platform] ?? platform,
        stores: stores.map(store => ({
          id: `${brand.id}:${store.platform}:${store.accountId}`,
          accountId: store.accountId,
          action: { method: 'brand-unit.listing.list', arguments: { brand_id: brand.id, platform: store.platform, account_id: store.accountId } },
        })),
      })),
    }))
  }

  return { hasWorkspaceWideBrandAccess, assertBrandAccess, enforceBrandAccess, filterByBrandAccess, accessibleBrandNavigation }
}
