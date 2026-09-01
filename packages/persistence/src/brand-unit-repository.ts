import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type BrandUnitPlatform = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'
export type BrandAccessRole = 'viewer' | 'editor' | 'publisher' | 'admin'
export interface BrandUnitRow {
  id: string
  workspaceId: string
  name: string
  revision: number
  storeBindings: Array<{ platform: BrandUnitPlatform; accountId: string }>
  createdAt: string
  updatedAt: string
}
export interface BrandUnitPlatformSummary {
  workspaceId: string
  brandCount: number
  boundStoreCount: number
  unboundBrandCount: number
  canonicalProductCount: number
  listingCount: number
}
export interface CanonicalProductRow { id: string; workspaceId: string; brandId: string; title: string; facts: Record<string, unknown>; factsVersion: number; sourceProductId?: string; createdAt: string; updatedAt: string }
export interface ProductListingRow { id: string; workspaceId: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string; state: 'draft' | 'active'; createdAt: string; updatedAt: string }
export interface CampaignTargetRow { productId: string; platform: BrandUnitPlatform; accountId: string; canonicalProductId?: string; listingId?: string }
export type CampaignItemState = 'pending' | 'blocked' | 'generating' | 'review_required' | 'approved' | 'publishing' | 'published' | 'failed' | 'unknown' | 'paused' | 'manual_attention'
export type CampaignBatchState = 'draft' | 'preflighting' | 'ready' | 'blocked' | 'generating' | 'review_required' | 'publishing' | 'partial' | 'completed' | 'failed' | 'paused' | 'unknown' | 'manual_attention'
export interface CampaignItemRow { id: string; workspaceId: string; campaignId: string; brandId: string; productId: string; platform: BrandUnitPlatform; accountId: string; canonicalProductId?: string; listingId?: string; taskId?: string; state: CampaignItemState; error?: { code: string; message: string; nextAction?: string }; ordinal: number }
export interface CanonicalChainConsistencyRows {
  legacyProducts: Array<{ id: string; workspaceId: string; brandId?: string; platform?: string; accountId?: string; sourceAssetIds?: string[] }>
  canonicalProducts: Array<{ id: string; workspaceId: string; brandId: string; legacyProductId?: string }>
  listings: Array<{ id: string; workspaceId: string; brandId: string; canonicalProductId: string; platform: string; accountId: string }>
  campaignItems: Array<{ id: string; workspaceId: string; brandId: string; canonicalProductId?: string; listingId?: string; taskId?: string; platform?: string; accountId?: string }>
  tasks: Array<{ id: string; workspaceId: string; productId: string; brandId?: string; canonicalProductId?: string; listingId?: string; campaignItemId?: string; platform?: string; accountId?: string }>
  publishJobs: Array<{ id: string; workspaceId: string; taskId: string; canonicalProductId?: string; listingId?: string; platform?: string; accountId?: string }>
  assetBindings: Array<{ workspaceId: string; productId: string; assetId: string; assetRole: 'source' | 'main' | 'secondary' | 'detail'; status: 'active' | 'disabled'; assetExists: boolean; assetBrandId?: string; scanStatus?: 'quarantined' | 'clean' | 'blocked'; rightsStatus?: 'pending' | 'approved' | 'rejected' }>
}
export interface CampaignBatchRow {
  id: string
  workspaceId: string
  brandId: string
  platform: BrandUnitPlatform
  accountId: string
  productIds: string[]
  targets?: CampaignTargetRow[]
  state: CampaignBatchState
  taskIds?: string[]
  items?: CampaignItemRow[]
  manifestHash?: string
  idempotencyKey?: string
  revision?: number
  createdAt: string
  updatedAt: string
}
export type CampaignLifecycleOperation = 'pause' | 'resume' | 'retry_failed'
export interface CampaignLifecycleTransitionInput {
  workspaceId: string
  id: string
  operation: CampaignLifecycleOperation
  expectedRevision: number
  idempotencyKey: string
  reason: string
  itemIds?: string[]
}
export interface BrandUnitRepository {
  listPlatformSummary(): Promise<BrandUnitPlatformSummary[]>
  listBrands(input: { workspaceId: string; brandId?: string; platform?: BrandUnitPlatform; accountId?: string }): Promise<BrandUnitRow[]>
  createBrand(input: { workspaceId: string; id: string; name: string }): Promise<BrandUnitRow>
  bindStore(input: { workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string; expectedRevision?: number }): Promise<BrandUnitRow>
  createCampaign(input: Omit<CampaignBatchRow, 'createdAt' | 'updatedAt'>): Promise<{ campaign: CampaignBatchRow; replayed: boolean }>
  listCampaigns(input: { workspaceId: string; platform?: BrandUnitPlatform; accountId?: string; limit?: number }): Promise<CampaignBatchRow[]>
  getCampaign(input: { workspaceId: string; id: string }): Promise<CampaignBatchRow | undefined>
  updateCampaignTasks(input: { workspaceId: string; id: string; taskIds: string[]; state: CampaignBatchRow['state'] }): Promise<CampaignBatchRow>
  updateCampaignProgress(input: { workspaceId: string; id: string; state: CampaignBatchState; items: Array<{ id: string; taskId?: string; state: CampaignItemState; error?: CampaignItemRow['error'] }> }): Promise<CampaignBatchRow>
  transitionCampaignLifecycle(input: CampaignLifecycleTransitionInput): Promise<{ campaign: CampaignBatchRow; replayed: boolean }>
  createCanonicalProduct(input: { workspaceId: string; id: string; brandId: string; title: string; facts?: Record<string, unknown>; sourceProductId?: string }): Promise<CanonicalProductRow>
  getCanonicalProduct(input: { workspaceId: string; id: string }): Promise<CanonicalProductRow | undefined>
  listCanonicalProducts(input: { workspaceId: string; brandIds?: readonly string[] }): Promise<CanonicalProductRow[]>
  updateCanonicalProductTitle(input: { workspaceId: string; id: string; title: string; expectedFactsVersion: number }): Promise<CanonicalProductRow>
  updateCanonicalProductFacts(input: { workspaceId: string; id: string; facts: Record<string, unknown>; expectedFactsVersion: number }): Promise<CanonicalProductRow>
  createListing(input: { workspaceId: string; id: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string }): Promise<ProductListingRow>
  listListings(input: { workspaceId: string; brandId?: string; canonicalProductId?: string; listingId?: string; platform?: BrandUnitPlatform; accountId?: string }): Promise<ProductListingRow[]>
  listCanonicalChainConsistencyRows(input: { workspaceId: string }): Promise<CanonicalChainConsistencyRows>
  hasBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; minimumRole?: BrandAccessRole }): Promise<boolean>
  grantBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; role: BrandAccessRole }): Promise<void>
}

export class CampaignIdempotencyConflictError extends Error {
  readonly code = 'CAMPAIGN_IDEMPOTENCY_CONFLICT'
  constructor() { super('campaign idempotency key is already bound to a different intent') }
}

export class CampaignLifecycleError extends Error {
  constructor(readonly code: 'CAMPAIGN_BATCH_NOT_FOUND' | 'CAMPAIGN_REVISION_CONFLICT' | 'CAMPAIGN_LIFECYCLE_INVALID' | 'CAMPAIGN_LIFECYCLE_IDEMPOTENCY_CONFLICT' | 'CAMPAIGN_RETRY_ITEM_INVALID') { super(code); this.name = 'CampaignLifecycleError' }
}

function validateCampaignTargets(targets: readonly CampaignTargetRow[] | undefined) {
  for (const target of targets ?? []) {
    // A target is the campaign/task five-tuple boundary.  Do not allow a
    // partially populated target to become a durable item: downstream code
    // must never have to infer tenant, product, or store identity.
    const hasProduct = Boolean(target.productId?.trim())
    const hasPlatform = Boolean(target.platform?.trim())
    const hasAccount = Boolean(target.accountId?.trim())
    const hasCanonical = Boolean(target.canonicalProductId?.trim())
    const hasListing = Boolean(target.listingId?.trim())
    if (!hasProduct || !hasPlatform || !hasAccount || hasCanonical !== hasListing) throw new Error('CAMPAIGN_TARGET_SCOPE_INCOMPLETE')
  }
}

const productionCampaignStates: ReadonlySet<CampaignBatchState> = new Set([
  'preflighting', 'ready', 'generating', 'review_required', 'publishing', 'partial', 'completed',
])

function requireCanonicalListingForProduction(items: readonly Pick<CampaignItemRow, 'canonicalProductId' | 'listingId'>[]) {
  if (items.some(item => !item.canonicalProductId?.trim() || !item.listingId?.trim())) {
    throw new Error('CAMPAIGN_ITEM_LISTING_REQUIRED')
  }
}

const now = () => new Date().toISOString()

function validateCanonicalProductIdentity(input: { workspaceId: string; id: string; brandId: string; title: string }) {
  if (!input.workspaceId.trim() || !input.id.trim() || !input.brandId.trim() || !input.title.trim()) {
    throw new Error('CANONICAL_PRODUCT_SCOPE_INCOMPLETE')
  }
}

function campaignIntent(input: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[] }) {
  return JSON.stringify({ brandId: input.brandId, platform: input.platform, accountId: input.accountId, productIds: input.productIds, targets: (input.targets ?? []).map(target => ({ productId: target.productId, platform: target.platform, accountId: target.accountId, canonicalProductId: target.canonicalProductId ?? null, listingId: target.listingId ?? null })) })
}

function campaignManifestHash(input: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[] }) { return createHash('sha256').update(campaignIntent(input)).digest('hex') }
function campaignItems(input: { id: string; workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[] }): CampaignItemRow[] {
  const targets: CampaignTargetRow[] = input.targets ?? input.productIds.map(productId => ({ productId, platform: input.platform, accountId: input.accountId }))
  return targets.map((target, index) => ({ id: `${input.id}_item_${String(index + 1).padStart(4, '0')}`, workspaceId: input.workspaceId, campaignId: input.id, brandId: input.brandId, productId: target.productId, platform: target.platform, accountId: target.accountId, ...(target.canonicalProductId ? { canonicalProductId: target.canonicalProductId } : {}), ...(target.listingId ? { listingId: target.listingId } : {}), state: 'pending', ordinal: index + 1 }))
}

export class MemoryBrandUnitRepository implements BrandUnitRepository {
  private readonly brands = new Map<string, BrandUnitRow>()
  private readonly campaigns = new Map<string, CampaignBatchRow>()
  private readonly canonicalProducts = new Map<string, CanonicalProductRow>()
  private readonly listings = new Map<string, ProductListingRow>()
  private readonly campaignIdempotency = new Map<string, string>()
  private readonly campaignLifecycleReceipts = new Map<string, { fingerprint: string; campaign: CampaignBatchRow }>()
  private readonly pausedCampaigns = new Map<string, { state: CampaignBatchState; items: CampaignItemRow[] }>()
  private readonly accessGrants = new Map<string, BrandAccessRole>()
  private consistencyProjections: { legacyProducts?: () => CanonicalChainConsistencyRows['legacyProducts']; tasks?: () => CanonicalChainConsistencyRows['tasks']; publishJobs?: () => CanonicalChainConsistencyRows['publishJobs']; assetBindings?: () => CanonicalChainConsistencyRows['assetBindings'] } = {}
  /**
   * Attach read-only projections from the in-memory application service.
   * Brand-unit storage remains the source of truth for canonical rows; these
   * projections only make local consistency audits observe the same task and
   * publish edges that Postgres audits query.
   */
  setConsistencyProjections(projections: { legacyProducts?: () => CanonicalChainConsistencyRows['legacyProducts']; tasks?: () => CanonicalChainConsistencyRows['tasks']; publishJobs?: () => CanonicalChainConsistencyRows['publishJobs']; assetBindings?: () => CanonicalChainConsistencyRows['assetBindings'] }) { this.consistencyProjections = projections }
  async listBrands(input: { workspaceId: string; brandId?: string; platform?: BrandUnitPlatform; accountId?: string }) {
    return [...this.brands.values()].filter(row => row.workspaceId === input.workspaceId && (!input.brandId || row.id === input.brandId)).map(row => ({ ...row, storeBindings: row.storeBindings.filter(binding => (!input.platform || binding.platform === input.platform) && (!input.accountId || binding.accountId === input.accountId)) })).filter(row => !input.platform || row.storeBindings.length > 0)
  }
  async listPlatformSummary(): Promise<BrandUnitPlatformSummary[]> {
    const workspaceIds = new Set<string>()
    for (const row of this.brands.values()) workspaceIds.add(row.workspaceId)
    for (const row of this.canonicalProducts.values()) workspaceIds.add(row.workspaceId)
    for (const row of this.listings.values()) workspaceIds.add(row.workspaceId)
    return [...workspaceIds].sort().map(workspaceId => {
      const brands = [...this.brands.values()].filter(row => row.workspaceId === workspaceId)
      const brandIds = new Set(brands.map(row => row.id))
      return {
        workspaceId,
        brandCount: brands.length,
        boundStoreCount: brands.reduce((count, row) => count + row.storeBindings.length, 0),
        unboundBrandCount: brands.filter(row => row.storeBindings.length === 0).length,
        canonicalProductCount: [...this.canonicalProducts.values()].filter(row => row.workspaceId === workspaceId && brandIds.has(row.brandId)).length,
        listingCount: [...this.listings.values()].filter(row => row.workspaceId === workspaceId && brandIds.has(row.brandId)).length,
      }
    })
  }
  async createBrand(input: { workspaceId: string; id: string; name: string }) {
    if ([...this.brands.values()].some(row => row.workspaceId === input.workspaceId && row.id === input.id)) throw new Error('BRAND_UNIT_CONFLICT')
    const timestamp = now()
    const row: BrandUnitRow = { ...input, revision: 1, storeBindings: [], createdAt: timestamp, updatedAt: timestamp }
    this.brands.set(`${input.workspaceId}:${input.id}`, row)
    return row
  }
  async bindStore(input: { workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string; expectedRevision?: number }) {
    const row = this.brands.get(`${input.workspaceId}:${input.brandId}`)
    if (!row) throw new Error('BRAND_UNIT_NOT_FOUND')
    if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) throw new Error('BRAND_STORE_REVISION_CONFLICT')
    if (!row.storeBindings.some(item => item.platform === input.platform && item.accountId === input.accountId)) row.storeBindings.push({ platform: input.platform, accountId: input.accountId })
    row.revision += 1
    row.updatedAt = now()
    return row
  }
  async createCampaign(input: Omit<CampaignBatchRow, 'createdAt' | 'updatedAt'>) { validateCampaignTargets(input.targets); const key = input.idempotencyKey ? `${input.workspaceId}:${input.idempotencyKey}` : undefined; const existingId = key ? this.campaignIdempotency.get(key) : undefined; if (existingId) { const existing = this.campaigns.get(`${input.workspaceId}:${existingId}`); if (existing) { if (campaignIntent(existing) !== campaignIntent(input)) throw new CampaignIdempotencyConflictError(); return { campaign: existing, replayed: true } } } const timestamp = now(); const row = { ...input, revision: input.revision ?? 1, ...(input.targets ? { targets: input.targets.map(target => ({ ...target })) } : {}), items: campaignItems(input), manifestHash: campaignManifestHash(input), createdAt: timestamp, updatedAt: timestamp }; this.campaigns.set(`${input.workspaceId}:${input.id}`, row); if (key) this.campaignIdempotency.set(key, input.id); return { campaign: row, replayed: false } }
  async listCampaigns(input: { workspaceId: string; platform?: BrandUnitPlatform; accountId?: string; limit?: number }) { const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100); return [...this.campaigns.values()].filter(row => row.workspaceId === input.workspaceId && (!input.platform || row.platform === input.platform) && (!input.accountId || row.accountId === input.accountId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(row => structuredClone(row)) }
  async getCampaign(input: { workspaceId: string; id: string }) { const row = this.campaigns.get(`${input.workspaceId}:${input.id}`); return row ? { ...row, ...(row.taskIds ? { taskIds: [...row.taskIds] } : {}) } : undefined }
  async updateCampaignTasks(input: { workspaceId: string; id: string; taskIds: string[]; state: CampaignBatchRow['state'] }) { const row = this.campaigns.get(`${input.workspaceId}:${input.id}`); if (!row) throw new Error('CAMPAIGN_BATCH_NOT_FOUND'); if (productionCampaignStates.has(input.state)) requireCanonicalListingForProduction(row.items ?? []); const items = row.items?.map((item, index) => ({ ...item, ...(input.taskIds[index] ? { taskId: input.taskIds[index] } : {}), state: input.taskIds[index] ? 'generating' as const : item.state })); const updated = { ...row, ...(items ? { items } : {}), taskIds: [...input.taskIds], state: input.state, revision: (row.revision ?? 1) + 1, updatedAt: now() }; this.campaigns.set(`${input.workspaceId}:${input.id}`, updated); return updated }
  async updateCampaignProgress(input: { workspaceId: string; id: string; state: CampaignBatchState; items: Array<{ id: string; taskId?: string; state: CampaignItemState; error?: CampaignItemRow['error'] }> }) { const row = this.campaigns.get(`${input.workspaceId}:${input.id}`); if (!row) throw new Error('CAMPAIGN_BATCH_NOT_FOUND'); if (productionCampaignStates.has(input.state)) requireCanonicalListingForProduction(row.items ?? []); const progress = new Map(input.items.map(item => [item.id, item])); const items = row.items?.map(item => { const next = progress.get(item.id); return next ? { ...item, ...(next.taskId ? { taskId: next.taskId } : {}), state: next.state, ...(next.error ? { error: { ...next.error } } : { error: undefined }) } : item }); const updated = { ...row, ...(items ? { items } : {}), state: input.state, revision: (row.revision ?? 1) + 1, updatedAt: now() }; this.campaigns.set(`${input.workspaceId}:${input.id}`, updated); return updated }
  async transitionCampaignLifecycle(input: CampaignLifecycleTransitionInput) {
    const key = `${input.workspaceId}:${input.id}`; const receiptKey = `${key}:${createHash('sha256').update(input.idempotencyKey).digest('hex')}`
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation: input.operation, reason: input.reason, itemIds: [...(input.itemIds ?? [])].sort() })).digest('hex')
    const receipt = this.campaignLifecycleReceipts.get(receiptKey)
    if (receipt) { if (receipt.fingerprint !== fingerprint) throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_IDEMPOTENCY_CONFLICT'); return { campaign: structuredClone(receipt.campaign), replayed: true } }
    const row = this.campaigns.get(key); if (!row) throw new CampaignLifecycleError('CAMPAIGN_BATCH_NOT_FOUND')
    if ((row.revision ?? 1) !== input.expectedRevision) throw new CampaignLifecycleError('CAMPAIGN_REVISION_CONFLICT')
    let state = row.state; let items = (row.items ?? []).map(item => ({ ...item, ...(item.error ? { error: { ...item.error } } : {}) }))
    if (input.operation === 'pause') {
      if (state === 'paused' || state === 'completed') throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
      this.pausedCampaigns.set(key, { state, items: structuredClone(items) }); state = 'paused'; items = items.map(item => item.state === 'published' ? item : { ...item, state: 'paused' as const })
    } else if (input.operation === 'resume') {
      if (state !== 'paused') throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
      const paused = this.pausedCampaigns.get(key); if (!paused) throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
      state = paused.state; items = structuredClone(paused.items); this.pausedCampaigns.delete(key)
    } else {
      if (state === 'paused' || state === 'completed') throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
      const selected = new Set(input.itemIds?.length ? input.itemIds : items.filter(item => item.state === 'failed').map(item => item.id))
      if (!selected.size || [...selected].some(id => !items.some(item => item.id === id && item.state === 'failed'))) throw new CampaignLifecycleError('CAMPAIGN_RETRY_ITEM_INVALID')
      items = items.map(item => selected.has(item.id) ? { ...item, state: 'pending' as const, error: undefined } : item); state = 'generating'
    }
    if (productionCampaignStates.has(state)) requireCanonicalListingForProduction(items)
    const updated: CampaignBatchRow = { ...row, state, items, revision: (row.revision ?? 1) + 1, updatedAt: now() }
    this.campaigns.set(key, updated); this.campaignLifecycleReceipts.set(receiptKey, { fingerprint, campaign: structuredClone(updated) })
    return { campaign: structuredClone(updated), replayed: false }
  }
  async createCanonicalProduct(input: { workspaceId: string; id: string; brandId: string; title: string; facts?: Record<string, unknown>; sourceProductId?: string }) { validateCanonicalProductIdentity(input); if (this.canonicalProducts.has(`${input.workspaceId}:${input.id}`)) throw new Error('CANONICAL_PRODUCT_CONFLICT'); const timestamp = now(); const row = { ...input, facts: structuredClone(input.facts ?? {}), factsVersion: 1, createdAt: timestamp, updatedAt: timestamp }; this.canonicalProducts.set(`${input.workspaceId}:${input.id}`, row); return row }
  async getCanonicalProduct(input: { workspaceId: string; id: string }) { return this.canonicalProducts.get(`${input.workspaceId}:${input.id}`) }
  async listCanonicalProducts(input: { workspaceId: string; brandIds?: readonly string[] }) { return [...this.canonicalProducts.values()].filter(row => row.workspaceId === input.workspaceId && (!input.brandIds || input.brandIds.includes(row.brandId))) }
  async updateCanonicalProductTitle(input: { workspaceId: string; id: string; title: string; expectedFactsVersion: number }) {
    const key = `${input.workspaceId}:${input.id}`
    const current = this.canonicalProducts.get(key)
    if (!current) throw new Error('CANONICAL_PRODUCT_NOT_FOUND')
    if (current.factsVersion !== input.expectedFactsVersion) throw new Error('CANONICAL_PRODUCT_REVISION_CONFLICT')
    const row = { ...current, title: input.title.trim(), factsVersion: current.factsVersion + 1, updatedAt: now() }
    this.canonicalProducts.set(key, row)
    return row
  }
  async updateCanonicalProductFacts(input: { workspaceId: string; id: string; facts: Record<string, unknown>; expectedFactsVersion: number }) {
    const key = `${input.workspaceId}:${input.id}`
    const current = this.canonicalProducts.get(key)
    if (!current) throw new Error('CANONICAL_PRODUCT_NOT_FOUND')
    if (current.factsVersion !== input.expectedFactsVersion) throw new Error('CANONICAL_PRODUCT_REVISION_CONFLICT')
    const row = { ...current, facts: structuredClone(input.facts), factsVersion: current.factsVersion + 1, updatedAt: now() }
    this.canonicalProducts.set(key, row)
    return row
  }
  async createListing(input: { workspaceId: string; id: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string }) {
    const product = this.canonicalProducts.get(`${input.workspaceId}:${input.canonicalProductId}`)
    if (!product || product.workspaceId !== input.workspaceId || product.brandId !== input.brandId) throw new Error('PRODUCT_LISTING_CANONICAL_NOT_FOUND')
    if (this.listings.has(`${input.workspaceId}:${input.id}`)) throw new Error('LISTING_CONFLICT')
    const duplicate = [...this.listings.values()].find(listing => listing.workspaceId === input.workspaceId && listing.brandId === input.brandId && listing.canonicalProductId === input.canonicalProductId && listing.platform === input.platform && listing.accountId === input.accountId)
    if (duplicate) throw new Error('PRODUCT_LISTING_IDENTITY_CONFLICT')
    const timestamp = now()
    const row = { ...input, state: 'draft' as const, createdAt: timestamp, updatedAt: timestamp }
    this.listings.set(`${input.workspaceId}:${input.id}`, row)
    return row
  }
  async listListings(input: { workspaceId: string; brandId?: string; canonicalProductId?: string; listingId?: string; platform?: BrandUnitPlatform; accountId?: string }) { return [...this.listings.values()].filter(row => row.workspaceId === input.workspaceId && (!input.brandId || row.brandId === input.brandId) && (!input.canonicalProductId || row.canonicalProductId === input.canonicalProductId) && (!input.listingId || row.id === input.listingId) && (!input.platform || row.platform === input.platform) && (!input.accountId || row.accountId === input.accountId)) }
  async listCanonicalChainConsistencyRows(input: { workspaceId: string }): Promise<CanonicalChainConsistencyRows> {
    requireWorkspaceScope(input.workspaceId)
    const canonicalProducts = [...this.canonicalProducts.values()].filter(row => row.workspaceId === input.workspaceId)
    const campaigns = [...this.campaigns.values()].filter(row => row.workspaceId === input.workspaceId)
    return {
      legacyProducts: this.consistencyProjections.legacyProducts?.() ?? canonicalProducts.filter(row => row.sourceProductId).map(row => ({ id: row.sourceProductId!, workspaceId: row.workspaceId })),
      canonicalProducts: canonicalProducts.map(row => ({ id: row.id, workspaceId: row.workspaceId, brandId: row.brandId, ...(row.sourceProductId ? { legacyProductId: row.sourceProductId } : {}) })),
      listings: [...this.listings.values()].filter(row => row.workspaceId === input.workspaceId).map(row => ({ id: row.id, workspaceId: row.workspaceId, brandId: row.brandId, canonicalProductId: row.canonicalProductId, platform: row.platform, accountId: row.accountId })),
      campaignItems: campaigns.flatMap(campaign => (campaign.items ?? []).map(item => ({ id: item.id, workspaceId: campaign.workspaceId, brandId: item.brandId, canonicalProductId: item.canonicalProductId, listingId: item.listingId, ...(item.platform ? { platform: item.platform } : {}), ...(item.accountId ? { accountId: item.accountId } : {}) }))),
      tasks: this.consistencyProjections.tasks?.() ?? [],
      publishJobs: this.consistencyProjections.publishJobs?.() ?? [],
      assetBindings: this.consistencyProjections.assetBindings?.() ?? [],
    }
  }
  async hasBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; minimumRole?: BrandAccessRole }) { const role = this.accessGrants.get(`${input.workspaceId}:${input.brandId}:${input.externalSubject}`); if (!role) return false; return brandRoleLevel(role) >= brandRoleLevel(input.minimumRole ?? 'viewer') }
  async grantBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; role: BrandAccessRole }) { if (!this.brands.has(`${input.workspaceId}:${input.brandId}`)) throw new Error('BRAND_UNIT_NOT_FOUND'); this.accessGrants.set(`${input.workspaceId}:${input.brandId}:${input.externalSubject}`, input.role) }
}

function brandRoleLevel(role: BrandAccessRole) { return ({ viewer: 1, editor: 2, publisher: 3, admin: 4 } as const)[role] }

export class PostgresBrandUnitRepository implements BrandUnitRepository {
  constructor(private readonly pool: SqlPool) {}

  async listPlatformSummary(): Promise<BrandUnitPlatformSummary[]> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
      const result = await client.query<BrandUnitPlatformSummary>(`SELECT b.workspace_id AS "workspaceId",
        COUNT(DISTINCT b.id)::integer AS "brandCount",
        COUNT(DISTINCT (s.platform, s.platform_account_id)) FILTER (WHERE s.status='active')::integer AS "boundStoreCount",
        COUNT(DISTINCT b.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM brand_store_bindings sb WHERE sb.workspace_id=b.workspace_id AND sb.brand_id=b.id AND sb.status='active'))::integer AS "unboundBrandCount",
        COUNT(DISTINCT cp.id)::integer AS "canonicalProductCount",
        COUNT(DISTINCT pl.id)::integer AS "listingCount"
      FROM brands b
      LEFT JOIN brand_store_bindings s ON s.workspace_id=b.workspace_id AND s.brand_id=b.id
      LEFT JOIN canonical_products cp ON cp.workspace_id=b.workspace_id AND cp.brand_id=b.id
      LEFT JOIN product_listings pl ON pl.workspace_id=b.workspace_id AND pl.brand_id=b.id
      WHERE b.status='active'
      GROUP BY b.workspace_id ORDER BY b.workspace_id`)
      await client.query('COMMIT')
      return result.rows
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve original */ }
      throw error
    } finally { client.release?.() }
  }
  async listBrands(input: { workspaceId: string; brandId?: string; platform?: BrandUnitPlatform; accountId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<BrandUnitRow & { bindings: Array<{ platform: BrandUnitPlatform; accountId: string }> }>(`SELECT b.id, b.workspace_id AS "workspaceId", b.name, b.revision, b.created_at AS "createdAt", b.updated_at AS "updatedAt", COALESCE(jsonb_agg(jsonb_build_object('platform', s.platform, 'accountId', s.platform_account_id)) FILTER (WHERE s.platform_account_id IS NOT NULL), '[]'::jsonb) AS bindings FROM brands b LEFT JOIN brand_store_bindings s ON s.workspace_id=b.workspace_id AND s.brand_id=b.id AND s.status='active' WHERE b.workspace_id=$1 AND ($2::text IS NULL OR b.id=$2) GROUP BY b.workspace_id, b.id, b.name, b.revision, b.created_at, b.updated_at ORDER BY b.updated_at DESC`, [input.workspaceId, input.brandId ?? null])
      return result.rows.map(row => ({ id: row.id, workspaceId: row.workspaceId, name: row.name, revision: row.revision, storeBindings: row.bindings.filter(binding => (!input.platform || binding.platform === input.platform) && (!input.accountId || binding.accountId === input.accountId)), createdAt: row.createdAt, updatedAt: row.updatedAt })).filter(row => !input.platform || row.storeBindings.length > 0)
    })
  }
  async createBrand(input: { workspaceId: string; id: string; name: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<BrandUnitRow>(`INSERT INTO brands (id, workspace_id, name) VALUES ($1,$2,$3) RETURNING id, workspace_id AS "workspaceId", name, revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.id, input.workspaceId, input.name])
      return { ...result.rows[0]!, storeBindings: [] }
    })
  }
  async bindStore(input: { workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string; expectedRevision?: number }) {
    requireWorkspaceScope(input.workspaceId)
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new Error('BRAND_STORE_REVISION_INVALID')
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      await client.query(`INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, brand_id, platform_account_id) DO UPDATE SET status='active', revision=brand_store_bindings.revision+1, updated_at=now()`, [input.workspaceId, input.brandId, input.platform, input.accountId])
      const result = await client.query<BrandUnitRow & { bindings: Array<{ platform: BrandUnitPlatform; accountId: string }> }>(`UPDATE brands SET revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='active' AND ($3::int IS NULL OR revision=$3) RETURNING id, workspace_id AS "workspaceId", name, revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.brandId, input.expectedRevision ?? null])
      const row = result.rows[0]
      if (!row) throw new Error(input.expectedRevision === undefined ? 'BRAND_UNIT_NOT_FOUND' : 'BRAND_STORE_REVISION_CONFLICT')
      const bindings = await client.query<{ platform: BrandUnitPlatform; accountId: string }>(`SELECT platform, platform_account_id AS "accountId" FROM brand_store_bindings WHERE workspace_id=$1 AND brand_id=$2 AND status='active' ORDER BY platform, platform_account_id`, [input.workspaceId, input.brandId])
      return { ...row, storeBindings: bindings.rows }
    })
  }
  async createCampaign(input: Omit<CampaignBatchRow, 'createdAt' | 'updatedAt'>) {
    validateCampaignTargets(input.targets)
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const timestamp = new Date().toISOString()
      const idempotencyKey = input.idempotencyKey ?? `campaign:${input.id}`
      const existing = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; revision: number; manifestHash: string; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, revision, manifest_hash AS "manifestHash", data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND idempotency_key=$2`, [input.workspaceId, idempotencyKey])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const existingIntent = { brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}) }
        if (campaignIntent(existingIntent) !== campaignIntent(input)) throw new CampaignIdempotencyConflictError()
        return { campaign: { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(row.data.taskIds ? { taskIds: row.data.taskIds } : {}), idempotencyKey, state: row.state, revision: row.revision, manifestHash: row.manifestHash, createdAt: row.createdAt, updatedAt: row.updatedAt }, replayed: true }
      }
      const manifestHash = campaignManifestHash(input)
      await client.query(`INSERT INTO batch_campaigns (id, workspace_id, state, idempotency_key, manifest_hash, created_by, data) VALUES ($1,$2,'draft',$3,$4,$5,$6)`, [input.id, input.workspaceId, idempotencyKey, manifestHash, 'merchant', JSON.stringify({ brandId: input.brandId, platform: input.platform, accountId: input.accountId, productIds: input.productIds, ...(input.targets ? { targets: input.targets } : {}) })])
      const items = campaignItems(input)
      for (const item of items) {
        if (item.canonicalProductId || item.listingId) {
          const scope = await client.query<{ brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string }>(`SELECT brand_id AS "brandId", canonical_product_id AS "canonicalProductId", platform, platform_account_id AS "accountId" FROM product_listings WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, item.listingId ?? ''])
          const listing = scope.rows[0]
          if (!item.canonicalProductId || !item.listingId || !listing || listing.brandId !== item.brandId || listing.canonicalProductId !== item.canonicalProductId || listing.platform !== item.platform || listing.accountId !== item.accountId) throw new Error('CAMPAIGN_ITEM_LISTING_SCOPE_INVALID')
        }
        await client.query(`INSERT INTO batch_campaign_items (id, workspace_id, campaign_id, brand_id, canonical_product_id, listing_id, legacy_product_id, platform, platform_account_id, state, ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`, [item.id, item.workspaceId, item.campaignId, item.brandId, item.canonicalProductId ?? null, item.listingId ?? null, item.productId, item.platform, item.accountId, item.ordinal])
      }
      return { campaign: { ...input, revision: 1, idempotencyKey, items, manifestHash, createdAt: timestamp, updatedAt: timestamp }, replayed: false }
    })
  }
  async listCampaigns(input: { workspaceId: string; platform?: BrandUnitPlatform; accountId?: string; limit?: number }) {
    requireWorkspaceScope(input.workspaceId)
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; revision: number; manifestHash: string; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, revision, manifest_hash AS "manifestHash", data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND ($2::text IS NULL OR data->>'platform'=$2) AND ($3::text IS NULL OR data->>'accountId'=$3) ORDER BY updated_at DESC LIMIT $4`, [input.workspaceId, input.platform ?? null, input.accountId ?? null, limit])
      return Promise.all(result.rows.map(async row => {
        const items = await client.query<CampaignItemRow>(`SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", brand_id AS "brandId", legacy_product_id AS "productId", platform, platform_account_id AS "accountId", canonical_product_id AS "canonicalProductId", listing_id AS "listingId", task_id AS "taskId", state, error, ordinal FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal, created_at`, [input.workspaceId, row.id])
        const taskIds = items.rows.map(item => item.taskId).filter((id): id is string => Boolean(id))
        return { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(taskIds.length ? { taskIds } : row.data.taskIds ? { taskIds: row.data.taskIds } : {}), items: items.rows, state: row.state, revision: row.revision, manifestHash: row.manifestHash, createdAt: row.createdAt, updatedAt: row.updatedAt }
      }))
    })
  }
  async getCampaign(input: { workspaceId: string; id: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; revision: number; manifestHash: string; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, revision, manifest_hash AS "manifestHash", data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      const row = result.rows[0]
      if (!row) return undefined
      const items = await client.query<CampaignItemRow>(`SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", brand_id AS "brandId", legacy_product_id AS "productId", platform, platform_account_id AS "accountId", canonical_product_id AS "canonicalProductId", listing_id AS "listingId", task_id AS "taskId", state, error, ordinal FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal, created_at`, [input.workspaceId, input.id])
      const taskIds = items.rows.map(item => item.taskId).filter((id): id is string => Boolean(id))
      return { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(taskIds.length ? { taskIds } : row.data.taskIds ? { taskIds: row.data.taskIds } : {}), items: items.rows, state: row.state, revision: row.revision, manifestHash: row.manifestHash, createdAt: row.createdAt, updatedAt: row.updatedAt }
    })
  }
  async updateCampaignTasks(input: { workspaceId: string; id: string; taskIds: string[]; state: CampaignBatchRow['state'] }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      if (productionCampaignStates.has(input.state)) {
        const items = await client.query<Pick<CampaignItemRow, 'canonicalProductId' | 'listingId'>>(`SELECT canonical_product_id AS "canonicalProductId", listing_id AS "listingId" FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal,created_at`, [input.workspaceId, input.id])
        requireCanonicalListingForProduction(items.rows)
      }
      const result = await client.query(`UPDATE batch_campaigns SET state=$3, data=jsonb_set(data, '{taskIds}', $4::jsonb, true), revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id, input.state, JSON.stringify(input.taskIds)])
      if (!result.rowCount) throw new Error('CAMPAIGN_BATCH_NOT_FOUND')
      for (const [index, taskId] of input.taskIds.entries()) await client.query(`UPDATE batch_campaign_items SET task_id=$4, state='generating', revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND campaign_id=$2 AND ordinal=$3`, [input.workspaceId, input.id, index + 1, taskId])
      const updated = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; revision: number; manifestHash: string; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, revision, manifest_hash AS "manifestHash", data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      const row = updated.rows[0]!
      return { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(row.data.taskIds ? { taskIds: row.data.taskIds } : {}), state: row.state, revision: row.revision, manifestHash: row.manifestHash, createdAt: row.createdAt, updatedAt: row.updatedAt }
    })
  }
  async updateCampaignProgress(input: { workspaceId: string; id: string; state: CampaignBatchState; items: Array<{ id: string; taskId?: string; state: CampaignItemState; error?: CampaignItemRow['error'] }> }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      if (productionCampaignStates.has(input.state)) {
        const items = await client.query<Pick<CampaignItemRow, 'canonicalProductId' | 'listingId'>>(`SELECT canonical_product_id AS "canonicalProductId", listing_id AS "listingId" FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal,created_at`, [input.workspaceId, input.id])
        requireCanonicalListingForProduction(items.rows)
      }
      const result = await client.query(`UPDATE batch_campaigns SET state=$3, revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id, input.state])
      if (!result.rowCount) throw new Error('CAMPAIGN_BATCH_NOT_FOUND')
      for (const item of input.items) await client.query(`UPDATE batch_campaign_items SET task_id=COALESCE($4, task_id), state=$5, error=$6::jsonb, revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND campaign_id=$2 AND id=$3`, [input.workspaceId, input.id, item.id, item.taskId ?? null, item.state, item.error ? JSON.stringify(item.error) : null])
      const campaign = await client.query<{ id: string; workspaceId: string; state: CampaignBatchState; revision: number; manifestHash: string; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, revision, manifest_hash AS "manifestHash", data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      const row = campaign.rows[0]!
      const items = await client.query<CampaignItemRow>(`SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", brand_id AS "brandId", legacy_product_id AS "productId", platform, platform_account_id AS "accountId", canonical_product_id AS "canonicalProductId", listing_id AS "listingId", task_id AS "taskId", state, error, ordinal FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal, created_at`, [input.workspaceId, input.id])
      return { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(row.data.taskIds ? { taskIds: row.data.taskIds } : {}), items: items.rows, state: row.state, revision: row.revision, manifestHash: row.manifestHash, createdAt: row.createdAt, updatedAt: row.updatedAt }
    })
  }
  async transitionCampaignLifecycle(input: CampaignLifecycleTransitionInput) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      type LifecycleData = { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[]; _campaignLifecycle?: { pause?: { state: CampaignBatchState; items: CampaignItemRow[] }; operations?: Record<string, { fingerprint: string; campaign: CampaignBatchRow }> } }
      const locked = await client.query<{ id: string; workspaceId: string; state: CampaignBatchState; revision: number; manifestHash: string; data: LifecycleData; createdAt: string; updatedAt: string }>(`SELECT id,workspace_id AS "workspaceId",state,revision,manifest_hash AS "manifestHash",data,created_at AS "createdAt",updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [input.workspaceId, input.id])
      const row = locked.rows[0]; if (!row) throw new CampaignLifecycleError('CAMPAIGN_BATCH_NOT_FOUND')
      const receiptHash = createHash('sha256').update(input.idempotencyKey).digest('hex')
      const fingerprint = createHash('sha256').update(JSON.stringify({ operation: input.operation, reason: input.reason, itemIds: [...(input.itemIds ?? [])].sort() })).digest('hex')
      const lifecycle = row.data._campaignLifecycle ?? {}; const prior = lifecycle.operations?.[receiptHash]
      if (prior) { if (prior.fingerprint !== fingerprint) throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_IDEMPOTENCY_CONFLICT'); return { campaign: prior.campaign, replayed: true } }
      if (row.revision !== input.expectedRevision) throw new CampaignLifecycleError('CAMPAIGN_REVISION_CONFLICT')
      const itemResult = await client.query<CampaignItemRow>(`SELECT id,workspace_id AS "workspaceId",campaign_id AS "campaignId",brand_id AS "brandId",legacy_product_id AS "productId",platform,platform_account_id AS "accountId",canonical_product_id AS "canonicalProductId",listing_id AS "listingId",task_id AS "taskId",state,error,ordinal FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal,created_at`, [input.workspaceId, input.id])
      let state = row.state; let items = itemResult.rows.map(item => ({ ...item, ...(item.error ? { error: { ...item.error } } : {}) })); let pause = lifecycle.pause
      if (input.operation === 'pause') {
        if (state === 'paused' || state === 'completed') throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
        pause = { state, items: structuredClone(items) }; state = 'paused'; items = items.map(item => item.state === 'published' ? item : { ...item, state: 'paused' as const })
      } else if (input.operation === 'resume') {
        if (state !== 'paused' || !pause) throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
        state = pause.state; items = structuredClone(pause.items); pause = undefined
      } else {
        if (state === 'paused' || state === 'completed') throw new CampaignLifecycleError('CAMPAIGN_LIFECYCLE_INVALID')
        const selected = new Set(input.itemIds?.length ? input.itemIds : items.filter(item => item.state === 'failed').map(item => item.id))
        if (!selected.size || [...selected].some(id => !items.some(item => item.id === id && item.state === 'failed'))) throw new CampaignLifecycleError('CAMPAIGN_RETRY_ITEM_INVALID')
        items = items.map(item => selected.has(item.id) ? { ...item, state: 'pending' as const, error: undefined } : item); state = 'generating'
      }
      if (productionCampaignStates.has(state)) requireCanonicalListingForProduction(items)
      const timestamp = new Date().toISOString(); const revision = row.revision + 1
      const campaign: CampaignBatchRow = { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(row.data.taskIds ? { taskIds: row.data.taskIds } : {}), items, state, manifestHash: row.manifestHash, revision, createdAt: row.createdAt, updatedAt: timestamp }
      const operations = { ...(lifecycle.operations ?? {}), [receiptHash]: { fingerprint, campaign } }
      const data: LifecycleData = { ...row.data, _campaignLifecycle: { ...(pause ? { pause } : {}), operations } }
      await client.query(`UPDATE batch_campaigns SET state=$3,revision=$4,data=$5::jsonb,updated_at=$6 WHERE workspace_id=$1 AND id=$2 AND revision=$7`, [input.workspaceId, input.id, state, revision, JSON.stringify(data), timestamp, input.expectedRevision])
      for (const item of items) await client.query(`UPDATE batch_campaign_items SET state=$4,error=$5::jsonb,revision=revision+1,updated_at=$6 WHERE workspace_id=$1 AND campaign_id=$2 AND id=$3`, [input.workspaceId, input.id, item.id, item.state, item.error ? JSON.stringify(item.error) : null, timestamp])
      return { campaign, replayed: false }
    })
  }
  async createCanonicalProduct(input: { workspaceId: string; id: string; brandId: string; title: string; facts?: Record<string, unknown>; sourceProductId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    validateCanonicalProductIdentity(input)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`INSERT INTO canonical_products (id, workspace_id, brand_id, title, facts, legacy_product_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt"`, [input.id, input.workspaceId, input.brandId, input.title, JSON.stringify(input.facts ?? {}), input.sourceProductId ?? null])
      return result.rows[0]!
    })
  }
  async getCanonicalProduct(input: { workspaceId: string; id: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt" FROM canonical_products WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      return result.rows[0]
    })
  }
  async listCanonicalProducts(input: { workspaceId: string; brandIds?: readonly string[] }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt" FROM canonical_products WHERE workspace_id=$1 AND ($2::text[] IS NULL OR brand_id = ANY($2::text[])) ORDER BY updated_at DESC, id ASC`, [input.workspaceId, input.brandIds ?? null])
      return result.rows
    })
  }
  async updateCanonicalProductTitle(input: { workspaceId: string; id: string; title: string; expectedFactsVersion: number }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`UPDATE canonical_products SET title=$3, facts_revision=facts_revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND facts_revision=$4 RETURNING id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.id, input.title.trim(), input.expectedFactsVersion])
      if (result.rows[0]) return result.rows[0]
      const current = await client.query<{ factsVersion: number }>(`SELECT facts_revision AS "factsVersion" FROM canonical_products WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      if (!current.rows[0]) throw new Error('CANONICAL_PRODUCT_NOT_FOUND')
      throw new Error('CANONICAL_PRODUCT_REVISION_CONFLICT')
    })
  }
  async updateCanonicalProductFacts(input: { workspaceId: string; id: string; facts: Record<string, unknown>; expectedFactsVersion: number }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`UPDATE canonical_products SET facts=$3::jsonb, facts_revision=facts_revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND facts_revision=$4 RETURNING id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.id, JSON.stringify(input.facts), input.expectedFactsVersion])
      if (result.rows[0]) return result.rows[0]
      const current = await client.query<{ factsVersion: number }>(`SELECT facts_revision AS "factsVersion" FROM canonical_products WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      if (!current.rows[0]) throw new Error('CANONICAL_PRODUCT_NOT_FOUND')
      throw new Error('CANONICAL_PRODUCT_REVISION_CONFLICT')
    })
  }
  async createListing(input: { workspaceId: string; id: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${input.workspaceId}\u001f${input.brandId}\u001f${input.canonicalProductId}\u001f${input.platform}\u001f${input.accountId}`])
      const duplicate = await client.query<{ id: string }>(`SELECT id FROM product_listings WHERE workspace_id=$1 AND brand_id=$2 AND canonical_product_id=$3 AND platform=$4 AND platform_account_id=$5 LIMIT 1`, [input.workspaceId, input.brandId, input.canonicalProductId, input.platform, input.accountId])
      if (duplicate.rows[0]) throw new Error('PRODUCT_LISTING_IDENTITY_CONFLICT')
      let result: { rows: ProductListingRow[] }
      try {
        result = await client.query<ProductListingRow>(`INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, remote_product_id) SELECT $1,$2,$3,$4,$5,$6,$7 FROM canonical_products canonical WHERE canonical.workspace_id=$2 AND canonical.brand_id=$3 AND canonical.id=$4 RETURNING id, workspace_id AS "workspaceId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", platform, platform_account_id AS "accountId", remote_product_id AS "remoteProductId", state, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.id, input.workspaceId, input.brandId, input.canonicalProductId, input.platform, input.accountId, input.remoteProductId ?? null])
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'product_listings_canonical_identity_key') throw new Error('PRODUCT_LISTING_IDENTITY_CONFLICT')
        throw error
      }
      const row = result.rows[0]
      if (!row) throw new Error('PRODUCT_LISTING_CANONICAL_NOT_FOUND')
      return row
    })
  }
  async listListings(input: { workspaceId: string; brandId?: string; canonicalProductId?: string; listingId?: string; platform?: BrandUnitPlatform; accountId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<ProductListingRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", platform, platform_account_id AS "accountId", remote_product_id AS "remoteProductId", state, created_at AS "createdAt", updated_at AS "updatedAt" FROM product_listings WHERE workspace_id=$1 AND ($2::text IS NULL OR brand_id=$2) AND ($3::text IS NULL OR canonical_product_id=$3) AND ($4::text IS NULL OR id=$4) AND ($5::text IS NULL OR platform=$5) AND ($6::text IS NULL OR platform_account_id=$6) ORDER BY updated_at DESC`, [input.workspaceId, input.brandId ?? null, input.canonicalProductId ?? null, input.listingId ?? null, input.platform ?? null, input.accountId ?? null])
      return result.rows
    })
  }
  async listCanonicalChainConsistencyRows(input: { workspaceId: string }): Promise<CanonicalChainConsistencyRows> {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const [legacy, canonical, listings, campaignItems, tasks, publishJobs, assetBindings] = await Promise.all([
        client.query<CanonicalChainConsistencyRows['legacyProducts'][number]>(`SELECT id, workspace_id AS "workspaceId", NULLIF(data->>'brandId', '') AS "brandId", platform, platform_account_id AS "accountId", COALESCE(data->'sourceAssetIds', '[]'::jsonb) AS "sourceAssetIds" FROM products WHERE workspace_id=$1 ORDER BY id`, [input.workspaceId]),
        client.query<CanonicalChainConsistencyRows['canonicalProducts'][number]>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", legacy_product_id AS "legacyProductId" FROM canonical_products WHERE workspace_id=$1 ORDER BY id`, [input.workspaceId]),
        client.query<CanonicalChainConsistencyRows['listings'][number]>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", platform, platform_account_id AS "accountId" FROM product_listings WHERE workspace_id=$1 ORDER BY id`, [input.workspaceId]),
        client.query<CanonicalChainConsistencyRows['campaignItems'][number]>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", listing_id AS "listingId", task_id AS "taskId", platform, platform_account_id AS "accountId" FROM batch_campaign_items WHERE workspace_id=$1 ORDER BY id`, [input.workspaceId]),
        client.query<CanonicalChainConsistencyRows['tasks'][number]>(`SELECT id, workspace_id AS "workspaceId", product_id AS "productId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", listing_id AS "listingId", campaign_item_id AS "campaignItemId", platform, platform_account_id AS "accountId" FROM tasks WHERE workspace_id=$1 ORDER BY id`, [input.workspaceId]),
        client.query<CanonicalChainConsistencyRows['publishJobs'][number]>(`SELECT id, workspace_id AS "workspaceId", task_id AS "taskId", platform, platform_account_id AS "accountId", NULLIF(data->'canonicalBinding'->>'canonicalProductId','') AS "canonicalProductId", NULLIF(data->'canonicalBinding'->>'listingId','') AS "listingId" FROM publish_jobs WHERE workspace_id=$1 ORDER BY id`, [input.workspaceId]),
        client.query<CanonicalChainConsistencyRows['assetBindings'][number]>(`SELECT b.workspace_id AS "workspaceId", b.product_id AS "productId", b.asset_id AS "assetId", b.asset_role AS "assetRole", b.status, (a.entity_id IS NOT NULL) AS "assetExists", NULLIF(a.payload->>'brandId', '') AS "assetBrandId", NULLIF(a.payload->>'scanStatus', '') AS "scanStatus", NULLIF(a.payload->>'rightsStatus', '') AS "rightsStatus" FROM product_asset_bindings b LEFT JOIN business_entity_snapshots a ON a.workspace_id=b.workspace_id AND a.entity_type='asset' AND a.entity_id=b.asset_id WHERE b.workspace_id=$1 ORDER BY b.product_id, b.ordinal, b.asset_id`, [input.workspaceId]),
      ])
      return { legacyProducts: legacy.rows, canonicalProducts: canonical.rows, listings: listings.rows, campaignItems: campaignItems.rows, tasks: tasks.rows, publishJobs: publishJobs.rows, assetBindings: assetBindings.rows }
    })
  }
  async hasBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; minimumRole?: BrandAccessRole }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<{ role: BrandAccessRole }>(`SELECT g.role FROM brand_access_grants g JOIN workspace_members m ON m.workspace_id=g.workspace_id AND m.id=g.member_id WHERE g.workspace_id=$1 AND g.brand_id=$2 AND m.external_subject=$3 AND m.status='active'`, [input.workspaceId, input.brandId, input.externalSubject])
      return Boolean(result.rows[0] && brandRoleLevel(result.rows[0].role) >= brandRoleLevel(input.minimumRole ?? 'viewer'))
    })
  }
  async grantBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; role: BrandAccessRole }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query(`INSERT INTO brand_access_grants (workspace_id, brand_id, member_id, role) SELECT $1,$2,m.id,$4 FROM workspace_members m WHERE m.workspace_id=$1 AND m.external_subject=$3 AND m.status='active' ON CONFLICT (workspace_id, brand_id, member_id) DO UPDATE SET role=EXCLUDED.role`, [input.workspaceId, input.brandId, input.externalSubject, input.role])
      if (!result.rowCount) throw new Error('ACTIVE_MEMBER_NOT_FOUND')
    })
  }
}
