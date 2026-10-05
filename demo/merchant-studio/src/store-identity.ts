import type { Product, Task } from './api'

export interface StoreIdentity {
  accountId?: string
  storeName?: string
}

const normalized = (value?: string) => value?.trim() ?? ''

export function storeIdentityLabel(identity: StoreIdentity): string {
  return `${normalized(identity.storeName)} · 店铺身份已确认`
}

export function validateTargetStoreIdentity(target: StoreIdentity): string | null {
  if (!normalized(target.storeName) || !normalized(target.accountId)) {
    return '目标商品缺少完整店铺身份，已阻止继续操作。请重新同步商品后再试。'
  }
  return null
}

export function validateProductStoreIdentity(target: StoreIdentity, product: StoreIdentity): string | null {
  const targetError = validateTargetStoreIdentity(target)
  if (targetError) return targetError
  if (!normalized(product.storeName) || !normalized(product.accountId)) {
    return '商品事实缺少完整店铺身份，已阻止继续操作。请重新同步商品后再试。'
  }
  if (normalized(target.accountId) !== normalized(product.accountId) || normalized(target.storeName) !== normalized(product.storeName)) {
    return '店铺身份与最新商品事实不一致，已阻止继续操作。请返回商品列表重新选择。'
  }
  return null
}

export function validateTaskStoreIdentity(target: StoreIdentity, task: StoreIdentity): string | null {
  const targetError = validateTargetStoreIdentity(target)
  if (targetError) return targetError
  if (!normalized(task.accountId)) {
    return '任务缺少稳定的店铺身份，已阻止继续操作。请重新创建任务。'
  }
  if (normalized(target.accountId) !== normalized(task.accountId)) {
    return '任务店铺账号与所选商品不一致，已阻止继续操作。请返回商品列表重新选择。'
  }
  return null
}

/** Only server-declared candidate tasks may restore without a store. Publishing keeps its separate strict guard. */
export function validateTaskRestoreIdentity(target: StoreIdentity, product: Product, task: Task): string | null {
  if (task.productId !== product.id || task.platform !== product.platform || !task.workspaceId || task.workspaceId !== product.workspaceId) {
    return '任务与商品或工作区身份不一致，已阻止恢复任务。'
  }
  if (task.candidateOnly !== true) {
    return validateProductStoreIdentity(target, product) ?? validateTaskStoreIdentity(target, task)
  }
  if (!product.factsConfirmed || target.accountId || task.accountId || product.accountId || task.brandId || product.brandId
    || task.canonicalProductId || task.listingId || task.campaignId || task.campaignItemId
    || (product.remoteId && product.source !== 'csv')) {
    return '候选任务包含不兼容的店铺或商品绑定，已阻止恢复任务。'
  }
  return null
}
