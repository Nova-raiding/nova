import { describe, expect, it } from 'vitest'
import { CanonicalBackfillConflictIdempotencyConflictError, CanonicalBackfillConflictRecheckMismatchError, CanonicalBackfillConflictRevisionConflictError, MemoryCanonicalBackfillConflictRepository } from './canonical-backfill-conflict-repository.js'

describe('canonical backfill conflict queue', () => {
  it('deduplicates conflicts and supports claim/resolve CAS', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    const input = { workspaceId: 'ws_conflict_test', runId: 'backfill_run_1', conflicts: [{ legacyProductId: 'p1', code: 'MISSING_BRAND' as const, canonicalIds: [] }] }
    const [first] = await repository.enqueue(input)
    const [second] = await repository.enqueue(input)
    expect(second?.id).toBe(first?.id)
    const claimed = await repository.claim({ workspaceId: input.workspaceId, id: first!.id, expectedRevision: 1, assigneeId: 'ops-1' })
    expect(claimed).toMatchObject({ status: 'claimed', assigneeId: 'ops-1', revision: 2 })
    const resolved = await repository.resolve({ workspaceId: input.workspaceId, id: first!.id, expectedRevision: 2, status: 'resolved', assigneeId: 'ops-1', resolutionNote: '已补齐品牌映射' })
    expect(resolved).toMatchObject({ status: 'resolved', revision: 3, resolutionNote: '已补齐品牌映射' })
    await expect(repository.resolve({ workspaceId: input.workspaceId, id: first!.id, expectedRevision: 2, status: 'dismissed', assigneeId: 'ops-1', resolutionNote: '旧版本重试' })).rejects.toBeInstanceOf(CanonicalBackfillConflictRevisionConflictError)
    await expect(repository.claim({ workspaceId: input.workspaceId, id: first!.id, expectedRevision: 3, assigneeId: 'ops-2' })).rejects.toThrow('CANONICAL_BACKFILL_CONFLICT_STATE_INVALID')
  })

  it('fails closed when an idempotency key is replayed with different canonical ids', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    const base = { workspaceId: 'ws_conflict_idempotency', runId: 'run_1', conflicts: [{ legacyProductId: 'p1', code: 'CANONICAL_MAPPING_AMBIGUOUS' as const, canonicalIds: ['c1'] }] }
    await repository.enqueue(base)
    const original = base.conflicts[0]!
    await expect(repository.enqueue({ ...base, conflicts: [{ legacyProductId: original.legacyProductId, code: original.code, canonicalIds: ['c2'] }] })).rejects.toBeInstanceOf(CanonicalBackfillConflictIdempotencyConflictError)
  })

  it('does not partially enqueue a batch after an idempotency conflict', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    await expect(repository.enqueue({
      workspaceId: 'ws_conflict_atomicity',
      runId: 'run_1',
      conflicts: [
        { legacyProductId: 'p-new', code: 'MISSING_BRAND', canonicalIds: [] },
        { legacyProductId: 'p-new', code: 'MISSING_BRAND', canonicalIds: ['c-conflict'] },
      ],
    })).rejects.toBeInstanceOf(CanonicalBackfillConflictIdempotencyConflictError)
    await expect(repository.list({ workspaceId: 'ws_conflict_atomicity', runId: 'run_1' })).resolves.toEqual([])
  })

  it('rechecks the stored conflict snapshot with CAS and preserves its state', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    const [row] = await repository.enqueue({ workspaceId: 'ws_conflict_recheck', runId: 'run_1', conflicts: [{ legacyProductId: 'p1', code: 'CANONICAL_MAPPING_AMBIGUOUS', canonicalIds: ['c1'] }] })
    const observed = { code: 'CANONICAL_MAPPING_AMBIGUOUS' as const, canonicalIds: ['c1'] }
    const checked = await repository.recheck({ workspaceId: 'ws_conflict_recheck', id: row!.id, expectedRevision: 1, observed, evidence: { source: 'backfill-audit', reference: 'audit-1' } })
    expect(checked).toMatchObject({ status: 'open', revision: 2, verificationEvidence: { schemaVersion: 'canonical-backfill-conflict-recheck/1', observedCode: observed.code, observedCanonicalIds: observed.canonicalIds, source: 'backfill-audit', reference: 'audit-1' } })
    await expect(repository.recheck({ workspaceId: 'ws_conflict_recheck', id: row!.id, expectedRevision: 2, observed: { code: 'CANONICAL_MAPPING_AMBIGUOUS', canonicalIds: ['c2'] }, evidence: { source: 'backfill-audit' } })).rejects.toBeInstanceOf(CanonicalBackfillConflictRecheckMismatchError)
    await expect(repository.recheck({ workspaceId: 'ws_conflict_recheck', id: row!.id, expectedRevision: 1, observed, evidence: { source: 'backfill-audit' } })).rejects.toBeInstanceOf(CanonicalBackfillConflictRevisionConflictError)
  })

  it('rejects malformed conflict fields before persistence', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    await expect(repository.enqueue({ workspaceId: 'ws_conflict_validation', runId: '', conflicts: [] })).rejects.toThrow('CANONICAL_BACKFILL_CONFLICT_RUN_ID_REQUIRED')
    await expect(repository.enqueue({ workspaceId: 'ws_conflict_validation', runId: 'run_1', conflicts: [{ legacyProductId: ' ', code: 'MISSING_BRAND', canonicalIds: [] }] })).rejects.toThrow('CANONICAL_BACKFILL_CONFLICT_LEGACY_PRODUCT_ID_REQUIRED')
    await expect(repository.enqueue({ workspaceId: 'ws_conflict_validation', runId: 'run_1', conflicts: [{ legacyProductId: 'p1', code: 'MISSING_BRAND', canonicalIds: [' '] }] })).rejects.toThrow('CANONICAL_BACKFILL_CONFLICT_CANONICAL_IDS_INVALID')
    await expect(repository.claim({ workspaceId: 'ws_conflict_validation', id: 'missing', expectedRevision: 0, assigneeId: 'ops-1' })).rejects.toThrow('CANONICAL_BACKFILL_CONFLICT_REVISION_INVALID')
  })

  it('does not expose another workspace through a copied conflict id', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    const [row] = await repository.enqueue({ workspaceId: 'ws_conflict_owner', runId: 'run_1', conflicts: [{ legacyProductId: 'p1', code: 'MISSING_BRAND', canonicalIds: [] }] })
    await expect(repository.list({ workspaceId: 'ws_conflict_other' })).resolves.toEqual([])
    await expect(repository.claim({ workspaceId: 'ws_conflict_other', id: row!.id, expectedRevision: 1, assigneeId: 'ops-2' })).rejects.toThrow('CANONICAL_BACKFILL_CONFLICT_NOT_FOUND')
  })

  it('queues dangling legacy references and rechecks them within their workspace', async () => {
    const repository = new MemoryCanonicalBackfillConflictRepository()
    const [row] = await repository.enqueue({
      workspaceId: 'ws_dangling_owner',
      runId: 'run_1',
      conflicts: [{ legacyProductId: 'legacy_missing', code: 'CANONICAL_LEGACY_PRODUCT_MISSING', canonicalIds: ['canonical_orphan'] }],
    })
    expect(row).toMatchObject({ code: 'CANONICAL_LEGACY_PRODUCT_MISSING', status: 'open' })
    await expect(repository.list({ workspaceId: 'ws_dangling_other' })).resolves.toEqual([])
    await expect(repository.recheck({
      workspaceId: 'ws_dangling_owner', id: row!.id, expectedRevision: row!.revision,
      observed: { code: 'CANONICAL_LEGACY_PRODUCT_MISSING', canonicalIds: ['canonical_orphan'] },
      evidence: { source: 'migration-prevalidation' },
    })).resolves.toMatchObject({ verificationEvidence: { observedCode: 'CANONICAL_LEGACY_PRODUCT_MISSING' } })
  })
})
