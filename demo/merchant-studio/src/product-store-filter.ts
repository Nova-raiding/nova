import type { PlatformId } from './api.js'

export type ProductStoreScope = { platform: PlatformId; accountId: string }

const platformIds = new Set<PlatformId>(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'])

/** A select value must preserve the platform part of the account's identity. */
export function productStoreScopeValue(scope: ProductStoreScope): string {
  return `${scope.platform}:${encodeURIComponent(scope.accountId)}`
}

/** Parse the UI's composite key back into the exact API scope. */
export function parseProductStoreScope(value: string): ProductStoreScope | null {
  const separator = value.indexOf(':')
  if (separator < 1) return null
  const platform = value.slice(0, separator)
  if (!platformIds.has(platform as PlatformId)) return null
  try {
    const accountId = decodeURIComponent(value.slice(separator + 1))
    return accountId ? { platform: platform as PlatformId, accountId } : null
  } catch {
    return null
  }
}

export function productStoreScopeQuery(scope: ProductStoreScope | null): Partial<ProductStoreScope> {
  return scope ? { platform: scope.platform, accountId: scope.accountId } : {}
}

export function productMatchesStoreScope(product: { platformId: string; accountId?: string }, scope: ProductStoreScope | null): boolean {
  return !scope || (product.platformId === scope.platform && product.accountId === scope.accountId)
}
