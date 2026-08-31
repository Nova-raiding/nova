import { describe, expect, it } from 'vitest'
import { checkpointFromKnowledgeSnapshot, isKnowledgeEventAfterCheckpoint, isKnowledgeHydrationCheckpointCurrent, mergeKnowledgeHydrationEvents } from './knowledge-hydration-checkpoint.js'

const snapshot = { snapshotId: 'knowledge_snapshot_1', revision: 2, cursorCreatedAt: '2026-08-29T00:00:00.000Z', cursorEventId: 'evt-2' }

describe('knowledge hydration checkpoint identity', () => {
  it('reuses a checkpoint only when snapshot id, revision and cursor all match', () => {
    const checkpoint = checkpointFromKnowledgeSnapshot(snapshot)
    expect(isKnowledgeHydrationCheckpointCurrent(checkpoint, snapshot)).toBe(true)
    expect(isKnowledgeHydrationCheckpointCurrent(checkpoint, { ...snapshot, revision: 3 })).toBe(false)
    expect(isKnowledgeHydrationCheckpointCurrent(checkpoint, { ...snapshot, cursorEventId: 'evt-3' })).toBe(false)
    expect(isKnowledgeHydrationCheckpointCurrent(checkpoint, { ...snapshot, snapshotId: 'knowledge_snapshot_2' })).toBe(false)
  })

  it('does not treat an unset checkpoint as loaded', () => {
    expect(isKnowledgeHydrationCheckpointCurrent(undefined, snapshot)).toBe(false)
  })

  it('selects only events after the local cursor when a snapshot revision advances', () => {
    const checkpoint = checkpointFromKnowledgeSnapshot(snapshot)
    expect(isKnowledgeEventAfterCheckpoint({ createdAt: snapshot.cursorCreatedAt, id: 'evt-1' }, checkpoint)).toBe(false)
    expect(isKnowledgeEventAfterCheckpoint({ createdAt: snapshot.cursorCreatedAt, id: 'evt-3' }, checkpoint)).toBe(true)
    expect(isKnowledgeEventAfterCheckpoint({ createdAt: '2026-08-29T00:00:01.000Z', id: 'evt-0' }, checkpoint)).toBe(true)
  })

  it('merges snapshot and delta events in linear time semantics, keeping the snapshot copy', () => {
    expect(mergeKnowledgeHydrationEvents([{ id: 'evt-1', value: 'snapshot' }, { id: 'evt-2', value: 'snapshot' }], [{ id: 'evt-2', value: 'delta' }, { id: 'evt-3', value: 'delta' }])).toEqual([
      { id: 'evt-1', value: 'snapshot' },
      { id: 'evt-2', value: 'snapshot' },
      { id: 'evt-3', value: 'delta' },
    ])
  })
})
