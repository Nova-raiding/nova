import { DomainError } from '../../../packages/application/src/service.js'
import { ObjectStorageError } from '../../../packages/storage/src/index.js'
import type { AssetPromotionCleanupTask } from '../../../packages/persistence/src/index.js'
import type { promotionCleanupRuntime } from './server.js'

type PromotionCleanupRuntime = ReturnType<typeof promotionCleanupRuntime>

export function createPromotionCleanup(runtime: PromotionCleanupRuntime) {
  const { getPersistence, getAssetStorage } = runtime
function promotionCleanupFailure(error: unknown) {
  return { code: error instanceof ObjectStorageError ? error.code : 'OBJECT_PROMOTION_CLEANUP_FAILED', message: error instanceof Error ? error.message : String(error), observed_at: new Date().toISOString() }
}

async function runPromotionCleanup(task: AssetPromotionCleanupTask) {
  const persistence = getPersistence()
  if (task.status === 'completed') return task
  const repository = persistence.assetPromotionCleanup
  if (!repository) throw new DomainError('ASSET_PROMOTION_CLEANUP_UNAVAILABLE', '素材隔离区清理服务未配置', 503)
  try {
    await getAssetStorage().deleteQuarantineAfterCommit({ workspaceId: task.workspaceId, quarantineKey: task.quarantineKey, scanEvidenceRef: task.scanEvidenceRef, expectedSha256: task.objectSha256, expectedSizeBytes: task.sizeBytes })
    return await repository.markCompleted({ workspaceId: task.workspaceId, cleanupId: task.cleanupId, ...(task.leaseToken ? { leaseToken: task.leaseToken } : {}) })
  } catch (error) {
    const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(task.attempts, 7))
    try {
      await repository.recordFailure({ workspaceId: task.workspaceId, cleanupId: task.cleanupId, ...(task.leaseToken ? { leaseToken: task.leaseToken } : {}), error: promotionCleanupFailure(error), nextAttemptAt: new Date(Date.now() + delayMs).toISOString() })
    } catch (recordError) {
      console.error(JSON.stringify({ event: 'asset.promotion_cleanup_state_failed', workspace_id: task.workspaceId, asset_id: task.assetId, cleanup_id: task.cleanupId, quarantine_key: task.quarantineKey, clean_key: task.cleanKey, error: promotionCleanupFailure(recordError) }))
    }
    console.error(JSON.stringify({ event: 'asset.promotion_cleanup_deferred', workspace_id: task.workspaceId, asset_id: task.assetId, cleanup_id: task.cleanupId, quarantine_key: task.quarantineKey, clean_key: task.cleanKey, sha256: task.objectSha256, size_bytes: task.sizeBytes, scan_evidence_ref: task.scanEvidenceRef, error: promotionCleanupFailure(error) }))
    return task
  }
}

async function resumePromotionCleanup(workspaceId: string, receiptId: string) {
  const persistence = getPersistence()
  const task = await persistence.assetPromotionCleanup?.getByReceipt(workspaceId, receiptId)
  if (task?.status === 'pending') await runPromotionCleanup(task)
}

let promotionCleanupDrainRunning = false
async function drainPromotionCleanupTasks() {
  const persistence = getPersistence()
  if (promotionCleanupDrainRunning || persistence.mode !== 'postgres' || !persistence.assetPromotionCleanup || !persistence.listWorkspaceIds) return
  promotionCleanupDrainRunning = true
  try {
    for (const workspaceId of await persistence.listWorkspaceIds()) {
      const tasks = await persistence.assetPromotionCleanup.claimPending(workspaceId, { limit: 10, leaseMs: 30_000 })
      for (const task of tasks) await runPromotionCleanup(task)
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'asset.promotion_cleanup_drain_failed', error: promotionCleanupFailure(error) }))
  } finally {
    promotionCleanupDrainRunning = false
  }
}

  return { promotionCleanupFailure, runPromotionCleanup, resumePromotionCleanup, drainPromotionCleanupTasks }
}
