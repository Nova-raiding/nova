import { createHash } from 'node:crypto'
import type { PlatformWriteDraft, RawProduct, RequestSigner, WriteIdentity, WriteReceipt, WriteStatus } from '../types.js'
import { mapPlatformRejection, platformEnvelope, providerRequestId } from './rejection.js'

export interface JdSignerOptions {
  appKey: string
  appSecret: string
  now?: () => Date
}

/** JD Open Platform routerjson signer. Values are signed before URL encoding. */
export function createJdSigner(options: JdSignerOptions): RequestSigner {
  if (!options.appKey.trim() || !options.appSecret.trim()) throw new Error('JD app key and app secret are required')
  return {
    kind: 'platform',
    sign(request) {
      const url = new URL(request.url)
      const params: Record<string, string> = {}
      for (const [key, value] of url.searchParams.entries()) params[key] = value
      let business: Record<string, unknown> = {}
      if (request.body) {
        try { business = JSON.parse(request.body) as Record<string, unknown> } catch { /* caller supplied a non-JSON body */ }
      }
      params.app_key = options.appKey
      params.method = params.method ?? `${request.platform}.product.sync`
      params.timestamp = formatJdTimestamp((options.now ?? (() => new Date()))())
      params.v = params.v ?? '2.0'
      params.format = params.format ?? 'json'
      if (request.credential?.accessToken) params.access_token = request.credential.accessToken
      params['360buy_param_json'] = JSON.stringify(business)
      delete params.sign
      const canonical = Object.keys(params).sort().map(key => `${key}${params[key]}`).join('')
      params.sign = createHash('md5').update(`${options.appSecret}${canonical}${options.appSecret}`, 'utf8').digest('hex').toUpperCase()
      url.search = ''
      request.url = url.toString()
      request.body = new URLSearchParams(params).toString()
      request.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
      return {}
    },
  }
}

function formatJdTimestamp(value: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(value)
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? '00'
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}:${read('second')}`
}

export function mapJdProducts(payload: unknown): RawProduct[] {
  const root = record(payload)
  const envelope = firstRecord(root?.jingdong_pop_product_search_response, root?.product_search_response, root?.result)
  const candidates = arrayOf(envelope?.products ?? envelope?.ware_list ?? root?.products ?? root?.items)
  return candidates.map((item, index) => ({
    remoteId: stringValue(item.ware_id) ?? stringValue(item.sku_id) ?? stringValue(item.id) ?? `jd-item-${index}`,
    title: stringValue(item.title) ?? stringValue(item.name) ?? '',
    description: stringValue(item.description) ?? stringValue(item.desc) ?? '',
    price: numberValue(item.price ?? item.jd_price), stock: numberValue(item.stock ?? item.quantity),
    sku: arrayOf(item.skus).map((sku, skuIndex) => ({ id: stringValue(sku.sku_id) ?? `${index}-${skuIndex}`, name: stringValue(sku.name) ?? '', price: numberValue(sku.price), stock: numberValue(sku.stock ?? sku.quantity) })),
    images: strings(item.images ?? item.image_urls), category: stringValue(item.category) ?? '', attributes: {}, platformFields: item, observedAt: new Date().toISOString(),
  }))
}

export function mapJdWriteReceipt(payload: unknown, input: PlatformWriteDraft, operation: 'create' | 'update'): WriteReceipt {
  const root = platformEnvelope(payload)
  return { platform: 'jd', operation, remoteId: stringValue(root?.ware_id) ?? stringValue(root?.sku_id) ?? input.remoteId ?? '', requestId: providerRequestId(payload) ?? '', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }
}

export function mapJdWriteStatus(payload: unknown, _request: WriteIdentity): WriteStatus {
  const root = platformEnvelope(payload)
  const remoteId = stringValue(root?.ware_id) ?? stringValue(root?.sku_id) ?? stringValue(root?.id)
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

export { formatJdTimestamp }
