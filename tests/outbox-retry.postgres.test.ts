import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DurableOutboxDispatcher, InMemoryQueue, type DurableOutboxEvent } from '../packages/workers/src/durable.js'
import { WorkerFailure } from '../packages/workers/src/runner.js'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.js'
import { PostgresOutboxRepository, withWorkspaceTransaction } from '../packages/persistence/src/repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL durable outbox retry recovery', () => {
  const databaseName = `outbox_retry_${randomUUID().replaceAll('-', '')}`
  let admin: Pool | undefined
  let database: Pool | undefined
  let repository: PostgresOutboxRepository
  let databaseCreated = false

  beforeAll(async () => {
    const base = new URL(databaseUrl!)
    admin = new Pool({ connectionString: base.toString(), max: 2 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    databaseCreated = true
    const isolated = new URL(base)
    isolated.pathname = `/${databaseName}`
    database = new Pool({ connectionString: isolated.toString(), max: 4 })
    const migrations = await loadMigrations()
    expect(migrations.some(migration => migration.version === 109)).toBe(true)
    expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(migration => migration.version))
    repository = new PostgresOutboxRepository(database)
  }, 240_000)

  afterAll(async () => {
    await database?.end()
    if (databaseCreated) await admin?.query(`DROP DATABASE "${databaseName}"`)
    await admin?.end()
  })

  async function workspace() {
    const id = `ws_retry_${randomUUID()}`
    await database!.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [id, 'active'])
    return id
  }

  async function append(workspaceId: string, label: string, eventType = 'task.created') {
    return repository.append({ workspaceId, aggregateId: `${label}_${randomUUID()}`, eventType, sequence: 1, payload: { label } })
  }

  it('restores an ordinary retry into a fresh dispatcher after backoff, then acknowledges it once', async () => {
    const scope = await workspace()
    const event = await append(scope, 'retry')
    let now = Date.now() + 1_000
    const initialQueue = new InMemoryQueue<DurableOutboxEvent>(() => now)
    let calls = 0
    const handler = async () => {
      calls += 1
      if (calls === 1) throw new WorkerFailure({ code: 'RATE_LIMITED', message: 'try after backoff', retryable: true, unknown: false })
      return { value: 'completed' }
    }
    const options = { now: () => now, leaseMs: 60_000, baseDelayMs: 2_000, maxDelayMs: 10_000 }
    const first = new DurableOutboxDispatcher(repository, initialQueue, handler, options)
    expect(await first.restore(scope)).toBe(1)
    const queued = await first.dispatchOnce()
    expect(queued).toMatchObject({ state: 'queued', event: { id: event.id, attempts: 1, lastError: { code: 'RATE_LIMITED', retryable: true, unknown: false } } })
    if (queued.state !== 'queued') throw new Error('expected the first attempt to remain queued')
    expect(queued.event?.leaseToken).toBeUndefined()
    expect(queued.event?.leaseUntil).toBeUndefined()
    expect(queued.event?.publishedAt).toBeUndefined()
    expect(await initialQueue.contains(event.id)).toBe(false)

    const retryQueue = new InMemoryQueue<DurableOutboxEvent>(() => now)
    const restored = new DurableOutboxDispatcher(new PostgresOutboxRepository(database!), retryQueue, handler, options)
    now = Date.parse(queued.event!.nextAttemptAt!) - 1
    expect(await restored.restore(scope)).toBe(0)
    now += 1
    expect(await restored.restore(scope)).toBe(1)
    const completed = await restored.dispatchOnce()
    expect(completed).toMatchObject({ state: 'succeeded', event: { id: event.id, attempts: 1, lastError: queued.event!.lastError } })
    if (completed.state !== 'succeeded') throw new Error('expected the restored retry to succeed')
    expect(completed.event?.publishedAt).toBeTruthy()
    expect(calls).toBe(2)
    expect(await retryQueue.contains(event.id)).toBe(false)
    expect(await restored.restore(scope)).toBe(0)

    // Migration 109 must still protect the terminal evidence and identity.
    const before = (await database!.query('SELECT * FROM outbox_events WHERE id=$1', [event.id])).rows[0]
    await expect(database!.query('UPDATE outbox_events SET attempts=attempts+1 WHERE id=$1', [event.id])).rejects.toMatchObject({ code: '55000' })
    await expect(database!.query('UPDATE outbox_events SET payload=$2::jsonb WHERE id=$1', [event.id, '{}'])).rejects.toMatchObject({ code: '55000' })
    expect((await database!.query('SELECT * FROM outbox_events WHERE id=$1', [event.id])).rows[0]).toEqual(before)
  })

  it('keeps terminal, unknown, unsafe error evidence, future retries and active leases out of claims', async () => {
    const scope = await workspace()
    const now = Date.now() + 1_000
    const due = new Date(now).toISOString()
    const delayed = new Date(now + 3_600_000).toISOString()
    const failure = { code: 'RATE_LIMITED', message: 'temporary failure', retryable: true, unknown: false }
    const blocked: string[] = []
    const published = await append(scope, 'published')
    await repository.ack(scope, published.id)
    blocked.push(published.id)
    const unknown = await append(scope, 'unknown')
    await repository.markUnknown(scope, unknown.id, { ...failure, unknown: true })
    blocked.push(unknown.id)
    const terminal = await append(scope, 'terminal')
    await repository.deadLetter(scope, terminal.id, failure)
    blocked.push(terminal.id)
    const future = await append(scope, 'future')
    await repository.recordFailure(scope, future.id, failure, delayed)
    blocked.push(future.id)

    for (const [label, error] of [
      ['nonretryable', { ...failure, retryable: false }],
      ['missing_retryable', { code: 'LEGACY_ERROR' }],
      ['string_retryable', { ...failure, retryable: 'true' }],
      ['unknown_evidence', { ...failure, unknown: true }],
      ['string_unknown', { ...failure, unknown: 'false' }],
      ['null_unknown', { ...failure, unknown: null }],
    ] as const) {
      const event = await append(scope, label)
      await withWorkspaceTransaction(database!, scope, client => client.query('UPDATE outbox_events SET last_error=$2::jsonb,next_attempt_at=$3::timestamptz WHERE id=$1', [event.id, JSON.stringify(error), due]))
      blocked.push(event.id)
    }

    const leased = await append(scope, 'leased', 'audit.retry.lease')
    const [active] = await repository.claimPending(scope, { now: due, leaseMs: 60_000, eventTypes: ['audit.retry.lease'] })
    expect(active?.id).toBe(leased.id)
    blocked.push(leased.id)
    const fresh = await append(scope, 'fresh')
    const retry = await append(scope, 'retry_without_optional_unknown')
    await repository.recordFailure(scope, retry.id, { code: 'RATE_LIMITED', message: 'retry is explicit', retryable: true }, due)

    const before = (await database!.query('SELECT * FROM outbox_events WHERE id=ANY($1::text[]) ORDER BY id', [blocked])).rows
    const claims = await repository.claimPending(scope, { now: due, leaseMs: 60_000 })
    expect(claims.map(event => event.id).sort()).toEqual([fresh.id, retry.id].sort())
    expect((await database!.query('SELECT * FROM outbox_events WHERE id=ANY($1::text[]) ORDER BY id', [blocked])).rows).toEqual(before)
    await expect(repository.validateLease(scope, leased.id, 'wrong-lease', due)).rejects.toMatchObject({ code: 'OUTBOX_EVENT_NOT_FOUND' })
  })

  it('serializes competing retry claims and retains workspace and worker routing boundaries', async () => {
    const scope = await workspace()
    const otherScope = await workspace()
    const event = await append(scope, 'concurrent', 'audit.retry.concurrent')
    const other = await append(otherScope, 'other', 'audit.retry.concurrent')
    const due = new Date(Date.now() + 1_000).toISOString()
    await repository.recordFailure(scope, event.id, { code: 'RATE_LIMITED', message: 'retry', retryable: true, unknown: false }, due)
    const peer = new PostgresOutboxRepository(database!)
    expect(await repository.claimPending(scope, { now: due, eventTypes: ['publish.requested'] })).toEqual([])
    const [left, right] = await Promise.all([
      repository.claimPending(scope, { now: due, leaseMs: 60_000, eventTypes: ['audit.retry.concurrent'] }),
      peer.claimPending(scope, { now: due, leaseMs: 60_000, eventTypes: ['audit.retry.concurrent'] }),
    ])
    expect([...left, ...right].map(claim => claim.id)).toEqual([event.id])
    const claim = [...left, ...right][0]!
    await expect(repository.validateLease(otherScope, event.id, claim.leaseToken!, due)).rejects.toMatchObject({ code: 'OUTBOX_EVENT_NOT_FOUND' })
    expect((await database!.query('SELECT lease_token FROM outbox_events WHERE id=$1', [other.id])).rows[0]?.lease_token).toBeNull()
    expect((await peer.claimPending(otherScope, { now: due, leaseMs: 60_000 })).map(item => item.id)).toEqual([other.id])
    await expect(repository.claimPending('')).rejects.toThrow('workspace scope is required')
  })
})
