type DurableBrand = {
  id: string
  workspaceId: string
}

type DurableBrandRepository = {
  listBrands(input: { workspaceId: string; brandId: string }): Promise<readonly DurableBrand[]>
}

/**
 * A task can carry a compatibility brand id that was never projected into the
 * durable brand table. Snapshot links have a foreign key, so Postgres may only
 * receive a brand id that the authoritative repository confirms for this
 * workspace. Memory snapshots intentionally retain the historical behavior.
 */
export async function resolveContextSnapshotBrandId(input: {
  persistenceMode: 'memory' | 'postgres'
  workspaceId: string
  brandId?: string
  brandUnits?: DurableBrandRepository
}): Promise<string | undefined> {
  const originalBrandId = input.brandId
  if (!originalBrandId) return undefined
  if (input.persistenceMode !== 'postgres') return originalBrandId
  const brandId = originalBrandId.trim()
  if (!brandId) return undefined
  if (!input.brandUnits) return undefined
  const brands = await input.brandUnits.listBrands({ workspaceId: input.workspaceId, brandId })
  return brands.length === 1 && brands[0]?.id === brandId && brands[0]?.workspaceId === input.workspaceId
    ? brandId
    : undefined
}

/** A frozen legacy scope may stand in for a missing durable brand only when
 * both the id and the workspace remain exactly the task's original values. */
export function legacyTaskBrandScopeCompatible(input: {
  workspaceId: string
  taskBrandId?: string
  frozenBrandId?: string
  frozenBrandWorkspaceId?: string
}) {
  return Boolean(input.taskBrandId && input.frozenBrandId === input.taskBrandId && input.frozenBrandWorkspaceId === input.workspaceId)
}
