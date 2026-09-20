import { createHash } from 'node:crypto'
import type { PlatformApiMethods, PlatformWriteDraft, RawProduct, RequestSigner, WriteIdentity, WriteReceipt, WriteStatus } from '../types.js'
import { mapPlatformRejection, platformEnvelope, providerRequestId } from './rejection.js'
import { PLATFORM_API_SELECTORS, resolveApiSelector } from './api-selector.js'
import { applySignedRequest } from './signed-request.js'

export interface PinduoduoSignerOptions {
  clientId: string
  clientSecret: string
  now?: () => Date
  /**
   * Explicit Pinduoduo API selector (`type`) per connector operation, for
   * example `{ sync: 'pdd.goods.list.get', create: 'pdd.goods.add' }`. The
   * router selects the API with this form parameter, so it cannot come from the
   * URL path; the connector supplies it from `api.methods`.
   */
  methods?: PlatformApiMethods
}

/**
 * Pinduoduo router signer. The router `type` (the API selector) is read from
 * the connector configuration for the operation in flight — the generic
 * connector cannot supply it in the URL, whose path is a relative API path
 * without a query string.
 */
export function createPinduoduoSigner(options: PinduoduoSignerOptions): RequestSigner {
  if (!options.clientId.trim() || !options.clientSecret.trim()) throw new Error('PDD client id and client secret are required')
  return {
    kind: 'platform',
    requiredApiSelectors: PLATFORM_API_SELECTORS,
    sign(request) {
      const url = new URL(request.url)
      const params: Record<string, string> = {}
      for (const [key, value] of url.searchParams.entries()) params[key] = value
      if (request.body) {
        try {
          const body = JSON.parse(request.body) as Record<string, unknown>
          for (const [key, value] of Object.entries(body)) if (value !== undefined && value !== null) params[key] = typeof value === 'string' ? value : JSON.stringify(value)
        } catch { /* form body is already represented by query parameters */ }
      }
      // Assigned last, so neither a query parameter nor a business field can
      // redirect the call to another Pinduoduo API.
      params.type = resolveApiSelector(request, options.methods, { signer: 'Pinduoduo router', parameter: 'type' })
      params.client_id = options.clientId
      params.timestamp = String(Math.floor((options.now ?? (() => new Date()))().getTime() / 1000))
      params.data_type = params.data_type ?? 'JSON'
      if (request.credential?.accessToken) params.access_token = request.credential.accessToken
      delete params.sign
      const canonical = Object.keys(params).sort().map(key => `${key}${params[key]}`).join('')
      params.sign = createHash('md5').update(`${options.clientSecret}${canonical}${options.clientSecret}`, 'utf8').digest('hex').toUpperCase()
      // The read path (`pdd.goods.list.get` and friends) is dispatched as GET;
      // a form body there is rejected by `fetch` before any network call.
      applySignedRequest(request, url, params)
      return {}
    },
  }
}

/** Pinduoduo's open API quotes prices in fen (`min_group_price: 1299` is
 * 12.99 yuan), so the conversion is unconditional. The previous
 * `> 1000 ? /100 : /1` heuristic was not monotonic — 990 fen stayed 990,
 * 1000 fen stayed 1000 and 1001 fen became 10.01 — so every product at or
 * below 10.00 yuan was imported at 100x its real price. */
const fenToYuan = (value: unknown): number => numberValue(value) / 100

export function mapPinduoduoProducts(payload: unknown): RawProduct[] {
  const root = record(payload)
  const envelope = firstRecord(root?.goods_search_response, root?.goods_detail_response, root?.result)
  const candidates = arrayOf(envelope?.goods_list ?? envelope?.goods_detail_list ?? root?.goods_list ?? root?.items)
  return candidates.map((item, index) => ({
    remoteId: stringValue(item.goods_sign) ?? stringValue(item.goods_id) ?? `pdd-item-${index}`,
    title: stringValue(item.goods_name) ?? stringValue(item.title) ?? '', description: stringValue(item.goods_desc) ?? stringValue(item.description) ?? '',
    price: fenToYuan(item.min_group_price ?? item.min_normal_price ?? item.price),
    stock: numberValue(item.stock ?? item.quantity), sku: [], images: strings(item.goods_image_url ? [item.goods_image_url] : item.goods_image_urls), category: stringValue(item.cat_id) ?? '', attributes: {}, platformFields: item, observedAt: new Date().toISOString(),
  }))
}

export function mapPinduoduoWriteReceipt(payload: unknown, input: PlatformWriteDraft, operation: 'create' | 'update'): WriteReceipt {
  const root = platformEnvelope(payload)
  return { platform: 'pinduoduo', operation, remoteId: stringValue(root?.goods_sign) ?? stringValue(root?.goods_id) ?? input.remoteId ?? '', requestId: providerRequestId(payload) ?? '', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }
}

export function mapPinduoduoWriteStatus(payload: unknown, _request: WriteIdentity): WriteStatus {
  const root = platformEnvelope(payload)
  const remoteId = stringValue(root?.goods_sign) ?? stringValue(root?.goods_id)
  const rejection = mapPlatformRejection(payload)
  const state = ['submitted', 'published', 'rejected', 'unknown'].includes(String(root?.state)) ? String(root?.state) as WriteStatus['state'] : rejection ? 'rejected' : root?.success === true ? 'submitted' : 'unknown'
  const requestId = providerRequestId(payload)
  return { found: root?.found === true || Boolean(remoteId) || state === 'rejected', state, ...(remoteId ? { remoteId } : {}), ...(requestId ? { requestId } : {}), simulated: false, ...(rejection ? { rejection } : {}) }
}

function record(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined }
function firstRecord(...values: unknown[]): Record<string, any> | undefined { return values.map(record).find(Boolean) }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined }
function numberValue(value: unknown): number { const result = typeof value === 'number' ? value : Number(value); return Number.isFinite(result) ? result : 0 }
function arrayOf(value: unknown): Record<string, any>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(record(item))) : [] }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
