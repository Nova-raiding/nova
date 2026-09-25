import { afterEach, describe, expect, it, vi } from 'vitest'
import { creativePointRequestOwnership } from '../../../packages/application/src/creative-point-reservation-ownership.js'
import { MemoryCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import { providerSucceededButSettlementPending, releaseReservedModelPointsForTests } from './server.js'

describe('creative point reservation release failures', () => {
  afterEach(() => vi.restoreAllMocks())

  async function createReservation() {
    const repository = new MemoryCreativePointRepository()
    const workspaceId = `ws_release_${crypto.randomUUID()}`
    const actionKey = `model:${crypto.randomUUID()}`
    await repository.grant({ workspaceId, idempotencyKey: `grant:${workspaceId}`, sourceType: 'test', sourceId: workspaceId, points: 100 })
    const mutation = await repository.reserve({ workspaceId, actionKey, idempotencyKey: `reserve:${actionKey}`, points: 10, rateCardVersion: 'test-v1' })
    return { repository, workspaceId, actionKey, owner: creativePointRequestOwnership(mutation) }
  }

  it('fails closed with a reconciliation error when release fails and the hold remains active', async () => {
    const context = await createReservation()
    const releaseFailure = Object.assign(new Error('postgres://internal-user:secret@db/private connection reset'), { code: 'DB_CONNECTION_LOST' })
    vi.spyOn(context.repository, 'release').mockRejectedValue(releaseFailure)

    let caught: unknown
    try {
      await releaseReservedModelPointsForTests({ ...context, reason: 'provider call failed' })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: 'CREATIVE_POINT_RELEASE_UNCONFIRMED',
      reconciliationRequired: true,
      details: { action_key: context.actionKey, reservation_status: 'active', release_error: 'DB_CONNECTION_LOST', retryable: false, reconciliation_required: true },
    })
    expect(JSON.stringify((caught as { details?: unknown }).details)).not.toContain('postgres://internal-user:secret@db/private')
    expect(providerSucceededButSettlementPending(caught)).toBe(true)
    expect(await context.repository.getReservationByActionKey(context.workspaceId, context.actionKey)).toMatchObject({ status: 'active' })
  })

  it('treats a release that committed before throwing as confirmed after reread', async () => {
    const context = await createReservation()
    const commit = context.repository.release.bind(context.repository)
    vi.spyOn(context.repository, 'release').mockImplementation(async input => {
      await commit(input)
      throw new Error('connection dropped after commit')
    })

    await expect(releaseReservedModelPointsForTests({ ...context, reason: 'provider call failed' })).resolves.toBeUndefined()
    expect(await context.repository.getReservationByActionKey(context.workspaceId, context.actionKey)).toMatchObject({ status: 'released' })
  })

  it('keeps an unreadable release outcome explicitly pending reconciliation', async () => {
    const context = await createReservation()
    const read = context.repository.getReservationByActionKey.bind(context.repository)
    vi.spyOn(context.repository, 'release').mockRejectedValue(new Error('database connection lost'))
    vi.spyOn(context.repository, 'getReservationByActionKey')
      .mockImplementationOnce(read)
      .mockRejectedValueOnce(new Error('database still unavailable'))

    await expect(releaseReservedModelPointsForTests({ ...context, reason: 'provider call failed' })).rejects.toMatchObject({
      code: 'CREATIVE_POINT_RELEASE_UNCONFIRMED',
      reconciliationRequired: true,
      details: { reservation_status: 'unknown', retryable: false, reconciliation_required: true },
    })
  })
})
