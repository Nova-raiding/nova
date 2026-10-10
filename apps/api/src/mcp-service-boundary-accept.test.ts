import { describe, expect, it, vi } from 'vitest'
import { MemoryOperationsRepository } from '../../../packages/persistence/src/operations-repository.js'
import { handleServiceBoundaryAccept } from './mcp-workspace-setup-handlers.js'

const policyVersion = 'commercial.service-boundary.v1'
const policyChecksum = 'a'.repeat(64)
const required = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${key}`)
  return value
}
const input = (acceptedAt: string, idempotencyKey = 'confirm-1') => ({
  policy_version: policyVersion,
  policy_checksum: policyChecksum,
  acceptance_ref: 'acceptance-1',
  accepted_at: acceptedAt,
  idempotency_key: idempotencyKey,
})

function dependencies() {
  const operations = new MemoryOperationsRepository()
  const appendIfAbsent = vi.spyOn(operations, 'appendIfAbsent')
  return {
    operations,
    appendIfAbsent,
    deps: { required, actorId: () => 'authenticated-owner', policyVersion, policyChecksum, operations },
  }
}

describe('commercial.service-boundary.accept API contract', () => {
  it('replays the same acceptance without appending a second audit fact', async () => {
    const f = dependencies()
    const acceptedAt = '2026-10-10T00:00:00.000Z'

    const first = await handleServiceBoundaryAccept('ws-owner', input(acceptedAt), f.deps)
    const replay = await handleServiceBoundaryAccept('ws-owner', input(acceptedAt), f.deps)

    expect(first).toMatchObject({ accepted: true, replayed: false, customer_subject_ref: 'authenticated-owner' })
    expect(replay).toMatchObject({ accepted: true, replayed: true, acceptance_ref: 'acceptance-1' })
    expect(f.appendIfAbsent).toHaveBeenCalledTimes(2)
    expect(await f.operations.list('ws-owner')).toHaveLength(1)
  })

  it('serializes concurrent acceptance_ref requests so conflicting facts cannot both be recorded', async () => {
    const f = dependencies()
    const firstAt = '2026-10-10T00:00:00.000Z'
    const competingAt = '2026-10-10T00:00:01.000Z'

    const results = await Promise.allSettled([
      handleServiceBoundaryAccept('ws-owner', input(firstAt), f.deps),
      handleServiceBoundaryAccept('ws-owner', input(competingAt, 'confirm-2'), f.deps),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.appendIfAbsent).toHaveBeenCalledTimes(2)
    expect(await f.operations.list('ws-owner')).toHaveLength(1)
  })
})
