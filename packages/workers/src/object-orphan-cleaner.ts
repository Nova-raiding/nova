import type { ObjectOrphanRepository, ObjectStorageOrphan } from '../../persistence/src/object-orphan-repository.js'

export interface ObjectOrphanCleanupResult { scanned: number; claimed: number; skipped: number; cleaned: number; retrying: number; manualAttention: number }

type OrphanOutcome = 'cleaned' | 'retrying' | 'manual_attention'

const repositoryIds = new WeakMap<object, number>()
let nextRepositoryId = 1
const activeCleanups = new Map<string, Promise<OrphanOutcome>>()

function repositoryId(repository: ObjectOrphanRepository): number {
  const existing = repositoryIds.get(repository)
  if (existing !== undefined) return existing
  const id = nextRepositoryId++
  repositoryIds.set(repository, id)
  return id
}

export async function cleanObjectStorageOrphans(input: { workspaceId: string; repository: ObjectOrphanRepository; deleteObject: (objectKey: string) => Promise<void>; onDeleted?: (row: ObjectStorageOrphan) => Promise<void>; limit?: number; maxAttempts?: number; now?: Date }): Promise<ObjectOrphanCleanupResult> {
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('OBJECT_ORPHAN_WORKSPACE_REQUIRED')
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)) throw new Error('OBJECT_ORPHAN_LIMIT_INVALID')
  if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100)) throw new Error('OBJECT_ORPHAN_MAX_ATTEMPTS_INVALID')
  const now = input.now ?? new Date()
  const maxAttempts = input.maxAttempts ?? 5
  const candidates = await input.repository.listPending(input.workspaceId, input.limit ?? 100)
  const rows = await input.repository.claimPending(input.workspaceId, { limit: input.limit ?? 100, now: now.toISOString() })
  const result: ObjectOrphanCleanupResult = { scanned: candidates.length, claimed: rows.length, skipped: Math.max(0, candidates.length - rows.length), cleaned: 0, retrying: 0, manualAttention: 0 }
  for (const row of rows) {
    const key = `${repositoryId(input.repository)}:${input.workspaceId}:${row.id}`
    let cleanup = activeCleanups.get(key)
    if (!cleanup) {
      cleanup = cleanOneOrphan(input, row, now, maxAttempts)
      activeCleanups.set(key, cleanup)
      void cleanup.then(
        () => { if (activeCleanups.get(key) === cleanup) activeCleanups.delete(key) },
        () => { if (activeCleanups.get(key) === cleanup) activeCleanups.delete(key) },
      )
    }
    const outcome = await cleanup
    if (outcome === 'cleaned') result.cleaned += 1
    else if (outcome === 'manual_attention') result.manualAttention += 1
    else result.retrying += 1
  }
  return result
}

async function cleanOneOrphan(input: { workspaceId: string; repository: ObjectOrphanRepository; deleteObject: (objectKey: string) => Promise<void>; onDeleted?: (row: ObjectStorageOrphan) => Promise<void> }, row: ObjectStorageOrphan, now: Date, maxAttempts: number): Promise<OrphanOutcome> {
  try {
    await input.deleteObject(row.objectKey)
    await input.onDeleted?.(row)
    await input.repository.markCleaned({ workspaceId: input.workspaceId, id: row.id, leaseToken: row.leaseToken })
    return 'cleaned'
  } catch (error) {
    const nextAttempts = row.attempts + 1
    const manualAttention = nextAttempts >= maxAttempts
    const delayMs = Math.min(24 * 60 * 60 * 1_000, 30_000 * 2 ** Math.max(0, nextAttempts - 2))
    const message = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_000) : 'object delete failed'
    await input.repository.markRetry({ workspaceId: input.workspaceId, id: row.id, error: message, nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(), manualAttention, leaseToken: row.leaseToken })
    return manualAttention ? 'manual_attention' : 'retrying'
  }
}
