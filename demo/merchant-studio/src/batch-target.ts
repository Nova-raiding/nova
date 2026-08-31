export type BatchTargetIdentity = {
  productId: string
  platform: string
  accountId?: string
  listingId?: string
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
