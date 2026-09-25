import { DomainError, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

const SUPPORTED_PLATFORMS: readonly Platform[] = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']

export function parseCampaignProductIds(value: unknown) {
  if (typeof value !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'product_ids_json 必须是 1 至 50 个商品 ID 的 JSON 数组', 400)
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'product_ids_json 必须是 1 至 50 个商品 ID 的 JSON 数组', 400) }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => typeof item !== 'string' || !item.trim()) || new Set(parsed).size !== parsed.length) {
    throw new DomainError('CAMPAIGN_PRODUCT_LIMIT', 'product_ids_json 必须是 1 至 50 个不重复商品 ID 的 JSON 数组', 400)
  }
  return parsed.map(item => String(item).trim())
}

export function parseCampaignTargets(value: unknown) {
  if (typeof value !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'targets_json 必须是 1 至 50 个目标的 JSON 数组', 400)
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'targets_json 必须是有效 JSON 数组', 400) }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50) throw new DomainError('CAMPAIGN_TARGET_LIMIT', 'targets_json 必须包含 1 至 50 个目标', 400)
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || (typeof (item as Record<string, unknown>).product_id !== 'string' && typeof (item as Record<string, unknown>).canonical_product_id !== 'string') || typeof (item as Record<string, unknown>).platform !== 'string' || !SUPPORTED_PLATFORMS.includes((item as Record<string, unknown>).platform as Platform) || typeof (item as Record<string, unknown>).account_id !== 'string' || !(item as Record<string, unknown>).account_id) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `第 ${index + 1} 个批量目标必须包含 product_id 或 canonical_product_id，以及 platform、account_id`, 400)
    const target = item as Record<string, unknown>
    return { productId: typeof target.product_id === 'string' ? target.product_id.trim() : '', platform: target.platform as Platform, accountId: String(target.account_id).trim(), ...(typeof target.canonical_product_id === 'string' && target.canonical_product_id.trim() ? { canonicalProductId: target.canonical_product_id.trim() } : {}), ...(typeof target.listing_id === 'string' && target.listing_id.trim() ? { listingId: target.listing_id.trim() } : {}) }
  })
}
