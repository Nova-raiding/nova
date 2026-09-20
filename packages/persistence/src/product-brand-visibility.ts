/**
 * The one definition of which products a brand restricted member may read.
 *
 * A product is visible to a restricted member exactly when a canonical product
 * row for it is bound to a brand the member holds a grant on. Nothing else
 * makes a product visible: a legacy product with no canonical row is not
 * attributable to any brand, so it is hidden — the same fail-closed answer the
 * point read (`assertProductBrandAccess`), `catalog.search`, the asset and
 * image-generation-job surfaces and `GET /v1/delivery-readiness` already gave.
 *
 * Two implementations of this rule existed and disagreed. `accessibleProductIds`
 * (the point read, the in-memory `catalog.search`, assets and image jobs) used
 * the canonical binding alone; `catalogProductFilterFor` (the in-memory
 * `/v1/products` page and `workspace.metrics`) additionally made a canonical-row
 * product with no canonical row visible when a task on it carried a granted
 * brand, *or* when no task on it carried any brand at all; and the durable
 * product page carried that wider clause in SQL. The same product then answered
 * "visible" on the list, 404 on the point read and absent on MCP `catalog.search`
 * — one backend, three answers (reproduced over real HTTP before this module
 * existed).
 *
 * The narrower direction was chosen deliberately, and its cost is real: a
 * brand-restricted member no longer sees legacy products that have no canonical
 * row, including products whose tasks they can still list, and a member with no
 * grant at all sees only the products bound to brands they hold. Restoring the
 * wider predicate is not a bug fix — it is the leak this rule exists to close.
 *
 * The rule has two expressions that cannot share code — a JS predicate over
 * canonical rows and a SQL clause over the durable page — so both live here,
 * next to each other, and `packages/persistence/src/business-repository.postgres.test.ts`
 * asserts they answer identically for the same fixture.
 */

/** A canonical product row as the visibility rule sees it. */
export interface CanonicalProductBrandRow {
  readonly brandId: string
  readonly sourceProductId?: string | null
}

/**
 * The visible legacy product ids for a subject holding `brandIds` grants, given
 * the workspace's canonical product rows. `undefined` means workspace-wide
 * access — an owner/admin member, or non-strict auth — and nothing is filtered;
 * an empty set means every product is hidden (a restricted member with no grant).
 */
export function visibleProductIds(brandIds: readonly string[] | undefined, canonicalRows: readonly CanonicalProductBrandRow[]): ReadonlySet<string> | undefined {
  if (brandIds === undefined) return undefined
  const granted = new Set(brandIds)
  const visible = new Set<string>()
  for (const row of canonicalRows) {
    if (!row.sourceProductId || !granted.has(row.brandId)) continue
    visible.add(row.sourceProductId)
  }
  return visible
}

/**
 * The durable twin of `visibleProductIds`: the `products` page clause for one
 * `accessibleBrandIds` parameter. `brandIndex` is the 1-based position of that
 * parameter in the statement's value list.
 */
export function accessibleProductBrandClause(brandIndex: number): string {
  return `EXISTS (SELECT 1 FROM canonical_products cp WHERE cp.workspace_id = products.workspace_id AND cp.legacy_product_id = products.id AND cp.brand_id = ANY($${brandIndex}::text[]))`
}
