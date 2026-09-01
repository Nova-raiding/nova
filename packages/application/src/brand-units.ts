import { createHash, randomUUID } from 'node:crypto'

export type BrandUnitPlatform = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'
export type BrandUnitState = 'active' | 'archived'
export type CampaignItemState = 'ready' | 'blocked'

export class BrandUnitError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrandUnitError' }
}

export interface BrandUnit {
  id: string
  workspaceId: string
  name: string
  description?: string
  state: BrandUnitState
  revision: number
  createdAt: string
  updatedAt: string
}

export interface BrandUnitPlatformAccount {
  id: string
  workspaceId: string
  platform: BrandUnitPlatform
  remoteAccountId: string
  label: string
}

export interface BrandUnitStoreBinding {
  workspaceId: string
  brandId: string
  accountId: string
  platform: BrandUnitPlatform
}

export interface CanonicalProduct {
  id: string
  workspaceId: string
  brandId: string
  title: string
  factsVersion: number
  state: 'active' | 'archived'
}

export interface ProductListing {
  id: string
  workspaceId: string
  brandId: string
  canonicalProductId: string
  platform: BrandUnitPlatform
  accountId: string
  remoteProductId?: string
  state: 'draft' | 'active'
}

export interface CanonicalProductDetail {
  product: CanonicalProduct
  brand: BrandUnit
  listings: ProductListing[]
  publishGate: {
    status: 'verified' | 'blocked'
    blockers: string[]
  }
}

export interface BatchCampaignItemInput {
  brandId: string
  canonicalProductId: string
  listingId: string
  platform: BrandUnitPlatform
  accountId: string
}

export interface BatchCampaignItem extends BatchCampaignItemInput {
  state: CampaignItemState
  blockers: string[]
}

export interface BatchCampaignManifest {
  id: string
  workspaceId: string
  idempotencyKey: string
  items: BatchCampaignItem[]
  aggregate: { total: number; ready: number; blocked: number; state: 'ready' | 'blocked' }
}

export interface CanonicalTaskTargetInput extends BatchCampaignItemInput {
  workspaceId: string
  taskId: string
}

export interface CanonicalTaskTargetPreflight {
  taskId: string
  workspaceId: string
  brandId: string
  state: 'ready' | 'blocked'
  blockers: string[]
  canonicalProductId: string
  listingId: string
  platform: BrandUnitPlatform
  accountId: string
}

const now = () => new Date().toISOString()
const text = (value: string, field: string) => {
  const result = value.trim()
  if (!result) throw new BrandUnitError('INVALID_INPUT', `${field} is required`)
  return result
}
const keyOf = (workspaceId: string, value: string) => `${workspaceId}:${value}`
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class BrandUnitService {
  readonly brandUnits = new Map<string, BrandUnit>()
  readonly platformAccounts = new Map<string, BrandUnitPlatformAccount>()
  readonly storeBindings = new Map<string, BrandUnitStoreBinding>()
  readonly canonicalProducts = new Map<string, CanonicalProduct>()
  readonly listings = new Map<string, ProductListing>()
  readonly campaigns = new Map<string, BatchCampaignManifest>()
  private readonly campaignIdempotency = new Map<string, { fingerprint: string; id: string }>()

  createBrandUnit(input: { workspaceId: string; name: string; description?: string; id?: string }): BrandUnit {
    const workspaceId = text(input.workspaceId, 'workspaceId')
    const name = text(input.name, 'name')
    if ([...this.brandUnits.values()].some(item => item.workspaceId === workspaceId && item.name === name && item.state === 'active')) throw new BrandUnitError('BRAND_UNIT_NAME_CONFLICT', 'brand unit name already exists in workspace')
    const timestamp = now()
    const unit: BrandUnit = { id: input.id?.trim() || `brand_${randomUUID()}`, workspaceId, name, ...(input.description?.trim() ? { description: input.description.trim() } : {}), state: 'active', revision: 1, createdAt: timestamp, updatedAt: timestamp }
    this.brandUnits.set(unit.id, unit)
    return { ...unit }
  }

  listBrandUnits(workspaceId: string): BrandUnit[] {
    const scope = text(workspaceId, 'workspaceId')
    return [...this.brandUnits.values()].filter(item => item.workspaceId === scope).map(item => ({ ...item }))
  }

  updateBrandUnit(input: { workspaceId: string; brandId: string; name?: string; description?: string; state?: BrandUnitState; expectedRevision?: number }): BrandUnit {
    const current = this.requireBrand(input.workspaceId, input.brandId)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw new BrandUnitError('BRAND_UNIT_VERSION_CONFLICT', 'brand unit revision does not match')
    const name = input.name === undefined ? current.name : text(input.name, 'name')
    if (name !== current.name && [...this.brandUnits.values()].some(item => item.workspaceId === current.workspaceId && item.id !== current.id && item.name === name && item.state === 'active')) throw new BrandUnitError('BRAND_UNIT_NAME_CONFLICT', 'brand unit name already exists in workspace')
    const updated: BrandUnit = { ...current, name, ...(input.description === undefined ? {} : input.description.trim() ? { description: input.description.trim() } : { description: undefined }), ...(input.state ? { state: input.state } : {}), revision: current.revision + 1, updatedAt: now() }
    this.brandUnits.set(updated.id, updated)
    return { ...updated }
  }

  registerPlatformAccount(input: Omit<BrandUnitPlatformAccount, 'id'> & { id?: string }): BrandUnitPlatformAccount {
    const workspaceId = text(input.workspaceId, 'workspaceId')
    const account: BrandUnitPlatformAccount = { id: input.id?.trim() || `account_${randomUUID()}`, workspaceId, platform: input.platform, remoteAccountId: text(input.remoteAccountId, 'remoteAccountId'), label: text(input.label, 'label') }
    this.platformAccounts.set(account.id, account)
    return { ...account }
  }

  bindStore(input: { workspaceId: string; brandId: string; accountId: string }): BrandUnitStoreBinding {
    const workspaceId = text(input.workspaceId, 'workspaceId')
    const brand = this.requireBrand(workspaceId, input.brandId)
    const account = this.platformAccounts.get(input.accountId)
    if (!account || account.workspaceId !== workspaceId) throw new BrandUnitError('PLATFORM_ACCOUNT_NOT_FOUND', 'platform account is missing or belongs to another workspace')
    if (brand.state !== 'active') throw new BrandUnitError('BRAND_UNIT_INACTIVE', 'archived brand unit cannot receive a store binding')
    const binding: BrandUnitStoreBinding = { workspaceId, brandId: brand.id, accountId: account.id, platform: account.platform }
    this.storeBindings.set(`${workspaceId}:${brand.id}:${account.id}`, binding)
    return { ...binding }
  }

  listStoreBindings(workspaceId: string, brandId?: string): BrandUnitStoreBinding[] {
    const scope = text(workspaceId, 'workspaceId')
    if (brandId !== undefined) this.requireBrand(scope, brandId)
    return [...this.storeBindings.values()].filter(item => item.workspaceId === scope && (!brandId || item.brandId === brandId)).map(item => ({ ...item }))
  }

  createCanonicalProduct(input: Omit<CanonicalProduct, 'id' | 'factsVersion' | 'state'> & { id?: string; factsVersion?: number; state?: CanonicalProduct['state'] }): CanonicalProduct {
    const brand = this.requireBrand(input.workspaceId, input.brandId)
    const id = input.id?.trim() || `product_${randomUUID()}`
    const existing = this.canonicalProducts.get(id)
    if (existing) throw new BrandUnitError('CANONICAL_PRODUCT_CONFLICT', 'canonical product id already exists')
    const product: CanonicalProduct = { id, workspaceId: brand.workspaceId, brandId: brand.id, title: text(input.title, 'title'), factsVersion: input.factsVersion ?? 1, state: input.state ?? 'active' }
    this.canonicalProducts.set(product.id, product)
    return { ...product }
  }

  createListing(input: Omit<ProductListing, 'id' | 'state'> & { id?: string; state?: ProductListing['state'] }): ProductListing {
    const product = this.requireProduct(input.workspaceId, input.canonicalProductId)
    if (product.brandId !== input.brandId) throw new BrandUnitError('BRAND_ID_MISMATCH', 'listing brandId does not match canonical product')
    this.requireBrand(input.workspaceId, input.brandId)
    const account = this.requireAccount(input.workspaceId, input.accountId)
    if (account.platform !== input.platform) throw new BrandUnitError('PLATFORM_MISMATCH', 'listing platform does not match account')
    this.requireBinding(input.workspaceId, input.brandId, input.accountId)
    const id = input.id?.trim() || `listing_${randomUUID()}`
    if (this.listings.has(id)) throw new BrandUnitError('LISTING_CONFLICT', 'listing id already exists')
    if ([...this.listings.values()].some(item => item.workspaceId === input.workspaceId && item.canonicalProductId === input.canonicalProductId && item.platform === input.platform && item.accountId === input.accountId)) {
      throw new BrandUnitError('LISTING_TARGET_CONFLICT', 'a listing already exists for this product and store')
    }
    const listing: ProductListing = { id, workspaceId: input.workspaceId, brandId: input.brandId, canonicalProductId: input.canonicalProductId, platform: input.platform, accountId: input.accountId, ...(input.remoteProductId?.trim() ? { remoteProductId: input.remoteProductId.trim() } : {}), state: input.state ?? 'draft' }
    this.listings.set(listing.id, listing)
    return { ...listing }
  }

  /**
   * Return the complete, workspace-scoped detail needed by a desktop
   * canonical-product drawer. The publish gate is intentionally derived from
   * persisted facts only; it never guesses a listing or treats a draft as
   * publishable.
   */
  getCanonicalProductDetail(workspaceId: string, canonicalProductId: string): CanonicalProductDetail {
    const scope = text(workspaceId, 'workspaceId')
    const product = this.requireProduct(scope, text(canonicalProductId, 'canonicalProductId'))
    const brand = this.requireBrand(scope, product.brandId)
    const listings = [...this.listings.values()]
      .filter(listing => listing.workspaceId === scope && listing.canonicalProductId === product.id)
      .map(listing => ({ ...listing }))
    const blockers: string[] = []
    if (brand.state !== 'active') blockers.push('BRAND_UNIT_NOT_ACTIVE')
    if (product.state !== 'active') blockers.push('CANONICAL_PRODUCT_NOT_ACTIVE')
    if (listings.length === 0) blockers.push('CANONICAL_LISTING_REQUIRED')
    else if (!listings.some(listing => listing.state === 'active')) blockers.push('CANONICAL_LISTING_NOT_ACTIVE')
    return {
      product: { ...product },
      brand: { ...brand },
      listings,
      publishGate: { status: blockers.length ? 'blocked' : 'verified', blockers },
    }
  }

  preflightCampaign(input: { workspaceId: string; idempotencyKey: string; items: BatchCampaignItemInput[] }): BatchCampaignManifest {
    const workspaceId = text(input.workspaceId, 'workspaceId')
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey')
    if (input.items.length === 0) throw new BrandUnitError('CAMPAIGN_EMPTY', 'campaign must contain at least one item')
    if (input.items.length > 50) throw new BrandUnitError('CAMPAIGN_LIMIT_EXCEEDED', 'campaign supports at most 50 items')
    const intent = fingerprint({ workspaceId, items: input.items })
    const idem = this.campaignIdempotency.get(keyOf(workspaceId, idempotencyKey))
    if (idem) {
      if (idem.fingerprint !== intent) throw new BrandUnitError('IDEMPOTENCY_KEY_REUSED', 'idempotency key is already bound to another campaign')
      return this.cloneCampaign(this.campaigns.get(idem.id)!)
    }
    const items = input.items.map(item => this.checkItem(workspaceId, item))
    const ready = items.filter(item => item.state === 'ready').length
    const manifest: BatchCampaignManifest = { id: `campaign_${randomUUID()}`, workspaceId, idempotencyKey, items, aggregate: { total: items.length, ready, blocked: items.length - ready, state: ready === items.length ? 'ready' : 'blocked' } }
    this.campaigns.set(manifest.id, manifest)
    this.campaignIdempotency.set(keyOf(workspaceId, idempotencyKey), { fingerprint: intent, id: manifest.id })
    return this.cloneCampaign(manifest)
  }

  /**
   * Validate the immutable canonical target before a task or publish-preflight
   * action is allowed to proceed. This is deliberately read-only: it never
   * promotes a legacy product, guesses a listing, or changes campaign state.
   */
  preflightTaskTarget(input: CanonicalTaskTargetInput): CanonicalTaskTargetPreflight {
    const workspaceId = text(input.workspaceId, 'workspaceId')
    const taskId = text(input.taskId, 'taskId')
    const blockers = this.checkTarget(workspaceId, input)
    const listing = this.listings.get(input.listingId)
    if (listing?.workspaceId === workspaceId && listing.state !== 'active') blockers.push('LISTING_NOT_ACTIVE')
    return {
      taskId,
      workspaceId,
      brandId: input.brandId,
      state: blockers.length ? 'blocked' : 'ready',
      blockers,
      canonicalProductId: input.canonicalProductId,
      listingId: input.listingId,
      platform: input.platform,
      accountId: input.accountId,
    }
  }

  private checkItem(workspaceId: string, input: BatchCampaignItemInput): BatchCampaignItem {
    const blockers = this.checkTarget(workspaceId, input)
    return { ...input, state: blockers.length ? 'blocked' : 'ready', blockers }
  }

  private checkTarget(workspaceId: string, input: BatchCampaignItemInput): string[] {
    const blockers: string[] = []
    try {
      const brand = this.requireBrand(workspaceId, input.brandId)
      const product = this.requireProduct(workspaceId, input.canonicalProductId)
      if (product.state !== 'active') blockers.push('CANONICAL_PRODUCT_NOT_ACTIVE')
      if (product.brandId !== brand.id) blockers.push('BRAND_ID_MISMATCH')
      const listing = this.listings.get(input.listingId)
      if (!listing || listing.workspaceId !== workspaceId) blockers.push('LISTING_NOT_FOUND')
      else {
        if (listing.brandId !== brand.id || listing.canonicalProductId !== product.id) blockers.push('LISTING_SCOPE_MISMATCH')
        if (listing.platform !== input.platform || listing.accountId !== input.accountId) blockers.push('LISTING_TARGET_MISMATCH')
      }
      const account = this.requireAccount(workspaceId, input.accountId)
      if (account.platform !== input.platform) blockers.push('PLATFORM_MISMATCH')
      if (!this.storeBindings.has(`${workspaceId}:${brand.id}:${input.accountId}`)) blockers.push('STORE_NOT_BOUND_TO_BRAND')
    } catch (error) { blockers.push(error instanceof BrandUnitError ? error.code : 'INVALID_SCOPE') }
    return blockers
  }

  private requireBrand(workspaceId: string, brandId: string): BrandUnit {
    const scope = text(workspaceId, 'workspaceId')
    const brand = this.brandUnits.get(brandId)
    if (!brand || brand.workspaceId !== scope) throw new BrandUnitError('BRAND_UNIT_NOT_FOUND', 'brand unit is missing or belongs to another workspace')
    return brand
  }
  private requireProduct(workspaceId: string, productId: string): CanonicalProduct {
    const product = this.canonicalProducts.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new BrandUnitError('PRODUCT_NOT_FOUND', 'canonical product is missing or belongs to another workspace')
    return product
  }
  private requireAccount(workspaceId: string, accountId: string): BrandUnitPlatformAccount {
    const account = this.platformAccounts.get(accountId)
    if (!account || account.workspaceId !== workspaceId) throw new BrandUnitError('PLATFORM_ACCOUNT_NOT_FOUND', 'platform account is missing or belongs to another workspace')
    return account
  }
  private requireBinding(workspaceId: string, brandId: string, accountId: string) {
    if (!this.storeBindings.has(`${workspaceId}:${brandId}:${accountId}`)) throw new BrandUnitError('STORE_NOT_BOUND_TO_BRAND', 'store is not bound to brand unit')
  }
  private cloneCampaign(manifest: BatchCampaignManifest): BatchCampaignManifest { return { ...manifest, items: manifest.items.map(item => ({ ...item, blockers: [...item.blockers] })), aggregate: { ...manifest.aggregate } } }
}
