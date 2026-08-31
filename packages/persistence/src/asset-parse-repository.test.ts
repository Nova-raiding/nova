import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { AssetParseRepositoryError, MemoryAssetParseRepository, PostgresAssetParseRepository } from './asset-parse-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import type { SqlClient, SqlPool } from './repository.js'

const postgresIt = process.env.ASSET_PARSE_DATABASE_URL ? it : it.skip
const t = (milliseconds: number) => new Date(Date.parse('2099-01-01T00:00:00.000Z') + milliseconds).toISOString()

describe('MemoryAssetParseRepository', () => {
  it('recovers at the exact expiry boundary and rejects both stale success and stale failure', async () => {
    const repository = new MemoryAssetParseRepository()
    const first = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_a', leaseMs: 100, now: t(0) })
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_a', leaseMs: 100, now: t(99) })).rejects.toMatchObject({ code: 'ASSET_PARSE_BUSY' })
    const second = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_a', leaseMs: 100, now: t(100) })

    expect(second.attempts).toBe(2)
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_a', leaseToken: first.leaseToken, facts: { title: 'stale' }, now: t(120) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.fail({ workspaceId: 'ws_a', assetId: 'asset_a', leaseToken: first.leaseToken, errorCode: 'STALE', errorMessage: 'stale', retryable: true, now: t(120) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_a', leaseToken: second.leaseToken, facts: { title: 'fresh' }, now: t(150) })).resolves.toMatchObject({ state: 'succeeded', attempts: 2, facts: { title: 'fresh' } })
  })

  it('rejects fail at expiry and never lets success be overwritten', async () => {
    const repository = new MemoryAssetParseRepository()
    const expired = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_expired', leaseMs: 100, now: t(0) })
    await expect(repository.fail({ workspaceId: 'ws_a', assetId: 'asset_expired', leaseToken: expired.leaseToken, errorCode: 'LATE', errorMessage: 'late', retryable: true, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })

    const active = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_success', leaseMs: 100, now: t(0) })
    const succeeded = await repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_success', leaseToken: active.leaseToken, facts: { title: 'final' }, now: t(50) })
    await expect(repository.fail({ workspaceId: 'ws_a', assetId: 'asset_success', leaseToken: active.leaseToken, errorCode: 'LATE', errorMessage: 'late', retryable: false, now: t(60) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_success', leaseToken: active.leaseToken, facts: { title: 'overwrite' }, now: t(60) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_success', leaseMs: 100, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ALREADY_SUCCEEDED' })
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_success' })).resolves.toEqual(succeeded)
  })

  it('rejects a backdated completion time without changing the active lease', async () => {
    const repository = new MemoryAssetParseRepository()
    const claim = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_clock', leaseMs: 100, now: t(50) })
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_clock', leaseToken: claim.leaseToken, facts: { invalid: true }, now: t(49) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.fail({ workspaceId: 'ws_a', assetId: 'asset_clock', leaseToken: claim.leaseToken, errorCode: 'BACKDATED', errorMessage: 'backdated', retryable: true, now: t(49) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_clock', leaseToken: claim.leaseToken, facts: { valid: true }, now: t(60) })).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('expires only the matching lease at or after its deadline', async () => {
    const repository = new MemoryAssetParseRepository()
    const lease = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_timeout', leaseMs: 100, now: t(0) })
    await expect(repository.expire({ workspaceId: 'ws_a', assetId: 'asset_timeout', leaseToken: lease.leaseToken, now: t(99) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.expire({ workspaceId: 'ws_a', assetId: 'asset_timeout', leaseToken: lease.leaseToken, now: t(100) })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_TIMEOUT', retryable: true })
  })

  it('never lets stale expiry overwrite a replacement lease or success', async () => {
    const repository = new MemoryAssetParseRepository()
    const stale = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_expire_race', leaseMs: 100, now: t(0) })
    const replacement = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_expire_race', leaseMs: 100, now: t(100) })
    await expect(repository.expire({ workspaceId: 'ws_a', assetId: 'asset_expire_race', leaseToken: stale.leaseToken, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_expire_race' })).resolves.toMatchObject({ state: 'processing', leaseToken: replacement.leaseToken })
    const succeeded = await repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_expire_race', leaseToken: replacement.leaseToken, facts: { title: 'safe' }, now: t(150) })
    await expect(repository.expire({ workspaceId: 'ws_a', assetId: 'asset_expire_race', leaseToken: replacement.leaseToken, now: t(200) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_expire_race' })).resolves.toEqual(succeeded)
  })

  it('atomically confirms manual facts and invalidates every old lease outcome', async () => {
    const repository = new MemoryAssetParseRepository()
    const lease = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_manual', leaseMs: 100, now: t(0) })
    const manual = await repository.confirm({ workspaceId: 'ws_a', assetId: 'asset_manual', facts: { title: 'merchant' }, now: t(10) })
    expect(manual).toMatchObject({ state: 'succeeded', facts: { title: 'merchant' }, attempts: 1 })
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_manual', leaseToken: lease.leaseToken, facts: { title: 'stale' }, now: t(20) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.fail({ workspaceId: 'ws_a', assetId: 'asset_manual', leaseToken: lease.leaseToken, errorCode: 'LATE', errorMessage: 'late', retryable: true, now: t(20) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.expire({ workspaceId: 'ws_a', assetId: 'asset_manual', leaseToken: lease.leaseToken, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_manual' })).resolves.toEqual(manual)
  })

  it('terminalizes retryable work at the maximum and respects nonretryable failure', async () => {
    const repository = new MemoryAssetParseRepository()
    const first = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_retry', leaseMs: 100, maxAttempts: 2, now: t(0) })
    await repository.fail({ workspaceId: 'ws_a', assetId: 'asset_retry', leaseToken: first.leaseToken, errorCode: 'OCR_TIMEOUT', errorMessage: 'timeout', retryable: true, now: t(50) })
    const second = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_retry', leaseMs: 100, maxAttempts: 2, now: t(60) })
    await repository.fail({ workspaceId: 'ws_a', assetId: 'asset_retry', leaseToken: second.leaseToken, errorCode: 'OCR_TIMEOUT', errorMessage: 'timeout', retryable: true, now: t(70) })
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_retry', leaseMs: 100, maxAttempts: 2, now: t(80) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_retry' })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED', retryable: false })

    const terminal = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_terminal', leaseMs: 100, now: t(0) })
    await repository.fail({ workspaceId: 'ws_a', assetId: 'asset_terminal', leaseToken: terminal.leaseToken, errorCode: 'CORRUPT', errorMessage: 'corrupt', retryable: false, now: t(50) })
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_terminal', leaseMs: 100, maxAttempts: 10, now: t(60) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })
  })

  it('commits terminal failure when the final processing lease expires', async () => {
    const repository = new MemoryAssetParseRepository()
    await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_final', leaseMs: 10, maxAttempts: 1, now: t(0) })
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_final', leaseMs: 10, maxAttempts: 1, now: t(10) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_final' })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED', retryable: false })
  })

  it('rejects empty, undefined and non-serializable facts without consuming the lease', async () => {
    const repository = new MemoryAssetParseRepository()
    const claim = await repository.claim({ workspaceId: 'ws_a', assetId: 'asset_facts', leaseMs: 100, now: t(0) })
    for (const facts of [{}, { omitted: undefined }, undefined, null, { value: 1n }]) {
      await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_facts', leaseToken: claim.leaseToken, facts: facts as Record<string, unknown>, now: t(10) })).rejects.toMatchObject({ code: 'ASSET_PARSE_EMPTY' })
    }
    await expect(repository.succeed({ workspaceId: 'ws_a', assetId: 'asset_facts', leaseToken: claim.leaseToken, facts: { title: 'kept', omitted: undefined }, now: t(20) })).resolves.toMatchObject({ facts: { title: 'kept' } })
  })

  it.each([
    { assetId: '', leaseMs: 100, now: t(0) },
    { assetId: `asset_${'x'.repeat(256)}`, leaseMs: 100, now: t(0) },
    { assetId: 'asset\u0000evil', leaseMs: 100, now: t(0) },
    { assetId: 'asset', leaseMs: 0, now: t(0) },
    { assetId: 'asset', leaseMs: 86_400_001, now: t(0) },
    { assetId: 'asset', leaseMs: 1.5, now: t(0) },
    { assetId: 'asset', leaseMs: 100, now: '2099-01-01' },
    { assetId: 'asset', leaseMs: 100, now: '2099-02-30T00:00:00.000Z' },
  ])('rejects malicious identifiers, lease values or timestamps before mutation: %o', async input => {
    const repository = new MemoryAssetParseRepository()
    await expect(repository.claim({ workspaceId: 'ws_a', ...input })).rejects.toBeInstanceOf(Error)
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset' })).resolves.toBeUndefined()
  })

  it('isolates identical asset ids by workspace', async () => {
    const repository = new MemoryAssetParseRepository()
    const a = await repository.claim({ workspaceId: 'ws_a', assetId: 'same', leaseMs: 100, now: t(0) })
    const b = await repository.claim({ workspaceId: 'ws_b', assetId: 'same', leaseMs: 100, now: t(0) })
    await expect(repository.succeed({ workspaceId: 'ws_b', assetId: 'same', leaseToken: a.leaseToken, facts: { leaked: true }, now: t(10) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
    expect(a.leaseToken).not.toBe(b.leaseToken)
  })
})

type TestRow = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  readonly responses: Array<{ rows: TestRow[] }> = []
  released = false
  failPattern?: RegExp

  enqueue(rows: TestRow[] = []) { this.responses.push({ rows }) }
  async query<Row = TestRow>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (this.failPattern?.test(text)) throw new Error('database write failed')
    return (this.responses.shift() ?? { rows: [] }) as { rows: Row[] }
  }
  release() { this.released = true }
}

class RecordingPool implements SqlPool {
  connections = 0
  constructor(readonly client: RecordingClient) {}
  async connect() { this.connections += 1; return this.client }
}

describe('PostgresAssetParseRepository SQL contract', () => {
  it('parameterizes malicious-looking values and scopes the transaction', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue([{ workspace_id: "ws_' OR true --", asset_id: "asset_' OR true --", state: 'processing', attempts: 1, lease_token: 'lease', lease_until: t(100), facts: null, error_code: null, error_message: null, retryable: true, updated_at: t(0) }])
    client.enqueue()
    const repository = new PostgresAssetParseRepository(new RecordingPool(client))
    await repository.claim({ workspaceId: "ws_' OR true --", assetId: "asset_' OR true --", leaseMs: 100, now: t(0) })

    const insert = client.calls.find(call => call.text.includes('INSERT INTO asset_parse_leases'))
    expect(insert?.text).not.toContain("asset_' OR true --")
    expect(insert?.values?.slice(0, 2)).toEqual(["ws_' OR true --", "asset_' OR true --"])
    expect(client.calls.map(call => call.text.trim())).toEqual(['BEGIN', "SELECT set_config('app.workspace_id', $1, true)", expect.stringContaining('INSERT INTO asset_parse_leases'), 'COMMIT'])
  })

  it('rolls back and releases the connection after a database error', async () => {
    const client = new RecordingClient()
    client.failPattern = /INSERT INTO asset_parse_leases/u
    const pool = new RecordingPool(client)
    const repository = new PostgresAssetParseRepository(pool)
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_a', leaseMs: 100, now: t(0) })).rejects.toThrow('database write failed')
    expect(client.calls.map(call => call.text.trim())).toEqual(['BEGIN', "SELECT set_config('app.workspace_id', $1, true)", expect.stringContaining('INSERT INTO asset_parse_leases'), 'ROLLBACK'])
    expect(client.released).toBe(true)
  })

  it('atomically replaces an active lease with manually confirmed facts', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue([{ workspace_id: 'ws_a', asset_id: 'asset_manual', state: 'succeeded', attempts: 2, lease_token: null, lease_until: null, facts: { title: 'merchant' }, error_code: null, error_message: null, retryable: false, updated_at: t(20) }])
    client.enqueue()
    const repository = new PostgresAssetParseRepository(new RecordingPool(client))
    await expect(repository.confirm({ workspaceId: 'ws_a', assetId: 'asset_manual', facts: { title: 'merchant' }, now: t(20) })).resolves.toMatchObject({ state: 'succeeded', facts: { title: 'merchant' } })
    const statement = client.calls.find(call => call.text.includes('ON CONFLICT (workspace_id,asset_id) DO UPDATE'))
    expect(statement?.text).toContain("state='succeeded', lease_token=NULL, lease_until=NULL")
    expect(statement?.values?.slice(0, 3)).toEqual(['ws_a', 'asset_manual', JSON.stringify({ title: 'merchant' })])
  })

  it('rejects invalid inputs before opening a connection', async () => {
    const pool = new RecordingPool(new RecordingClient())
    const repository = new PostgresAssetParseRepository(pool)
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: '', leaseMs: 100 })).rejects.toBeInstanceOf(Error)
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset', leaseMs: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(RangeError)
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset', leaseMs: 100, now: 'now()' })).rejects.toBeInstanceOf(RangeError)
    expect(pool.connections).toBe(0)
  })
})

describe('PostgresAssetParseRepository integration', () => {
  postgresIt('enforces leases, terminal transitions and workspace RLS across connections', async () => {
    const adminUrl = new URL(process.env.ASSET_PARSE_DATABASE_URL!)
    const databaseName = `asset_parse_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(adminUrl)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`INSERT INTO workspaces (id, status) VALUES ('ws_parse', 'active'), ('ws_other', 'active')`)

      const appUrl = new URL(databaseUrl)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      appA = new Pool({ connectionString: appUrl.toString(), max: 2 })
      appB = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const repositoryA = new PostgresAssetParseRepository(appA)
      const repositoryB = new PostgresAssetParseRepository(appB)

      const claims = await Promise.allSettled([
        repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseMs: 100, now: t(0) }),
        repositoryB.claim({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseMs: 100, now: t(0) }),
      ])
      const winner = claims.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repositoryA.claim>>> => result.status === 'fulfilled')
      expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(claims.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'ASSET_PARSE_BUSY' } })

      const replacement = await repositoryB.claim({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseMs: 100, now: t(100) })
      await expect(repositoryA.succeed({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseToken: winner!.value.leaseToken, facts: { stale: true }, now: t(120) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryA.fail({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseToken: winner!.value.leaseToken, errorCode: 'STALE', errorMessage: 'stale', retryable: true, now: t(120) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      const succeeded = await repositoryB.succeed({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseToken: replacement.leaseToken, facts: { title: 'durable' }, now: t(150) })
      await expect(repositoryA.fail({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseToken: replacement.leaseToken, errorCode: 'LATE', errorMessage: 'late', retryable: false, now: t(160) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_shared', leaseMs: 100, now: t(200) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ALREADY_SUCCEEDED' })
      await expect(repositoryA.get({ workspaceId: 'ws_parse', assetId: 'asset_shared' })).resolves.toEqual(succeeded)

      const manualLease = await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_manual', leaseMs: 100, now: t(0) })
      const manual = await repositoryB.confirm({ workspaceId: 'ws_parse', assetId: 'asset_manual', facts: { title: 'merchant' }, now: t(10) })
      await expect(repositoryA.succeed({ workspaceId: 'ws_parse', assetId: 'asset_manual', leaseToken: manualLease.leaseToken, facts: { title: 'stale' }, now: t(20) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryA.fail({ workspaceId: 'ws_parse', assetId: 'asset_manual', leaseToken: manualLease.leaseToken, errorCode: 'LATE', errorMessage: 'late', retryable: true, now: t(20) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryA.expire({ workspaceId: 'ws_parse', assetId: 'asset_manual', leaseToken: manualLease.leaseToken, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryA.get({ workspaceId: 'ws_parse', assetId: 'asset_manual' })).resolves.toEqual(manual)

      const expired = await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_expired', leaseMs: 100, now: t(0) })
      await expect(repositoryB.fail({ workspaceId: 'ws_parse', assetId: 'asset_expired', leaseToken: expired.leaseToken, errorCode: 'LATE', errorMessage: 'late', retryable: true, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })

      const timeout = await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_timeout', leaseMs: 100, now: t(0) })
      await expect(repositoryB.expire({ workspaceId: 'ws_parse', assetId: 'asset_timeout', leaseToken: timeout.leaseToken, now: t(99) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryB.expire({ workspaceId: 'ws_parse', assetId: 'asset_timeout', leaseToken: timeout.leaseToken, now: t(100) })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_TIMEOUT', retryable: true })

      const staleExpiry = await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_expire_race', leaseMs: 100, now: t(0) })
      const currentExpiry = await repositoryB.claim({ workspaceId: 'ws_parse', assetId: 'asset_expire_race', leaseMs: 100, now: t(100) })
      await expect(repositoryA.expire({ workspaceId: 'ws_parse', assetId: 'asset_expire_race', leaseToken: staleExpiry.leaseToken, now: t(100) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      const expirySuccess = await repositoryB.succeed({ workspaceId: 'ws_parse', assetId: 'asset_expire_race', leaseToken: currentExpiry.leaseToken, facts: { title: 'preserved' }, now: t(150) })
      await expect(repositoryA.expire({ workspaceId: 'ws_parse', assetId: 'asset_expire_race', leaseToken: currentExpiry.leaseToken, now: t(200) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
      await expect(repositoryA.get({ workspaceId: 'ws_parse', assetId: 'asset_expire_race' })).resolves.toEqual(expirySuccess)

      await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_final', leaseMs: 10, maxAttempts: 1, now: t(0) })
      await expect(repositoryB.claim({ workspaceId: 'ws_parse', assetId: 'asset_final', leaseMs: 10, maxAttempts: 1, now: t(10) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })
      await expect(repositoryA.get({ workspaceId: 'ws_parse', assetId: 'asset_final' })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED', retryable: false })
      await expect(database.query(`SELECT state, lease_token, lease_until FROM asset_parse_leases WHERE workspace_id='ws_parse' AND asset_id='asset_final'`)).resolves.toMatchObject({ rows: [{ state: 'failed', lease_token: null, lease_until: null }] })

      const retryOne = await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_retry', leaseMs: 100, maxAttempts: 2, now: t(0) })
      await repositoryA.fail({ workspaceId: 'ws_parse', assetId: 'asset_retry', leaseToken: retryOne.leaseToken, errorCode: 'TIMEOUT', errorMessage: 'timeout', retryable: true, now: t(10) })
      const retryTwo = await repositoryB.claim({ workspaceId: 'ws_parse', assetId: 'asset_retry', leaseMs: 100, maxAttempts: 2, now: t(20) })
      await repositoryB.fail({ workspaceId: 'ws_parse', assetId: 'asset_retry', leaseToken: retryTwo.leaseToken, errorCode: 'TIMEOUT', errorMessage: 'timeout', retryable: true, now: t(30) })
      await expect(repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_retry', leaseMs: 100, maxAttempts: 2, now: t(40) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })
      await expect(repositoryA.get({ workspaceId: 'ws_parse', assetId: 'asset_retry' })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED', retryable: false })

      const terminal = await repositoryA.claim({ workspaceId: 'ws_parse', assetId: 'asset_terminal', leaseMs: 100, now: t(0) })
      await repositoryA.fail({ workspaceId: 'ws_parse', assetId: 'asset_terminal', leaseToken: terminal.leaseToken, errorCode: 'CORRUPT', errorMessage: 'corrupt', retryable: false, now: t(50) })
      await expect(repositoryB.claim({ workspaceId: 'ws_parse', assetId: 'asset_terminal', leaseMs: 100, maxAttempts: 10, now: t(60) })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })

      await expect(repositoryA.succeed({ workspaceId: 'ws_parse', assetId: 'asset_missing_facts', leaseToken: 'lease', facts: undefined as unknown as Record<string, unknown>, now: t(0) })).rejects.toMatchObject({ code: 'ASSET_PARSE_EMPTY' })
      await expect(repositoryB.succeed({ workspaceId: 'ws_other', assetId: 'asset_shared', leaseToken: replacement.leaseToken, facts: { leaked: true }, now: t(150) })).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })

      const rlsClient = await appA.connect()
      try {
        await rlsClient.query('BEGIN')
        await rlsClient.query(`SELECT set_config('app.workspace_id', 'ws_other', true)`)
        await expect(rlsClient.query(`SELECT asset_id FROM asset_parse_leases WHERE workspace_id='ws_parse'`)).resolves.toMatchObject({ rows: [] })
        await rlsClient.query('ROLLBACK')
      } finally {
        rlsClient.release()
      }

      await expect(database.query(`INSERT INTO asset_parse_leases (workspace_id,asset_id,state,attempts,facts,retryable) VALUES ('ws_parse','invalid_success','succeeded',1,'[]'::jsonb,FALSE)`)).rejects.toThrow()
      await expect(database.query(`INSERT INTO asset_parse_leases (workspace_id,asset_id,state,attempts,retryable) VALUES ('ws_parse','missing_success_facts','succeeded',1,FALSE)`)).rejects.toThrow()
      await expect(database.query(`INSERT INTO asset_parse_leases (workspace_id,asset_id,state,attempts,lease_token,retryable) VALUES ('ws_parse','invalid_processing','processing',1,'half-lease',TRUE)`)).rejects.toThrow()
    } finally {
      await Promise.all([appA?.end(), appB?.end()])
      await database?.end()
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 120_000)
})
