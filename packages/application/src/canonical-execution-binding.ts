import { createHash } from 'node:crypto'

export type CanonicalExecutionBindingMode = 'standard' | 'legacy_only'

export interface CanonicalExecutionBindingInput {
  workspaceId: string
  taskId: string
  productId: string
  platform: string
  accountId?: string
  canonicalProductId?: string
  listingId?: string
  campaignId?: string
  campaignItemId?: string
  inputSnapshotId?: string
}

export interface CanonicalExecutionBinding {
  mode: CanonicalExecutionBindingMode
  snapshotHash: string
  canonicalProductId?: string
  listingId?: string
  campaignId?: string
  campaignItemId?: string
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Build the small immutable identity binding carried by queued executions.
 * Legacy tasks are explicit and never silently promoted to the canonical
 * chain. Canonical and campaign scopes are each pair-validated; a canonical
 * task does not need to belong to a campaign, while a legacy campaign task
 * may retain its campaign pair for auditability.
 */
export function buildCanonicalExecutionBinding(input: CanonicalExecutionBindingInput): CanonicalExecutionBinding {
  const ids = {
    canonicalProductId: input.canonicalProductId?.trim() || undefined,
    listingId: input.listingId?.trim() || undefined,
    campaignId: input.campaignId?.trim() || undefined,
    campaignItemId: input.campaignItemId?.trim() || undefined,
  }
  const canonicalPresent = Number(Boolean(ids.canonicalProductId)) + Number(Boolean(ids.listingId))
  const campaignPresent = Number(Boolean(ids.campaignId)) + Number(Boolean(ids.campaignItemId))
  if (canonicalPresent === 1 || campaignPresent === 1) throw new Error('CANONICAL_EXECUTION_BINDING_INCOMPLETE')
  const mode: CanonicalExecutionBindingMode = canonicalPresent === 2 ? 'standard' : 'legacy_only'
  const snapshot = { mode, workspaceId: input.workspaceId, taskId: input.taskId, productId: input.productId, platform: input.platform, accountId: input.accountId ?? null, inputSnapshotId: input.inputSnapshotId ?? null, ...ids }
  return { mode, snapshotHash: digest(snapshot), ...(ids.canonicalProductId ? { canonicalProductId: ids.canonicalProductId } : {}), ...(ids.listingId ? { listingId: ids.listingId } : {}), ...(ids.campaignId ? { campaignId: ids.campaignId } : {}), ...(ids.campaignItemId ? { campaignItemId: ids.campaignItemId } : {}) }
}

export function sameCanonicalExecutionBinding(left: CanonicalExecutionBinding, right: CanonicalExecutionBinding): boolean {
  return left.mode === right.mode && left.snapshotHash === right.snapshotHash && left.canonicalProductId === right.canonicalProductId && left.listingId === right.listingId && left.campaignId === right.campaignId && left.campaignItemId === right.campaignItemId
}
