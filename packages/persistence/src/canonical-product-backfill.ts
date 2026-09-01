import { createHash } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface CanonicalBackfillProduct {
  id: string
  workspaceId: string
  brandId?: string
  title: string
}

export interface CanonicalBackfillRow {
  id: string
  workspaceId: string
  brandId: string
  title: string
  legacyProductId?: string
}

export type CanonicalBackfillConflictCode =
  | 'MISSING_BRAND'
  | 'CANONICAL_MAPPING_AMBIGUOUS'
  | 'CANONICAL_BRAND_MISMATCH'
  | 'CANONICAL_LEGACY_PRODUCT_MISSING'
  | 'CANONICAL_ID_COLLISION'
  | 'TASK_ACCOUNT_MISMATCH'

export interface CanonicalBackfillConflict {
  legacyProductId: string
  code: CanonicalBackfillConflictCode
  canonicalIds: readonly string[]
}

export interface CanonicalBackfillPlan {
  workspaceId: string
  creates: readonly CanonicalBackfillRow[]
  unchanged: readonly string[]
  conflicts: readonly CanonicalBackfillConflict[]
}

const sort = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b))

/** Stable across retries and deliberately independent of wall-clock values. */
export function canonicalProductIdFor(workspaceId: string, productId: string, brandId: string) {
  const digest = createHash('sha256').update(`${workspaceId}\0${productId}\0${brandId}`).digest('hex').slice(0, 24)
  return `canonical_${digest}`
}

/**
 * Plans only provable mappings. Existing ambiguous, cross-brand, or ID-collision
 * rows are reported and never rewritten.
 */
export function planCanonicalProductBackfill(input: {
  workspaceId: string
  products: readonly CanonicalBackfillProduct[]
  /**
   * Product projections referenced by existing canonical rows outside the
   * current write batch. They are used for integrity inventory only and are
   * never eligible for INSERTs in this invocation.
   */
  referencedProducts?: readonly CanonicalBackfillProduct[]
  canonicalProducts: readonly CanonicalBackfillRow[]
}): CanonicalBackfillPlan {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  const scopedProducts = input.products.filter(row => row.workspaceId === workspaceId).sort((a, b) => a.id.localeCompare(b.id) || (a.brandId ?? '').localeCompare(b.brandId ?? ''))
  // A duplicated legacy identity with different brand claims is not safe to
  // resolve by ordering. Treat it as an ambiguity; otherwise one retry could
  // create a canonical row for the wrong brand. Exact duplicate observations
  // are harmless and are collapsed deterministically.
  const productClaims = new Map<string, Map<string, Set<string>>>()
  for (const product of scopedProducts) {
    const brandId = product.brandId?.trim() ?? ''
    const claims = productClaims.get(product.id) ?? new Map<string, Set<string>>()
    const titles = claims.get(brandId) ?? new Set<string>()
    // Duplicate observations are only harmless when their identity-bearing
    // facts agree. A source changing the title under the same legacy id and
    // brand is ambiguous: choosing the first row would make retries depend on
    // source ordering and could persist the wrong canonical fact.
    titles.add(product.title.trim())
    claims.set(brandId, titles)
    productClaims.set(product.id, claims)
  }
  const ambiguousProductIds = new Set([...productClaims]
    .filter(([, claims]) => claims.size > 1 || [...claims.values()].some(titles => titles.size > 1))
    .map(([id]) => id))
  const products = [...new Map(scopedProducts.filter(product => !ambiguousProductIds.has(product.id)).map(product => [product.id, product])).values()]
  const referencedProducts = (input.referencedProducts ?? []).filter(product => product.workspaceId === workspaceId)
  const canonical = input.canonicalProducts.filter(row => row.workspaceId === workspaceId)
  const byLegacy = new Map<string, CanonicalBackfillRow[]>()
  for (const row of canonical) if (row.legacyProductId) byLegacy.set(row.legacyProductId, [...(byLegacy.get(row.legacyProductId) ?? []), row])
  const byId = new Map(canonical.map(row => [row.id, row]))
  const creates: CanonicalBackfillRow[] = []
  const unchanged: string[] = []
  const conflicts: CanonicalBackfillConflict[] = []
  const productIds = new Set(products.map(product => product.id))
  for (const legacyProductId of [...ambiguousProductIds].sort((a, b) => a.localeCompare(b))) {
    conflicts.push({ legacyProductId, code: 'CANONICAL_MAPPING_AMBIGUOUS', canonicalIds: [] })
  }
  for (const product of products) {
    const brandId = product.brandId?.trim()
    if (!brandId) { conflicts.push({ legacyProductId: product.id, code: 'MISSING_BRAND', canonicalIds: [] }); continue }
    const matches = (byLegacy.get(product.id) ?? []).sort((a, b) => a.id.localeCompare(b.id))
    if (matches.length > 1) { conflicts.push({ legacyProductId: product.id, code: 'CANONICAL_MAPPING_AMBIGUOUS', canonicalIds: matches.map(row => row.id) }); continue }
    if (matches.length === 1) {
      if (matches[0]!.brandId !== brandId) conflicts.push({ legacyProductId: product.id, code: 'CANONICAL_BRAND_MISMATCH', canonicalIds: [matches[0]!.id] })
      else unchanged.push(product.id)
      continue
    }
    const id = canonicalProductIdFor(workspaceId, product.id, brandId)
    const collision = byId.get(id)
    if (collision && (collision.legacyProductId !== product.id || collision.brandId !== brandId)) { conflicts.push({ legacyProductId: product.id, code: 'CANONICAL_ID_COLLISION', canonicalIds: [id] }); continue }
    creates.push({ id, workspaceId, brandId, title: product.title, legacyProductId: product.id })
    byId.set(id, creates.at(-1)!)
  }
  // Inventory the reverse direction as well. A canonical row that points at
  // no legacy product would otherwise be invisible to the product-driven
  // loop, yet migration 106 must reject it before the FK can be validated.
  for (const row of canonical) {
    if (!row.legacyProductId || productIds.has(row.legacyProductId)) continue
    const referenced = referencedProducts.find(product => product.id === row.legacyProductId)
    if (!referenced) {
      conflicts.push({ legacyProductId: row.legacyProductId, code: 'CANONICAL_LEGACY_PRODUCT_MISSING', canonicalIds: [row.id] })
    } else if (referenced.brandId?.trim() !== row.brandId) {
      conflicts.push({ legacyProductId: row.legacyProductId, code: 'CANONICAL_BRAND_MISMATCH', canonicalIds: [row.id] })
    }
  }
  return { workspaceId, creates, unchanged: sort(unchanged), conflicts: conflicts.sort((a, b) => a.legacyProductId.localeCompare(b.legacyProductId) || a.code.localeCompare(b.code)) }
}

export interface CanonicalBackfillResult extends CanonicalBackfillPlan {
  insertedIds: readonly string[]
  dryRun: boolean
  nextProductId?: string
}

/**
 * Applies only the plan's safe INSERTs, then reports the post-write state.
 * `dryRun` and the stable `afterProductId` cursor make the operation safe to
 * review and resume in bounded batches. The default remains a full apply for
 * existing callers.
 */
export async function runCanonicalProductBackfill(pool: SqlPool, input: { workspaceId: string; dryRun?: boolean; afterProductId?: string; limit?: number }): Promise<CanonicalBackfillResult> {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  const afterProductId = input.afterProductId?.trim()
  if (afterProductId === '') throw new Error('afterProductId must not be empty')
  const limit = input.limit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)) throw new Error('limit must be an integer between 1 and 5000')
  const dryRun = input.dryRun === true
  return withWorkspaceTransaction(pool, workspaceId, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 760))', [workspaceId])
    const productQuery = limit === undefined
      ? `SELECT id, workspace_id AS "workspaceId", NULLIF(btrim(data->>'brandId'),'') AS "brandId", title FROM products WHERE workspace_id=$1${afterProductId ? " AND id > $2" : ""} ORDER BY id`
      : `SELECT id, workspace_id AS "workspaceId", NULLIF(btrim(data->>'brandId'),'') AS "brandId", title FROM products WHERE workspace_id=$1${afterProductId ? " AND id > $2" : ""} ORDER BY id LIMIT $${afterProductId ? 3 : 2}`
    const productArgs = afterProductId ? [workspaceId, afterProductId, ...(limit === undefined ? [] : [limit + 1])] : [workspaceId, ...(limit === undefined ? [] : [limit + 1])]
    const products = await client.query<CanonicalBackfillProduct & { brand_id?: string | null }>(productQuery, productArgs)
    const hasMore = limit !== undefined && products.rows.length > limit
    const batchProducts = hasMore ? products.rows.slice(0, limit) : products.rows
    const canonical = await client.query<CanonicalBackfillRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", title, legacy_product_id AS "legacyProductId" FROM canonical_products WHERE workspace_id=$1 ORDER BY id`, [workspaceId])
    const referencedLegacyIds = [...new Set(canonical.rows.map(row => row.legacyProductId).filter((id): id is string => Boolean(id && !batchProducts.some(product => product.id === id))))]
    const referencedProducts = referencedLegacyIds.length === 0
      ? []
      : (await client.query<CanonicalBackfillProduct>(`SELECT id, workspace_id AS "workspaceId", NULLIF(btrim(data->>'brandId'),'') AS "brandId", title FROM products WHERE workspace_id=$1 AND id = ANY($2::text[])`, [workspaceId, referencedLegacyIds])).rows
    const plan = planCanonicalProductBackfill({ workspaceId, products: batchProducts, referencedProducts, canonicalProducts: canonical.rows })
    const insertedIds: string[] = []
    if (!dryRun) {
      for (const row of plan.creates) {
        const result = await client.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,id) DO NOTHING`, [row.id, row.workspaceId, row.brandId, row.title, row.legacyProductId])
        if (result.rowCount) insertedIds.push(row.id)
      }
    }
    const finalRows = dryRun
      ? canonical.rows
      : (await client.query<CanonicalBackfillRow>(`SELECT id, workspace_id AS "workspaceId", brand_id AS "brandId", title, legacy_product_id AS "legacyProductId" FROM canonical_products WHERE workspace_id=$1 ORDER BY id`)).rows
    const finalPlan = planCanonicalProductBackfill({ workspaceId, products: batchProducts, referencedProducts, canonicalProducts: finalRows })
    return { ...finalPlan, insertedIds, dryRun, ...(hasMore && batchProducts.at(-1)?.id ? { nextProductId: batchProducts.at(-1)!.id } : {}) }
  })
}
