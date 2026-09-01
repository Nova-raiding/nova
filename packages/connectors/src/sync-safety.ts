import type { Cursor, Platform, RawProduct } from './types.js'

const MAX_CURSOR_LENGTH = 512

export interface SyncWindow {
  updatedSince?: string
  updatedUntil?: string
}

export class SyncContractError extends Error {
  readonly code = 'VALIDATION_FAILED' as const
  constructor(message: string) {
    super(message)
    this.name = 'SyncContractError'
  }
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && !/[\u0000-\u001f\u007f]/.test(value)
}

function cursorValue(cursor: Cursor | undefined): string | undefined {
  if (cursor === undefined) return undefined
  if (typeof cursor.value !== 'string' || cursor.value.length === 0 || cursor.value.length > MAX_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/.test(cursor.value)) {
    throw new SyncContractError('sync cursor is invalid')
  }
  return cursor.value
}

export function validateSyncWindow(window: SyncWindow | undefined): SyncWindow | undefined {
  if (!window) return undefined
  if (window.updatedSince !== undefined && (!validIso(window.updatedSince))) throw new SyncContractError('sync updatedSince is invalid')
  if (window.updatedUntil !== undefined && (!validIso(window.updatedUntil))) throw new SyncContractError('sync updatedUntil is invalid')
  if (window.updatedSince && window.updatedUntil && Date.parse(window.updatedSince) > Date.parse(window.updatedUntil)) throw new SyncContractError('sync time window is inverted')
  return window
}

export function validateSyncCursor(cursor: Cursor | undefined, previousCursor?: string): string | undefined {
  const value = cursorValue(cursor)
  if (value !== undefined && previousCursor !== undefined && value === previousCursor) throw new SyncContractError('sync cursor did not advance')
  return value
}

function stableProductValue(product: RawProduct): string {
  return JSON.stringify({
    remoteId: product.remoteId,
    title: product.title,
    description: product.description,
    price: product.price,
    stock: product.stock,
    sku: product.sku,
    images: product.images,
    category: product.category,
    attributes: product.attributes,
    platformFields: product.platformFields,
    listingStatus: product.listingStatus,
  })
}

export function deduplicateSyncProducts(items: RawProduct[], platform: Platform, window?: SyncWindow): RawProduct[] {
  const seen = new Map<string, string>()
  const result: RawProduct[] = []
  const since = window?.updatedSince ? Date.parse(window.updatedSince) : undefined
  const until = window?.updatedUntil ? Date.parse(window.updatedUntil) : undefined
  for (const item of items) {
    if (!item.remoteId || item.remoteId.length > 512 || /[\u0000-\u001f\u007f]/.test(item.remoteId)) throw new SyncContractError(`sync ${platform} product identity is invalid`)
    const observedAt = Date.parse(item.observedAt)
    if (!Number.isFinite(observedAt)) throw new SyncContractError(`sync ${platform} product timestamp is invalid`)
    if (since !== undefined && observedAt < since) throw new SyncContractError(`sync ${platform} product is outside updatedSince window`)
    if (until !== undefined && observedAt > until) throw new SyncContractError(`sync ${platform} product is outside updatedUntil window`)
    const fingerprint = stableProductValue(item)
    const previous = seen.get(item.remoteId)
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new SyncContractError(`sync ${platform} has conflicting duplicate product ${item.remoteId}`)
      continue
    }
    seen.set(item.remoteId, fingerprint)
    result.push(item)
  }
  return result
}

export function validateNextSyncCursor(nextCursor: Cursor | undefined, requestedCursor?: string): Cursor | undefined {
  const value = validateSyncCursor(nextCursor)
  if (value === undefined) return undefined
  if (requestedCursor !== undefined && value === requestedCursor) throw new SyncContractError('sync next cursor did not advance')
  return { value }
}
