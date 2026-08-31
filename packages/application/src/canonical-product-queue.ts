import type {
  CanonicalChainConsistencyInput,
  CanonicalChainConsistencyReport,
  CanonicalChainStatus,
} from './canonical-product-consistency.js'

export interface CanonicalProductQueueFilters {
  status?: CanonicalChainStatus
  brandId?: string
  platform?: string
  accountId?: string
  legacyProductId?: string
  canonicalProductId?: string
}

export interface CanonicalProductQueueItem {
  queueKey: string
  entityType: 'product' | 'canonical_product' | 'listing' | 'campaign_item' | 'task' | 'publish_job'
  entityId: string
  legacyProductId?: string
  canonicalProductId?: string
  brandId?: string
  platform?: string
  accountId?: string
  status: CanonicalChainStatus
  codes: readonly string[]
  listingIds: readonly string[]
  campaignItemIds: readonly string[]
  taskIds: readonly string[]
  publishJobIds: readonly string[]
  nextAction: string
}

export interface CanonicalProductQueuePage {
  items: readonly CanonicalProductQueueItem[]
  limit: number
  hasMore: boolean
  nextCursor: string | null
}

const rank: Record<CanonicalChainStatus, number> = { conflict: 0, blocked: 1, legacy_only: 2, verified: 3 }
const actionByCode: Record<string, string> = {
  CANONICAL_MAPPING_MISSING: '补齐 legacy product 到 canonical product 的唯一映射',
  CANONICAL_MAPPING_AMBIGUOUS: '清理重复 canonical 映射并重新校验',
  CANONICAL_LEGACY_MAPPING_MISSING: '为 canonical product 记录明确的 legacy 映射或迁移策略',
  CANONICAL_LEGACY_PRODUCT_ORPHAN: '修复 canonical product 指向的 legacy product',
  LISTING_MAPPING_MISSING: '补齐当前平台和店铺的 listing 映射',
  LISTING_CANONICAL_ORPHAN: '修复 listing 指向的 canonical product',
}

function nextAction(codes: readonly string[]) {
  return codes.map(code => actionByCode[code]).find(Boolean) ?? '查看关系链证据并由有权限的运营人员处理'
}

function encodeCursor(value: { rank: number; key: string }) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const row = parsed as Record<string, unknown>
    return typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && typeof row.key === 'string' ? { rank: row.rank, key: row.key } : undefined
  } catch { return undefined }
}

/** Build a deterministic, read-only queue from the same consistency report used by MCP. */
export function buildCanonicalProductQueue(input: CanonicalChainConsistencyInput, report: CanonicalChainConsistencyReport, options: { filters?: CanonicalProductQueueFilters; limit?: number; cursor?: string }): CanonicalProductQueuePage {
  const filters = options.filters ?? {}
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 100)
  const products = new Map(input.legacyProducts.filter(row => row.workspaceId === input.workspaceId).map(row => [row.id, row]))
  const canonical = new Map(input.canonicalProducts.filter(row => row.workspaceId === input.workspaceId).map(row => [row.id, row]))
  const listings = new Map(input.listings.filter(row => row.workspaceId === input.workspaceId).map(row => [row.id, row]))
  const items: CanonicalProductQueueItem[] = report.findings.map(finding => {
    const product = products.get(finding.legacyProductId)
    const canonicalProduct = finding.canonicalProductId ? canonical.get(finding.canonicalProductId) : undefined
    return {
      queueKey: `product:${finding.legacyProductId}`,
      entityType: 'product',
      entityId: finding.legacyProductId,
      legacyProductId: finding.legacyProductId,
      ...(finding.canonicalProductId ? { canonicalProductId: finding.canonicalProductId } : {}),
      ...(canonicalProduct?.brandId ?? product?.brandId ? { brandId: canonicalProduct?.brandId ?? product?.brandId } : {}),
      ...(product?.platform ? { platform: product.platform } : {}),
      ...(product?.accountId ? { accountId: product.accountId } : {}),
      status: finding.status,
      codes: finding.codes,
      listingIds: finding.listingIds,
      campaignItemIds: finding.campaignItemIds,
      taskIds: finding.taskIds,
      publishJobIds: finding.publishJobIds,
      nextAction: nextAction(finding.codes),
    }
  })
  for (const orphan of report.orphanFindings) {
    const row = orphan.entityType === 'canonical_product' ? canonical.get(orphan.entityId) : orphan.entityType === 'listing' ? listings.get(orphan.entityId) : undefined
    items.push({
      queueKey: `${orphan.entityType}:${orphan.entityId}`,
      entityType: orphan.entityType,
      entityId: orphan.entityId,
      ...(row && 'brandId' in row ? { brandId: row.brandId } : {}),
      ...(row && 'platform' in row ? { platform: row.platform } : {}),
      ...(row && 'accountId' in row ? { accountId: row.accountId } : {}),
      ...(row && 'canonicalProductId' in row ? { canonicalProductId: row.canonicalProductId } : {}),
      status: orphan.status,
      codes: orphan.codes,
      listingIds: orphan.entityType === 'listing' ? [orphan.entityId] : [],
      campaignItemIds: orphan.entityType === 'campaign_item' ? [orphan.entityId] : [],
      taskIds: orphan.entityType === 'task' ? [orphan.entityId] : [],
      publishJobIds: orphan.entityType === 'publish_job' ? [orphan.entityId] : [],
      nextAction: nextAction(orphan.codes),
    })
  }
  const filtered = items.filter(item => (!filters.status || item.status === filters.status)
    && (!filters.brandId || item.brandId === filters.brandId)
    && (!filters.platform || item.platform === filters.platform)
    && (!filters.accountId || item.accountId === filters.accountId)
    && (!filters.legacyProductId || item.legacyProductId === filters.legacyProductId)
    && (!filters.canonicalProductId || item.canonicalProductId === filters.canonicalProductId))
    .sort((left, right) => rank[left.status] - rank[right.status] || left.queueKey.localeCompare(right.queueKey))
  const cursor = decodeCursor(options.cursor)
  const after = cursor ? filtered.findIndex(item => rank[item.status] > cursor.rank || (rank[item.status] === cursor.rank && item.queueKey > cursor.key)) : 0
  const start = after < 0 ? filtered.length : after
  const pageItems = filtered.slice(start, start + limit)
  const hasMore = start + pageItems.length < filtered.length
  const last = pageItems.at(-1)
  return { items: pageItems, limit, hasMore, nextCursor: hasMore && last ? encodeCursor({ rank: rank[last.status], key: last.queueKey }) : null }
}
