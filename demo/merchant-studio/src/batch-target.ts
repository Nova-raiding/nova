import type { PlatformId, Product } from './api.js'

export type BatchTargetIdentity = {
  productId: string
  platform: PlatformId
  accountId?: string
  listingId?: string
}

export type ProjectedProductTarget = BatchTargetIdentity & {
  title: string
  remoteId?: string
  storeName?: string
  brandId?: string
  canonicalProductId?: string
}

/**
 * Keep the server-owned product → brand → listing scope attached while a
 * product moves through the Studio's selection state. The API exposes the
 * canonical scope under `canonical_scope`; dropping it here makes a valid
 * batch look unbranded before the request reaches the API.
 */
export function projectProductTarget(product: Pick<Product, 'id' | 'platform' | 'title' | 'remoteId' | 'accountId' | 'storeName' | 'brandId' | 'canonical_scope'>): ProjectedProductTarget {
  return {
    productId: product.id,
    platform: product.platform,
    title: product.title,
    remoteId: product.remoteId,
    accountId: product.accountId,
    storeName: product.storeName,
    brandId: product.brandId ?? product.canonical_scope?.brand_id ?? undefined,
    canonicalProductId: product.canonical_scope?.canonical_product_id ?? undefined,
    listingId: product.canonical_scope?.listing_id ?? undefined,
  }
}

export function projectProductRowTarget(product: {
  id: string
  platformId: PlatformId
  title: string
  remoteId?: string
  accountId?: string
  storeName?: string
  brandId?: string
  canonicalProductId?: string
  listingId?: string
}): ProjectedProductTarget {
  return {
    productId: product.id,
    platform: product.platformId,
    title: product.title,
    remoteId: product.remoteId,
    accountId: product.accountId,
    storeName: product.storeName,
    brandId: product.brandId,
    canonicalProductId: product.canonicalProductId,
    listingId: product.listingId,
  }
}

export function batchTargetKey(target: BatchTargetIdentity): string {
  return [target.productId, target.platform, target.accountId ?? '', target.listingId ?? ''].join(':')
}

export function toggleBatchTarget<T extends BatchTargetIdentity>(current: T[], target: T): T[] {
  const key = batchTargetKey(target)
  return current.some(item => batchTargetKey(item) === key)
    ? current.filter(item => batchTargetKey(item) !== key)
    : [...current, target]
}
