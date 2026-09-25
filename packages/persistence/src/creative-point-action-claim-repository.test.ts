import { describe, expect, it } from 'vitest'
import { MemoryCreativeActionClaimRepository } from './creative-point-action-claim-repository.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const client = { query: async () => ({ rows: [] }) } as never

describe('enqueue action ownership', () => {
  it('admits one owner, fences old epochs, and never reacquires a bound action', async () => {
    const repo = new MemoryCreativeActionClaimRepository()
    const input = { workspaceId: 'ws_claim', actionKey: 'model:generation:one', intentSha256: A, leaseMs: 60_000 }
    const attempts = await Promise.allSettled([repo.claim(input), repo.claim(input)])
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    const owner = (attempts.find(attempt => attempt.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.claim>>>).value
    await expect(repo.claim({ ...input, intentSha256: B })).rejects.toMatchObject({ code: 'CREATIVE_ACTION_INTENT_MISMATCH' })
    await repo.releaseUnbound(owner)
    const next = await repo.claim(input)
    expect(next.ownerEpoch).toBe(owner.ownerEpoch + 1)
    await expect(repo.releaseUnbound(owner)).rejects.toMatchObject({ code: 'CREATIVE_ACTION_STALE_OWNER' })
    await expect(repo.bindInTransaction(client, { ...owner, reservationId: 'r', jobId: 'j', eventId: 'e' })).rejects.toMatchObject({ code: 'CREATIVE_ACTION_STALE_OWNER' })
    const bound = await repo.bindInTransaction(client, { ...next, reservationId: 'r', jobId: 'j', eventId: 'e' })
    expect(bound).toMatchObject({ phase: 'bound', reservationId: 'r', jobId: 'j', eventId: 'e' })
    await expect(repo.claim(input)).rejects.toMatchObject({ code: 'CREATIVE_ACTION_BOUND_RECOVERY_REQUIRED' })
    await expect(repo.releaseUnbound(next)).rejects.toMatchObject({ code: 'CREATIVE_ACTION_STALE_OWNER' })
  })
})
