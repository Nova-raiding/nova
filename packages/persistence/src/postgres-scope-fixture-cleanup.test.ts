import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { disposePostgresScopeFixture, dropDrainedPostgresFixture, POSTGRES_SCOPE_FIXTURE_PREFIXES, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const name = 'probe_product_rls_0123456789abcdef0123456789abcdef'
const expectedSafeFixtureFiles = [
  'packages/persistence/src/application-rls-allow-scope-mismatch.postgres.test.ts',
  'packages/persistence/src/authorization-audit-rls.postgres.test.ts',
  'packages/persistence/src/authorization-event-scope-integrity.postgres.test.ts',
  'packages/persistence/src/authorization-execution-reservation-rls.postgres.test.ts',
  'packages/persistence/src/authorization-rls-probe.postgres.test.ts',
  'packages/persistence/src/brand-profile-association.release.postgres.test.ts',
  'packages/persistence/src/business-repository.postgres.test.ts',
  'packages/persistence/src/campaign-lifecycle.postgres.test.ts',
  'packages/persistence/src/canonical-backfill-run-repository.postgres.test.ts',
  'packages/persistence/src/canonical-product-backfill.postgres.test.ts',
  'packages/persistence/src/commercial-point-adjustment-approval-repository.release.postgres.test.ts',
  'packages/persistence/src/migration-064-release.postgres.test.ts',
  'packages/persistence/src/migration-067-release.postgres.test.ts',
  'packages/persistence/src/migration-069-release.postgres.test.ts',
  'packages/persistence/src/migration-070-072-release.postgres.test.ts',
  'packages/persistence/src/migration-073-release.postgres.test.ts',
  'packages/persistence/src/migration-074-release.postgres.test.ts',
  'packages/persistence/src/migration-077-release.postgres.test.ts',
  'packages/persistence/src/migration-078-release.postgres.test.ts',
  'packages/persistence/src/migration-079-release.postgres.test.ts',
  'packages/persistence/src/migration-105-release.postgres.test.ts',
  'packages/persistence/src/migration-106-release.postgres.test.ts',
  'packages/persistence/src/migration-109-release.postgres.test.ts',
  'packages/persistence/src/migration-118-release.postgres.test.ts',
  'packages/persistence/src/migration-119-120-release.postgres.test.ts',
  'packages/persistence/src/migration-127-release.postgres.test.ts',
  'packages/persistence/src/migration-128-release.postgres.test.ts',
  'packages/persistence/src/migration-129-release.postgres.test.ts',
  'packages/persistence/src/migration-130-release.postgres.test.ts',
  'packages/persistence/src/migration-131-release.postgres.test.ts',
  'packages/persistence/src/migration-136-workspace-audit.postgres.test.ts',
  'packages/persistence/src/migration-137-release.postgres.test.ts',
  'packages/persistence/src/migration-146-release.postgres.test.ts',
  'packages/persistence/src/migration-148-release.postgres.test.ts',
  'packages/persistence/src/migration-164-release.postgres.test.ts',
  'packages/persistence/src/migration-166-release.postgres.test.ts',
  'packages/persistence/src/migration-179-release.postgres.test.ts',
  'packages/persistence/src/migration-203-release.postgres.test.ts',
  'packages/persistence/src/migration-204-release.postgres.test.ts',
  'packages/persistence/src/migration-207-release.postgres.test.ts',
  'packages/persistence/src/migration-208-release.postgres.test.ts',
  'packages/persistence/src/migration-209-release.postgres.test.ts',
  'packages/persistence/src/migration-210-release.postgres.test.ts',
  'packages/persistence/src/migration-211-release.postgres.test.ts',
  'packages/persistence/src/migration-217-release.postgres.test.ts',
  'packages/persistence/src/migration-integrity-release.postgres.test.ts',
  'packages/persistence/src/ops-workspace-summary-rls.postgres.test.ts',
  'packages/persistence/src/password-auth-repository.release.postgres.test.ts',
  'packages/persistence/src/payment-callback-repository.postgres.test.ts',
  'packages/persistence/src/platform-authorization-audit.postgres.test.ts',
  'packages/persistence/src/private-trial-payment.release.postgres.test.ts',
  'packages/persistence/src/image-generation-before-provider.release.postgres.test.ts',
  'packages/persistence/src/service-fulfillment-repository.release.postgres.test.ts',
  'packages/persistence/src/workspace-content-setup-repository.release.postgres.test.ts',
  'tests/mcp-oauth-commercial-payment.postgres.test.ts',
] as const
const fixture = () => {
  let elapsed = 0
  const clock = { now: () => elapsed, wait: vi.fn(async (milliseconds: number) => { elapsed += milliseconds }) }
  const admin = { query: vi.fn(async (_sql: string | { text: string; values: string[]; query_timeout: number }, _values?: string[]) => ({ rows: [{ connections: 0 }] })), end: vi.fn(async () => undefined) }
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
      [{ text: 'SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', values: [name], query_timeout: 1_000 }],
      [{ text: 'SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', values: [name], query_timeout: 1_000 }],
      [{ text: 'SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', values: [name], query_timeout: 1_000 }],
      [`DROP DATABASE IF EXISTS "${name}"`],
    ])
    expect(admin.end).toHaveBeenCalledOnce()
  })
  it('fails within five seconds without killing or dropping still-connected backends', async () => {
    const { admin, pool, clock } = fixture()
    admin.query.mockResolvedValue({ rows: [{ connections: 1 }] })
    await expect(disposePostgresScopeFixture(admin, name, [pool], clock)).rejects.toThrow('POSTGRES_SCOPE_FIXTURE_DRAIN_TIMEOUT')
    expect(clock.now()).toBe(5_000)
    expect(admin.query.mock.calls.every(([sql]) => typeof sql === 'object' && sql.text.startsWith('SELECT count(*)'))).toBe(true)
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
  it.each(POSTGRES_SCOPE_FIXTURE_PREFIXES)('allows only the inventoried UUID fixture and leaves admin open for multi-DB cleanup: %s', async prefix => {
    const { admin, clock } = fixture()
    const databaseName = `${prefix}0123456789abcdef0123456789abcdef`
    await dropDrainedPostgresFixture(admin, databaseName, clock)
    expect(admin.query.mock.calls.at(-1)).toEqual([`DROP DATABASE IF EXISTS "${databaseName}"`])
    expect(admin.end).not.toHaveBeenCalled()
  })
  it.each(['release_999_', 'release_', 'probe_uninventoried_'])('rejects broad or uninventoried prefixes before any SQL: %s', async prefix => {
    const { admin, clock } = fixture()
    await expect(dropDrainedPostgresFixture(admin, `${prefix}0123456789abcdef0123456789abcdef`, clock)).rejects.toThrow('POSTGRES_SCOPE_FIXTURE_NAME_INVALID')
    expect(admin.query).not.toHaveBeenCalled()
  })
  it('still attempts ordered role/admin/temp finalizers after the first multi-DB cleanup failure and exposes every error', async () => {
    const primary = new Error('RLS assertion failed')
    const drain = new Error('first fixture failed to drain')
    const role = new Error('probe role is still referenced')
    const order: string[] = []
    await expect(withPostgresFixtureCleanup(async () => {
      order.push('first-db')
      throw drain
    }, primary, [
      async () => { order.push('role'); throw role },
      async () => { order.push('admin') },
      async () => { order.push('temporary') },
    ])).rejects.toMatchObject({ cause: primary, errors: [primary, drain, role] })
    expect(order).toEqual(['first-db', 'role', 'admin', 'temporary'])
  })
  it('inventory guards prevent reintroducing forced backend termination or unapproved fixture prefixes', () => {
    const root = resolve(import.meta.dirname, '../../..')
    const records = ['packages/persistence/src', 'apps/worker/src', 'tests'].flatMap(directory =>
      readdirSync(resolve(root, directory)).filter(file => file.endsWith('.postgres.test.ts'))
        .map(file => ({ file: `${directory}/${file}`, source: readFileSync(resolve(root, directory, file), 'utf8') })))
    const files = records.map(record => record.source)
    expect(files.filter(source => source.includes('pg_terminate_backend'))).toEqual([])
    // The approved fixtures cannot disappear or bypass safe cleanup. Future
    // safe fixtures are checked too, without relying on a magic file count.
    for (const file of expectedSafeFixtureFiles) {
      const record = records.find(item => item.file === file)
      expect(record, file).toBeDefined()
      expect(record!.source, file).toMatch(/dropDrainedPostgresFixture|disposePostgresScopeFixture/u)
      expect(record!.source, file).toContain('primaryFailure')
      expect(record!.source, file).not.toMatch(/admin\.query\(\s*`DROP DATABASE/gu)
    }
    const drained = files.filter(source => /dropDrainedPostgresFixture|disposePostgresScopeFixture/u.test(source))
    for (const source of drained) {
      expect(source).toContain('primaryFailure')
      for (const match of source.matchAll(/const (?:databaseName|name|freshName|upgradeName|restoreName) = `([a-z0-9_]+)\$\{/gu)) {
        expect(POSTGRES_SCOPE_FIXTURE_PREFIXES).toContain(match[1])
      }
    }
  })

})
