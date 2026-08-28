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
export interface CanonicalProductRow { id: string; workspaceId: string; brandId: string; title: string; factsVersion: number; sourceProductId?: string; createdAt: string; updatedAt: string }
export interface ProductListingRow { id: string; workspaceId: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string; state: 'draft' | 'active'; createdAt: string; updatedAt: string }
export interface CampaignTargetRow { productId: string; platform: BrandUnitPlatform; accountId: string; canonicalProductId?: string; listingId?: string }
export interface CampaignItemRow { id: string; workspaceId: string; campaignId: string; brandId: string; productId: string; platform: BrandUnitPlatform; accountId: string; canonicalProductId?: string; listingId?: string; taskId?: string; state: 'pending' | 'generating' | 'review_required' | 'approved' | 'publishing' | 'published' | 'failed' | 'unknown' | 'paused' | 'manual_attention'; ordinal: number }
export interface CampaignBatchRow {
  id: string
  workspaceId: string
  brandId: string
  platform: BrandUnitPlatform
  accountId: string
  productIds: string[]
  targets?: CampaignTargetRow[]
  state: 'draft' | 'generating' | 'review_required' | 'completed' | 'failed'
  taskIds?: string[]
  items?: CampaignItemRow[]
  manifestHash?: string
  idempotencyKey?: string
  createdAt: string
  updatedAt: string
}
export interface BrandUnitRepository {
  listBrands(input: { workspaceId: string; brandId?: string; platform?: BrandUnitPlatform; accountId?: string }): Promise<BrandUnitRow[]>
  createBrand(input: { workspaceId: string; id: string; name: string }): Promise<BrandUnitRow>
  bindStore(input: { workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string }): Promise<BrandUnitRow>
  createCampaign(input: Omit<CampaignBatchRow, 'createdAt' | 'updatedAt'>): Promise<{ campaign: CampaignBatchRow; replayed: boolean }>
  getCampaign(input: { workspaceId: string; id: string }): Promise<CampaignBatchRow | undefined>
  updateCampaignTasks(input: { workspaceId: string; id: string; taskIds: string[]; state: CampaignBatchRow['state'] }): Promise<CampaignBatchRow>
  createCanonicalProduct(input: { workspaceId: string; id: string; brandId: string; title: string; sourceProductId?: string }): Promise<CanonicalProductRow>
  getCanonicalProduct(input: { workspaceId: string; id: string }): Promise<CanonicalProductRow | undefined>
  createListing(input: { workspaceId: string; id: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string }): Promise<ProductListingRow>
  listListings(input: { workspaceId: string; brandId?: string; canonicalProductId?: string; listingId?: string; platform?: BrandUnitPlatform; accountId?: string }): Promise<ProductListingRow[]>
  hasBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; minimumRole?: BrandAccessRole }): Promise<boolean>
  grantBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; role: BrandAccessRole }): Promise<void>
}

export class CampaignIdempotencyConflictError extends Error {
  readonly code = 'CAMPAIGN_IDEMPOTENCY_CONFLICT'
  constructor() { super('campaign idempotency key is already bound to a different intent') }
}

const now = () => new Date().toISOString()

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
  private readonly accessGrants = new Map<string, BrandAccessRole>()
  async listBrands(input: { workspaceId: string; brandId?: string; platform?: BrandUnitPlatform; accountId?: string }) {
    return [...this.brands.values()].filter(row => row.workspaceId === input.workspaceId && (!input.brandId || row.id === input.brandId)).map(row => ({ ...row, storeBindings: row.storeBindings.filter(binding => (!input.platform || binding.platform === input.platform) && (!input.accountId || binding.accountId === input.accountId)) })).filter(row => !input.platform || row.storeBindings.length > 0)
  }
  async createBrand(input: { workspaceId: string; id: string; name: string }) {
    if ([...this.brands.values()].some(row => row.workspaceId === input.workspaceId && row.id === input.id)) throw new Error('BRAND_UNIT_CONFLICT')
    const timestamp = now()
    const row: BrandUnitRow = { ...input, revision: 1, storeBindings: [], createdAt: timestamp, updatedAt: timestamp }
    this.brands.set(`${input.workspaceId}:${input.id}`, row)
    return row
  }
  async bindStore(input: { workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string }) {
    const row = this.brands.get(`${input.workspaceId}:${input.brandId}`)
    if (!row) throw new Error('BRAND_UNIT_NOT_FOUND')
    if (!row.storeBindings.some(item => item.platform === input.platform && item.accountId === input.accountId)) row.storeBindings.push({ platform: input.platform, accountId: input.accountId })
    row.revision += 1
    row.updatedAt = now()
    return row
  }
  async createCampaign(input: Omit<CampaignBatchRow, 'createdAt' | 'updatedAt'>) { const key = input.idempotencyKey ? `${input.workspaceId}:${input.idempotencyKey}` : undefined; const existingId = key ? this.campaignIdempotency.get(key) : undefined; if (existingId) { const existing = this.campaigns.get(`${input.workspaceId}:${existingId}`); if (existing) { if (campaignIntent(existing) !== campaignIntent(input)) throw new CampaignIdempotencyConflictError(); return { campaign: existing, replayed: true } } } const timestamp = now(); const row = { ...input, ...(input.targets ? { targets: input.targets.map(target => ({ ...target })) } : {}), items: campaignItems(input), manifestHash: campaignManifestHash(input), createdAt: timestamp, updatedAt: timestamp }; this.campaigns.set(`${input.workspaceId}:${input.id}`, row); if (key) this.campaignIdempotency.set(key, input.id); return { campaign: row, replayed: false } }
  async getCampaign(input: { workspaceId: string; id: string }) { const row = this.campaigns.get(`${input.workspaceId}:${input.id}`); return row ? { ...row, ...(row.taskIds ? { taskIds: [...row.taskIds] } : {}) } : undefined }
  async updateCampaignTasks(input: { workspaceId: string; id: string; taskIds: string[]; state: CampaignBatchRow['state'] }) { const row = this.campaigns.get(`${input.workspaceId}:${input.id}`); if (!row) throw new Error('CAMPAIGN_BATCH_NOT_FOUND'); const items = row.items?.map((item, index) => ({ ...item, ...(input.taskIds[index] ? { taskId: input.taskIds[index] } : {}), state: input.taskIds[index] ? 'generating' as const : item.state })); const updated = { ...row, ...(items ? { items } : {}), taskIds: [...input.taskIds], state: input.state, updatedAt: now() }; this.campaigns.set(`${input.workspaceId}:${input.id}`, updated); return updated }
  async createCanonicalProduct(input: { workspaceId: string; id: string; brandId: string; title: string; sourceProductId?: string }) { if (this.canonicalProducts.has(`${input.workspaceId}:${input.id}`)) throw new Error('CANONICAL_PRODUCT_CONFLICT'); const timestamp = now(); const row = { ...input, factsVersion: 1, createdAt: timestamp, updatedAt: timestamp }; this.canonicalProducts.set(`${input.workspaceId}:${input.id}`, row); return row }
  async getCanonicalProduct(input: { workspaceId: string; id: string }) { return this.canonicalProducts.get(`${input.workspaceId}:${input.id}`) }
  async createListing(input: { workspaceId: string; id: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string }) { const product = this.canonicalProducts.get(`${input.workspaceId}:${input.canonicalProductId}`); if (!product || product.brandId !== input.brandId) throw new Error('PRODUCT_LISTING_CANONICAL_NOT_FOUND'); if (this.listings.has(`${input.workspaceId}:${input.id}`)) throw new Error('LISTING_CONFLICT'); const timestamp = now(); const row = { ...input, state: 'draft' as const, createdAt: timestamp, updatedAt: timestamp }; this.listings.set(`${input.workspaceId}:${input.id}`, row); return row }
  async listListings(input: { workspaceId: string; brandId?: string; canonicalProductId?: string; listingId?: string; platform?: BrandUnitPlatform; accountId?: string }) { return [...this.listings.values()].filter(row => row.workspaceId === input.workspaceId && (!input.brandId || row.brandId === input.brandId) && (!input.canonicalProductId || row.canonicalProductId === input.canonicalProductId) && (!input.listingId || row.id === input.listingId) && (!input.platform || row.platform === input.platform) && (!input.accountId || row.accountId === input.accountId)) }
  async hasBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; minimumRole?: BrandAccessRole }) { const role = this.accessGrants.get(`${input.workspaceId}:${input.brandId}:${input.externalSubject}`); if (!role) return false; return brandRoleLevel(role) >= brandRoleLevel(input.minimumRole ?? 'viewer') }
  async grantBrandAccess(input: { workspaceId: string; brandId: string; externalSubject: string; role: BrandAccessRole }) { if (!this.brands.has(`${input.workspaceId}:${input.brandId}`)) throw new Error('BRAND_UNIT_NOT_FOUND'); this.accessGrants.set(`${input.workspaceId}:${input.brandId}:${input.externalSubject}`, input.role) }
}

function brandRoleLevel(role: BrandAccessRole) { return ({ viewer: 1, editor: 2, publisher: 3, admin: 4 } as const)[role] }

export class PostgresBrandUnitRepository implements BrandUnitRepository {
  constructor(private readonly pool: SqlPool) {}
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
  async bindStore(input: { workspaceId: string; brandId: string; platform: BrandUnitPlatform; accountId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      await client.query(`INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, brand_id, platform_account_id) DO UPDATE SET status='active', revision=brand_store_bindings.revision+1, updated_at=now()`, [input.workspaceId, input.brandId, input.platform, input.accountId])
      const result = await client.query<BrandUnitRow & { bindings: Array<{ platform: BrandUnitPlatform; accountId: string }> }>(`UPDATE brands SET revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='active' RETURNING id, workspace_id AS "workspaceId", name, revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.brandId])
      const row = result.rows[0]
      if (!row) throw new Error('BRAND_UNIT_NOT_FOUND')
      const bindings = await client.query<{ platform: BrandUnitPlatform; accountId: string }>(`SELECT platform, platform_account_id AS "accountId" FROM brand_store_bindings WHERE workspace_id=$1 AND brand_id=$2 AND status='active' ORDER BY platform, platform_account_id`, [input.workspaceId, input.brandId])
      return { ...row, storeBindings: bindings.rows }
    })
  }
  async createCampaign(input: Omit<CampaignBatchRow, 'createdAt' | 'updatedAt'>) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const timestamp = new Date().toISOString()
      const idempotencyKey = input.idempotencyKey ?? `campaign:${input.id}`
      const existing = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND idempotency_key=$2`, [input.workspaceId, idempotencyKey])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const existingIntent = { brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}) }
        if (campaignIntent(existingIntent) !== campaignIntent(input)) throw new CampaignIdempotencyConflictError()
        return { campaign: { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(row.data.taskIds ? { taskIds: row.data.taskIds } : {}), idempotencyKey, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt }, replayed: true }
      }
      const manifestHash = campaignManifestHash(input)
      await client.query(`INSERT INTO batch_campaigns (id, workspace_id, state, idempotency_key, manifest_hash, created_by, data) VALUES ($1,$2,'draft',$3,$4,$5,$6)`, [input.id, input.workspaceId, idempotencyKey, manifestHash, 'merchant', JSON.stringify({ brandId: input.brandId, platform: input.platform, accountId: input.accountId, productIds: input.productIds, ...(input.targets ? { targets: input.targets } : {}) })])
      const items = campaignItems(input)
      for (const item of items) await client.query(`INSERT INTO batch_campaign_items (id, workspace_id, campaign_id, brand_id, canonical_product_id, listing_id, legacy_product_id, platform, platform_account_id, state, ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`, [item.id, item.workspaceId, item.campaignId, item.brandId, item.canonicalProductId ?? null, item.listingId ?? null, item.productId, item.platform, item.accountId, item.ordinal])
      return { campaign: { ...input, idempotencyKey, items, manifestHash, createdAt: timestamp, updatedAt: timestamp }, replayed: false }
    })
  }
  async getCampaign(input: { workspaceId: string; id: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      const row = result.rows[0]
      if (!row) return undefined
      const items = await client.query<CampaignItemRow>(`SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", brand_id AS "brandId", legacy_product_id AS "productId", platform, platform_account_id AS "accountId", canonical_product_id AS "canonicalProductId", listing_id AS "listingId", task_id AS "taskId", state, ordinal FROM batch_campaign_items WHERE workspace_id=$1 AND campaign_id=$2 ORDER BY ordinal, created_at`, [input.workspaceId, input.id])
      const taskIds = items.rows.map(item => item.taskId).filter((id): id is string => Boolean(id))
      return { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(taskIds.length ? { taskIds } : row.data.taskIds ? { taskIds: row.data.taskIds } : {}), items: items.rows, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt }
    })
  }
  async updateCampaignTasks(input: { workspaceId: string; id: string; taskIds: string[]; state: CampaignBatchRow['state'] }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query(`UPDATE batch_campaigns SET state=$3, data=jsonb_set(data, '{taskIds}', $4::jsonb, true), revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id, input.state, JSON.stringify(input.taskIds)])
      if (!result.rowCount) throw new Error('CAMPAIGN_BATCH_NOT_FOUND')
      for (const [index, taskId] of input.taskIds.entries()) await client.query(`UPDATE batch_campaign_items SET task_id=$4, state='generating', revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND campaign_id=$2 AND ordinal=$3`, [input.workspaceId, input.id, index + 1, taskId])
      const updated = await client.query<{ id: string; workspaceId: string; state: CampaignBatchRow['state']; data: { brandId: string; platform: BrandUnitPlatform; accountId: string; productIds: string[]; targets?: CampaignTargetRow[]; taskIds?: string[] }; createdAt: string; updatedAt: string }>(`SELECT id, workspace_id AS "workspaceId", state, data, created_at AS "createdAt", updated_at AS "updatedAt" FROM batch_campaigns WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      const row = updated.rows[0]!
      return { id: row.id, workspaceId: row.workspaceId, brandId: row.data.brandId, platform: row.data.platform, accountId: row.data.accountId, productIds: row.data.productIds, ...(row.data.targets ? { targets: row.data.targets } : {}), ...(row.data.taskIds ? { taskIds: row.data.taskIds } : {}), state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt }
    })
  }
  async createCanonicalProduct(input: { workspaceId: string; id: string; brandId: string; title: string; sourceProductId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`INSERT INTO canonical_products (id, workspace_id, brand_id, title, legacy_product_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt"`, [input.id, input.workspaceId, input.brandId, input.title, input.sourceProductId ?? null])
      return result.rows[0]!
    })
  }
  async getCanonicalProduct(input: { workspaceId: string; id: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<CanonicalProductRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", title, facts_revision AS "factsVersion", legacy_product_id AS "sourceProductId", created_at AS "createdAt", updated_at AS "updatedAt" FROM canonical_products WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.id])
      return result.rows[0]
    })
  }
  async createListing(input: { workspaceId: string; id: string; brandId: string; canonicalProductId: string; platform: BrandUnitPlatform; accountId: string; remoteProductId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<ProductListingRow>(`INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, remote_product_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, workspace_id AS "workspaceId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", platform, platform_account_id AS "accountId", remote_product_id AS "remoteProductId", state, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.id, input.workspaceId, input.brandId, input.canonicalProductId, input.platform, input.accountId, input.remoteProductId ?? null])
      return result.rows[0]!
    })
  }
  async listListings(input: { workspaceId: string; brandId?: string; canonicalProductId?: string; listingId?: string; platform?: BrandUnitPlatform; accountId?: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<ProductListingRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", canonical_product_id AS "canonicalProductId", platform, platform_account_id AS "accountId", remote_product_id AS "remoteProductId", state, created_at AS "createdAt", updated_at AS "updatedAt" FROM product_listings WHERE workspace_id=$1 AND ($2::text IS NULL OR brand_id=$2) AND ($3::text IS NULL OR canonical_product_id=$3) AND ($4::text IS NULL OR id=$4) AND ($5::text IS NULL OR platform=$5) AND ($6::text IS NULL OR platform_account_id=$6) ORDER BY updated_at DESC`, [input.workspaceId, input.brandId ?? null, input.canonicalProductId ?? null, input.listingId ?? null, input.platform ?? null, input.accountId ?? null])
      return result.rows
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
