import { describe, expect, it, vi } from 'vitest'
import { disposePostgresScopeFixture } from './postgres-scope-fixture-cleanup.js'

const name = 'probe_product_rls_0123456789abcdef0123456789abcdef'
const fixture = () => {
  let elapsed = 0
  const clock = { now: () => elapsed, wait: vi.fn(async (milliseconds: number) => { elapsed += milliseconds }) }
  const admin = { query: vi.fn(async (_sql: string, _values?: string[]) => ({ rows: [{ connections: 0 }] })), end: vi.fn(async () => undefined) }
  const pool = { end: vi.fn(async () => undefined) }
  return { admin, pool, clock }
}

describe('scope PostgreSQL fixture cleanup', () => {
  it('waits for server-side drain after pool.end resolves before dropping the exact fixture', async () => {
    const { admin, pool, clock } = fixture()
    admin.query.mockResolvedValueOnce({ rows: [{ connections: 2 }] }).mockResolvedValueOnce({ rows: [{ connections: 1 }] })
    await disposePostgresScopeFixture(admin, name, [pool, undefined], clock)
    expect(pool.end).toHaveBeenCalledOnce()
    expect(pool.end.mock.invocationCallOrder[0]).toBeLessThan(admin.query.mock.invocationCallOrder[0]!)
    expect(clock.wait).toHaveBeenCalledTimes(2)
    expect(admin.query.mock.calls).toEqual([
      ['SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', [name]],
      ['SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', [name]],
      ['SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', [name]],
      [`DROP DATABASE IF EXISTS "${name}"`],
    ])
    expect(admin.end).toHaveBeenCalledOnce()
  })
  it('fails within five seconds without killing or dropping still-connected backends', async () => {
    const { admin, pool, clock } = fixture()
    admin.query.mockResolvedValue({ rows: [{ connections: 1 }] })
    await expect(disposePostgresScopeFixture(admin, name, [pool], clock)).rejects.toThrow('POSTGRES_SCOPE_FIXTURE_DRAIN_TIMEOUT')
    expect(clock.now()).toBe(5_000)
    expect(admin.query.mock.calls.every(([sql]) => sql.startsWith('SELECT count(*)'))).toBe(true)
    expect(admin.end).toHaveBeenCalledOnce()
  })
  it.each(['merchant', 'probe_product_rls_not-a-uuid', `${name}"; DROP DATABASE merchant;--`])('never touches a non-fixture target: %s', async databaseName => {
    const { admin, pool, clock } = fixture()
    await expect(disposePostgresScopeFixture(admin, databaseName, [pool], clock)).rejects.toThrow('POSTGRES_SCOPE_FIXTURE_NAME_INVALID')
    expect(pool.end).not.toHaveBeenCalled()
    expect(admin.query).not.toHaveBeenCalled()
  })
  it('supports the resource-scope fixture and propagates SQL errors instead of swallowing them', async () => {
    const { admin, pool, clock } = fixture()
    const error = Object.assign(new Error('database connection failure'), { code: '57P01' })
    admin.query.mockRejectedValueOnce(error)
    await expect(disposePostgresScopeFixture(admin, name.replace('product_rls', 'resource_scope'), [pool], clock)).rejects.toBe(error)
    expect(admin.end).toHaveBeenCalledOnce()
  })
  it('propagates pool shutdown errors and never attempts database deletion', async () => {
    const { admin, pool, clock } = fixture()
    const error = new Error('pool shutdown failure')
    pool.end.mockRejectedValueOnce(error)
    await expect(disposePostgresScopeFixture(admin, name, [pool], clock)).rejects.toBe(error)
    expect(admin.query).not.toHaveBeenCalled()
    expect(admin.end).toHaveBeenCalledOnce()
  })
  it('retains the primary acceptance failure and cleanup failure rather than masking either', async () => {
    const { admin, pool, clock } = fixture()
    const primary = new Error('RLS assertion failed')
    const cleanup = new Error('drain query failed')
    admin.query.mockRejectedValueOnce(cleanup)
    await expect(disposePostgresScopeFixture(admin, name, [pool], clock, primary)).rejects.toMatchObject({ cause: primary, errors: [primary, cleanup] })
    expect(admin.end).toHaveBeenCalledOnce()
  })
  it('retains both drain and admin shutdown errors', async () => {
    const { admin, pool, clock } = fixture()
    const drain = new Error('drain query failed')
    const close = new Error('admin shutdown failed')
    admin.query.mockRejectedValueOnce(drain)
    admin.end.mockRejectedValueOnce(close)
    await expect(disposePostgresScopeFixture(admin, name, [pool], clock)).rejects.toMatchObject({ cause: drain, errors: [drain, close] })
  })
  it.each([undefined, -1, 0.5])('fails closed on an invalid backend count: %s', async connections => {
    const { admin, pool, clock } = fixture()
    admin.query.mockResolvedValueOnce({ rows: [{ connections }] } as never)
    await expect(disposePostgresScopeFixture(admin, name, [pool], clock)).rejects.toThrow('POSTGRES_SCOPE_FIXTURE_DRAIN_INVALID')
    expect(admin.query).toHaveBeenCalledOnce()
    expect(admin.end).toHaveBeenCalledOnce()
  })
})
