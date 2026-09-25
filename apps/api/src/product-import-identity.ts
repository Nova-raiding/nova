import { DomainError, type Platform } from '../../../packages/application/src/service.js'

type ProductImportIdentityInput = { platform: Platform; accountId?: string; remoteId?: string; localProductKey?: string; title: string; storeName?: string }

export function productImportIdentity(input: ProductImportIdentityInput) {
  const remoteId = input.remoteId?.trim()
  if (remoteId) return `${input.platform}:account=${input.accountId ?? ''}:remote=${remoteId}`
  const localKey = input.localProductKey?.trim() || `${input.accountId ?? (input.storeName?.trim() || '导入店铺')}:${input.title.trim()}`
  return `${input.platform}:account=${input.accountId ?? ''}:local=${localKey}`
}

export function assertUniqueBatchProductImportIdentities(items: ProductImportIdentityInput[]) {
  const seen = new Map<string, number>()
  const duplicates: Array<{ identity: string; first_index: number; duplicate_index: number }> = []
  for (const [index, item] of items.entries()) {
    const identity = productImportIdentity(item)
    const firstIndex = seen.get(identity)
    if (firstIndex !== undefined) duplicates.push({ identity, first_index: firstIndex + 1, duplicate_index: index + 1 })
    else seen.set(identity, index)
  }
  if (duplicates.length) throw new DomainError('PRODUCT_IMPORT_IDENTITY_CONFLICT', '批量导入包含重复商品身份，已在写入前阻断', 409, { duplicates })
}
