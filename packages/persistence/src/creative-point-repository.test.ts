import { describe, expect, it } from 'vitest'
import { MemoryCreativePointRepository, PostgresCreativePointRepository } from './creative-point-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

describe('creative point repository', () => {
  it('keeps a missing balance unknown and fails closed before a first grant', async () => {
    const repository = new MemoryCreativePointRepository()
    await expect(repository.getBalance('ws-a')).resolves.toMatchObject({ availablePoints: null, reservedPoints: null, settledPoints: null, revision: 0 })
    await expect(repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-1', actionKey: 'image.generate', rateCardVersion: 'image-v1', points: 1 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
  })

  it('grants, reserves, releases, and settles without converting any legacy balance', async () => {
    const repository = new MemoryCreativePointRepository()
    const granted = await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-1', sourceType: 'paid_order', sourceId: 'order-1', points: 500 })
    expect(granted.balance).toMatchObject({ availablePoints: 500, reservedPoints: 0, settledPoints: 0, revision: 1 })

    const first = await repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-1', actionKey: 'image.generate', rateCardVersion: 'image-v1', points: 90 })
    expect(first.balance).toMatchObject({ availablePoints: 410, reservedPoints: 90, settledPoints: 0, revision: 2 })
    const released = await repository.release({ workspaceId: 'ws-a', idempotencyKey: 'release-1', reservationId: first.value.id })
    expect(released.balance).toMatchObject({ availablePoints: 500, reservedPoints: 0, settledPoints: 0, revision: 3 })

    const second = await repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-2', actionKey: 'image.generate', rateCardVersion: 'image-v1', points: 90 })
    const settled = await repository.settle({ workspaceId: 'ws-a', idempotencyKey: 'settle-1', reservationId: second.value.id, actualPoints: 80 })
    expect(settled.value).toMatchObject({ status: 'settled', settledPoints: 80 })
    expect(settled.balance).toMatchObject({ availablePoints: 420, reservedPoints: 0, settledPoints: 80, revision: 5 })
  })

  it('is idempotent and prevents concurrent over-reservation', async () => {
    const repository = new MemoryCreativePointRepository()
    const input = { workspaceId: 'ws-a', idempotencyKey: 'grant-1', sourceType: 'monthly_period', sourceId: 'period-1', points: 100 }
    const [left, right] = await Promise.all([repository.grant(input), repository.grant(input)])
    expect(right.value.id).toBe(left.value.id)
    expect((await repository.getBalance('ws-a')).availablePoints).toBe(100)

    const results = await Promise.allSettled([
      repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-a', actionKey: 'video.generate', rateCardVersion: 'video-v1', points: 80 }),
      repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-b', actionKey: 'video.generate', rateCardVersion: 'video-v1', points: 80 }),
    ])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect(await repository.getBalance('ws-a')).toMatchObject({ availablePoints: 20, reservedPoints: 80 })
  })

  it('rejects an idempotency key or natural grant source reused with different facts', async () => {
    const repository = new MemoryCreativePointRepository()
    await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-1', sourceType: 'paid_order', sourceId: 'order-1', points: 100 })
    await expect(repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-1', sourceType: 'paid_order', sourceId: 'order-1', points: 101 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    await expect(repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-2', sourceType: 'paid_order', sourceId: 'order-1', points: 101 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    expect(await repository.getBalance('ws-a')).toMatchObject({ availablePoints: 100, revision: 1 })

    const reservation = await repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-1', actionKey: 'image.generate', rateCardVersion: 'image-v1', points: 20 })
    await expect(repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-1', actionKey: 'image.generate', rateCardVersion: 'image-v2', points: 20 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    await repository.settle({ workspaceId: 'ws-a', idempotencyKey: 'settle-1', reservationId: reservation.value.id, actualPoints: 20 })
    await expect(repository.settle({ workspaceId: 'ws-a', idempotencyKey: 'settle-1', reservationId: reservation.value.id, actualPoints: 19 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
  })

  it('supports a positive settlement adjustment without restoring expired points', async () => {
    const repository = new MemoryCreativePointRepository()
    await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-1', sourceType: 'monthly_period', sourceId: 'period-1', points: 200, expiresAt: '2026-02-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' })
    const reservation = await repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-1', actionKey: 'video.generate', rateCardVersion: 'video-v1', points: 90, at: '2026-01-02T00:00:00.000Z' })
    const adjusted = await repository.settle({ workspaceId: 'ws-a', idempotencyKey: 'settle-1', reservationId: reservation.value.id, actualPoints: 120, at: '2026-01-03T00:00:00.000Z' })
    expect(adjusted.balance).toMatchObject({ availablePoints: 80, settledPoints: 120 })

    const expiring = new MemoryCreativePointRepository()
    await expiring.grant({ workspaceId: 'ws-b', idempotencyKey: 'grant-1', sourceType: 'monthly_period', sourceId: 'period-1', points: 50, expiresAt: '2026-02-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' })
    const held = await expiring.reserve({ workspaceId: 'ws-b', idempotencyKey: 'reserve-1', actionKey: 'image.generate', rateCardVersion: 'image-v1', points: 40, at: '2026-01-02T00:00:00.000Z' })
    const released = await expiring.release({ workspaceId: 'ws-b', idempotencyKey: 'release-1', reservationId: held.value.id, at: '2026-02-01T00:00:00.000Z' })
    expect(released.balance).toMatchObject({ availablePoints: 0, reservedPoints: 0, settledPoints: 0 })
  })

  it('reads reservation status and frozen rate-card intent as tenant-scoped facts without inventing a TTL', async () => {
    const repository = new MemoryCreativePointRepository()
    await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-1', sourceType: 'paid_order', sourceId: 'order-1', points: 100, expiresAt: '2026-02-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' })
    const reserved = await repository.reserve({ workspaceId: 'ws-a', idempotencyKey: 'reserve-1', actionKey: 'video.generate', points: 90, rateCardVersion: 'video-v3', at: '2026-01-01T00:00:00.000Z' })

    await expect(repository.getReservation('ws-a', reserved.value.id, '2026-01-31T23:59:59.999Z')).resolves.toMatchObject({ status: 'active', persistedStatus: 'active', actionKey: 'video.generate', points: 90, rateCardVersion: 'video-v3', intent: { action_key: 'video.generate', points: 90, rate_card_version: 'video-v3' } })
    await expect(repository.getReservation('ws-a', reserved.value.id, '2027-02-01T00:00:00.000Z')).resolves.toMatchObject({ status: 'active', persistedStatus: 'active', rateCardVersion: 'video-v3' })
    await expect(repository.getReservation('ws-b', reserved.value.id)).resolves.toBeNull()
    await expect(repository.getReservation('ws-a', 'missing')).resolves.toBeNull()
  })

  it('queries PostgreSQL reservations with both tenant and reservation predicates', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const client: SqlClient = {
      async query<Row>(text: string, values?: readonly unknown[]) { calls.push({ text, values }); return { rows: [] as Row[] } },
      release() {},
    }
    const pool: SqlPool = { async connect() { return client } }
    const repository = new PostgresCreativePointRepository(pool)
    await expect(repository.getReservation('ws-a', 'reservation-a')).resolves.toBeNull()
    const query = calls.find(call => call.text.includes('FROM creative_point_reservations r'))
    expect(query?.text).toContain('WHERE r.workspace_id=$1 AND r.id=$2')
    expect(query?.values).toEqual(['ws-a', 'reservation-a'])
    expect(calls.find(call => call.text.includes("set_config('app.workspace_id'"))?.values).toEqual(['ws-a'])
  })

  it('uses only explicitly supplied expiry and never invents one', async () => {
    const repository = new MemoryCreativePointRepository()
    const permanent = await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-permanent', sourceType: 'recharge', sourceId: 'order-1', points: 50, at: '2026-01-01T00:00:00.000Z' })
    const expiring = await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'grant-expiring', sourceType: 'monthly_period', sourceId: 'period-1', points: 50, expiresAt: '2026-02-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' })
    expect(permanent.value.expiresAt).toBeNull()
    expect(expiring.value.expiresAt).toBe('2026-02-01T00:00:00.000Z')
    expect(await repository.getBalance('ws-a', '2026-02-01T00:00:00.000Z')).toMatchObject({ availablePoints: 50 })
    expect(await repository.getBalanceDetails('ws-a', '2026-01-15T00:00:00.000Z')).toMatchObject({ nextExpiry: '2026-02-01T00:00:00.000Z', expiringPoints: 50 })
    expect(await new MemoryCreativePointRepository().getBalanceDetails('ws-unknown')).toMatchObject({ availablePoints: null, nextExpiry: null, expiringPoints: null })
  })

  it('paginates a tenant-scoped statement by stable created-at and id cursor', async () => {
    const repository = new MemoryCreativePointRepository()
    await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'g1', sourceType: 'paid_order', sourceId: 'o1', points: 10, at: '2026-01-01T00:00:00.000Z' })
    await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'g2', sourceType: 'paid_order', sourceId: 'o2', points: 20, at: '2026-01-02T00:00:00.000Z' })
    await repository.grant({ workspaceId: 'ws-a', idempotencyKey: 'g3', sourceType: 'paid_order', sourceId: 'o3', points: 30, at: '2026-01-03T00:00:00.000Z' })
    const first = await repository.listStatement('ws-a', { limit: 2 })
    expect(first.items.map(item => item.grantSourceId)).toEqual(['o3', 'o2'])
    expect(first.nextCursor).toEqual({ createdAt: first.items[1]!.createdAt, id: first.items[1]!.id })
    const second = await repository.listStatement('ws-a', { limit: 2, cursor: first.nextCursor! })
    expect(second.items.map(item => item.grantSourceId)).toEqual(['o1'])
    expect(second.nextCursor).toBeNull()
    await expect(repository.listStatement('ws-b')).resolves.toEqual({ items: [], nextCursor: null })
    await expect(repository.listStatement('ws-a', { limit: 101 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_INPUT_INVALID' })
  })
})
