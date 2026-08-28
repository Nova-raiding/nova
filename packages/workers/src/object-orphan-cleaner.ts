import type { ObjectOrphanRepository } from '../../persistence/src/object-orphan-repository.js'

export interface ObjectOrphanCleanupResult { scanned: number; cleaned: number; retrying: number; manualAttention: number }

export async function cleanObjectStorageOrphans(input: { workspaceId: string; repository: ObjectOrphanRepository; deleteObject: (objectKey: string) => Promise<void>; limit?: number; maxAttempts?: number; now?: Date }): Promise<ObjectOrphanCleanupResult> {
  const now = input.now ?? new Date()
  const maxAttempts = Math.max(1, input.maxAttempts ?? 5)
  const rows = await input.repository.listPending(input.workspaceId, Math.min(500, Math.max(1, input.limit ?? 100)))
  const result: ObjectOrphanCleanupResult = { scanned: rows.length, cleaned: 0, retrying: 0, manualAttention: 0 }
  for (const row of rows) {
    try {
      await input.deleteObject(row.objectKey)
      await input.repository.markCleaned({ workspaceId: input.workspaceId, id: row.id })
      result.cleaned += 1
    } catch (error) {
      const nextAttempts = row.attempts + 1
      const manualAttention = nextAttempts >= maxAttempts
      const delayMs = Math.min(24 * 60 * 60 * 1_000, 30_000 * 2 ** Math.max(0, nextAttempts - 2))
      await input.repository.markRetry({ workspaceId: input.workspaceId, id: row.id, error: error instanceof Error ? error.message.slice(0, 2_000) : 'object delete failed', nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(), manualAttention })
      if (manualAttention) result.manualAttention += 1
      else result.retrying += 1
    }
  }
  return result
}
