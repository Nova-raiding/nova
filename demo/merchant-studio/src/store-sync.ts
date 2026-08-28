import type { PlatformAccount, PlatformId } from './api'

export type StoreSyncTarget = {
  platform: PlatformId
  accountId: string
  label: string
}

export type StoreSyncResolution =
  | { ok: true; targets: StoreSyncTarget[] }
  | { ok: false; message: string }

export function resolveStoreSyncTargets(accounts: PlatformAccount[] | null): StoreSyncResolution {
  if (accounts === null) {
    return { ok: false, message: '店铺列表尚未读取成功，已停止同步。请先重试店铺发现。' }
  }

  const readable = accounts.filter(account => account.readEnabled)
  if (!readable.length) {
    return { ok: false, message: '没有发现已授权且可读取的店铺，未发起任何同步。' }
  }

  const unidentified = readable.filter(account => !account.accountId?.trim())
  if (unidentified.length) {
    return { ok: false, message: `发现 ${unidentified.length} 家可读取店铺缺少店铺 ID，已停止全部同步，避免同步到错误店铺。` }
  }

  const targets = new Map<string, StoreSyncTarget>()
  for (const account of readable) {
    const accountId = account.accountId!.trim()
    const key = `${account.platform}:${accountId}`
    targets.set(key, {
      platform: account.platform,
      accountId,
      label: account.label ?? account.alias ?? account.storeName ?? accountId,
    })
  }

  return { ok: true, targets: [...targets.values()] }
}
