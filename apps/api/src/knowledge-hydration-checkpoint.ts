export interface KnowledgeHydrationCheckpoint {
  snapshotId: string
  revision: number
  cursorCreatedAt: string
  cursorEventId: string
}

export interface KnowledgeHydrationSnapshotIdentity {
  snapshotId: string
  revision: number
  cursorCreatedAt: string
  cursorEventId: string
}

/**
 * Snapshot ids are stable across revisions. Keep the revision and cursor in
 * the process-local checkpoint so another API instance can advance the same
 * snapshot without being mistaken for an already loaded snapshot.
 */
export function isKnowledgeHydrationCheckpointCurrent(
  checkpoint: KnowledgeHydrationCheckpoint | undefined,
  snapshot: KnowledgeHydrationSnapshotIdentity,
) {
  return checkpoint?.snapshotId === snapshot.snapshotId
    && checkpoint.revision === snapshot.revision
    && checkpoint.cursorCreatedAt === snapshot.cursorCreatedAt
    && checkpoint.cursorEventId === snapshot.cursorEventId
}

export function checkpointFromKnowledgeSnapshot(snapshot: KnowledgeHydrationSnapshotIdentity): KnowledgeHydrationCheckpoint {
  return {
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    cursorCreatedAt: snapshot.cursorCreatedAt,
    cursorEventId: snapshot.cursorEventId,
  }
}

export function isKnowledgeEventAfterCheckpoint(
  event: { createdAt: string; id: string },
  checkpoint: KnowledgeHydrationCheckpoint | undefined,
) {
  if (!checkpoint) return true
  return event.createdAt > checkpoint.cursorCreatedAt
    || (event.createdAt === checkpoint.cursorCreatedAt && event.id > checkpoint.cursorEventId)
}

/** Preserve the existing snapshot's first occurrence while merging a delta. */
export function mergeKnowledgeHydrationEvents<T extends { id: string }>(existing: readonly T[], delta: readonly T[]) {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const event of [...existing, ...delta]) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    merged.push(event)
  }
  return merged
}
