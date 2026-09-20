import { mkdtemp, stat } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type RedisClientType } from 'redis'
import type { Pool } from 'pg'
import { closeRedisClient, connectRedisQueue, createRedisCredentialRefreshLock, withRedisOperationTimeout } from './redis-transport.js'
import { createQuotaCounterStore } from './quota-transport.js'
import { readWorkerConfig, runWorker } from './main.js'
import { loadMigrations, type Migration } from '../../../packages/persistence/src/index.js'

/**
 * Evidence for two invariants registered in `tests/invariants/registry.ts`.
 * Both are mutation-tested by `npm run invariants:verify`: the runner breaks the
 * chokepoint and requires this file to go red.
 *
 * 1. Redis close. One implementation, one contract: bounded, never throwing into
 *    the caller's `finally`, and the TCP socket actually released. The socket is
 *    the point - an unreferenced one lets the container exit on SIGTERM, a
 *    referenced one costs the whole `terminationGracePeriodSeconds` and ends in
 *    SIGKILL.
 *
 * 2. Ready marker. The marker is the only liveness evidence a non-scanner role
 *    has, so it must mean "the loop is completing iterations". A loop whose
 *    every iteration fails must leave it revoked long enough for
 *    `failureThreshold` to be reached - and, the other direction of the same
 *    gate, one *transient* failure must not revoke it for the whole of the next
 *    healthy iteration, which is allowed to run for minutes. Both directions are
 *    registered separately: each has its own mutation in the registry, and each
 *    mutation has to turn exactly its own case red.
 *
 * Both run against real dependencies. The Redis client is node-redis 5.12.1
 * itself - the real `RedisSocket` state machine, a real TCP socket, a real
 * command queue - talking to a peer that completes the connection and then
 * never answers. Nothing here fakes a reply: the failure being pinned *is* the
 * absence of one, so a stubbed reply could not express it. (The old suite proved
 * that: its `destroy: () => undefined` Proxy made the close look bounded while
 * the real client rejected on every blackholed socket.)
 */

/** Bounded, but short: the shipped default is 1.5s and every case here waits it out. */
const OPERATION_TIMEOUT_MS = '150'

/** A TCP peer that accepts the connection and never answers, never FINs, never resets. */
async function neverAnsweringPeer(): Promise<{ url: string; connections: () => readonly net.Socket[]; allClosed: () => boolean; close: () => Promise<void> }> {
  const sockets: net.Socket[] = []
  const closed = new Set<number>()
  const server = net.createServer(socket => {
    const index = sockets.push(socket) - 1
    // Read and discard: the client's FIN still arrives, so "the socket was
    // released" is observable from this side.
    socket.on('data', () => undefined)
    socket.on('error', () => undefined)
    socket.on('close', () => closed.add(index))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `redis://127.0.0.1:${port}`,
    connections: () => sockets,
    allClosed: () => sockets.length > 0 && closed.size === sockets.length,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * A real node-redis client whose `connect()` resolves without waiting for a
 * handshake the peer will never send.
 *
 * Everything else is the library's own: the dialled socket, the open flag, the
 * command queue, `quit`/`close`/`destroy`. Without this wrapper the transport
 * would park inside `connect()` and never reach the command whose fate is under
 * test; faking a reply instead is what made the previous guard green.
 */
function blackholedRealClient(url: string): RedisClientType {
  const client = createClient({ url })
  client.on('error', () => undefined)
  return new Proxy(client, {
    get(target, property) {
      if (property === 'connect') {
        // Dial for real - the socket, its open flag and its command queue are
        // the library's - but do not await a handshake the peer will never send.
        return async () => { void target.connect().catch(() => undefined); return target }
      }
      // Invoked with the real client as receiver: `this` must not be the Proxy,
      // or every private field inside node-redis throws.
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as RedisClientType
}

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

const exists = (path: string) => stat(path).then(() => true, () => false)

/**
 * The assertion message both marker tests fail with, registered as this file's
 * `evidenceFailsWith` in `tests/invariants/worker-readiness-and-redis-close.invariant.ts`.
 *
 * The mutation gate refuses to score "the process exited non-zero" as proof, so
 * a row has to name the assertion its mutation breaks. Both directions of the
 * gate - refreshing the marker inside a failing streak, and never refreshing it
 * at all - are the same defect stated twice, so both tests carry the same
 * sentence: whichever half the mutation breaks, the registered message is what
 * the failing run prints.
 */
const MARKER_DOES_NOT_TRACK_PROGRESS = 'the ready marker does not track whether the loop is completing iterations'

/**
 * True once `path` has been absent at *every* sample for `holdMs`.
 *
 * The distinction this draws is the whole point of the marker gate: a loop that
 * fails every iteration under a one-failure tolerance removes the marker and
 * then has it written back by the next dependency check, so a single `stat` can
 * see either state. A missing marker that *stays* missing for longer than an
 * iteration is what a probe can accumulate `failureThreshold` consecutive
 * failures from.
 */
const absentFor = async (path: string, holdMs: number, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  let absentSince: number | undefined
  while (Date.now() < deadline) {
    if (await exists(path)) absentSince = undefined
    else {
      absentSince ??= Date.now()
      if (Date.now() - absentSince >= holdMs) return true
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

describe('redis close has one implementation and one contract', () => {
  const previousTimeout = process.env.REDIS_OPERATION_TIMEOUT_MS
  const peers: Array<Awaited<ReturnType<typeof neverAnsweringPeer>>> = []

  beforeAll(() => { process.env.REDIS_OPERATION_TIMEOUT_MS = OPERATION_TIMEOUT_MS })
  afterAll(async () => {
    if (previousTimeout === undefined) delete process.env.REDIS_OPERATION_TIMEOUT_MS
    else process.env.REDIS_OPERATION_TIMEOUT_MS = previousTimeout
    await Promise.all(peers.map(peer => peer.close()))
  })

  const peer = async () => {
    const created = await neverAnsweringPeer()
    peers.push(created)
    return created
  }

  it('closes a blackholed client inside the budget and releases its socket', async () => {
    const target = await peer()
    const client = blackholedRealClient(target.url)
    await client.connect()
    expect(await waitFor(async () => target.connections().length === 1)).toBe(true)
    // A round trip the budget abandons, leaving the command pending on the
    // client exactly as the worker's own abandoned round trips do.
    void client.get('probe').catch(() => undefined)
    await expect(withRedisOperationTimeout(client.get('probe'), { REDIS_OPERATION_TIMEOUT_MS: OPERATION_TIMEOUT_MS }))
      .rejects.toMatchObject({ code: 'REDIS_OPERATION_TIMEOUT' })
    expect(client.isOpen).toBe(true)
    expect(target.connections()).toHaveLength(1)

    const started = Date.now()
    // The contract the caller's `finally` depends on: this resolves, it does not
    // reject with `ClientClosedError`, and it does not park on the peer.
    await expect(closeRedisClient(client)).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3_000)
    // ...and the socket is gone, not merely forgotten. A close that returns
    // without dropping it leaves the process alive on SIGTERM.
    expect(await waitFor(async () => target.allClosed())).toBe(true)
    expect(target.connections()[0]!.destroyed).toBe(true)
    // A second close is a no-op rather than a rejection: two roles can share a
    // teardown path and only one of them can be first.
    await expect(closeRedisClient(client)).resolves.toBeUndefined()
  }, 30_000)

  it('returns for a client that never opened a connection', async () => {
    // Never dialled at all: the read of `isOpen` itself must not throw.
    await expect(closeRedisClient(createClient({ url: 'redis://127.0.0.1:1' }) as RedisClientType)).resolves.toBeUndefined()
    // Dialled and refused. `quit()` raises `ClientClosedError` here, which used
    // to escape into the caller's `finally`.
    const refused = createClient({ url: 'redis://127.0.0.1:1', socket: { reconnectStrategy: false } }) as RedisClientType
    refused.on('error', () => undefined)
    await expect(refused.connect()).rejects.toThrow()
    await expect(closeRedisClient(refused)).resolves.toBeUndefined()
  }, 30_000)

  it('closes the queue, quota and credential-lock connections through the same contract', async () => {
    const queuePeer = await peer()
    const queue = await connectRedisQueue(queuePeer.url, { clientFactory: blackholedRealClient })
    // Each connection carries one abandoned round trip: that is the state the
    // worker is in when a peer stops answering, and the state a bare `close()`
    // parks on. The lock cannot issue its own round trip here (its first await
    // is the handshake this peer never completes), so the same client gets one.
    void queue.transport.hasCapacity?.('queue:invariant').catch(() => undefined)

    const quotaPeer = await peer()
    const quota = await createQuotaCounterStore(quotaPeer.url, { clientFactory: blackholedRealClient })
    void quota.store.increment('quota:invariant', 60).catch(() => undefined)

    const lockPeer = await peer()
    const lockClient = blackholedRealClient(lockPeer.url)
    const lock = createRedisCredentialRefreshLock(lockPeer.url, { clientFactory: () => lockClient })
    expect(lock).toBeDefined()
    await lockClient.connect()
    void lockClient.get('refresh').catch(() => undefined)

    const started = Date.now()
    await expect(lock!.close()).resolves.toBeUndefined()
    await expect(queue.close()).resolves.toBeUndefined()
    await expect(quota.close()).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3_000)
    for (const [name, target] of [['queue', queuePeer], ['quota', quotaPeer], ['credential lock', lockPeer]] as const) {
      expect([name, await waitFor(async () => target.allClosed())]).toEqual([name, true])
    }
  }, 30_000)
})

describe('the ready marker means the loop is completing iterations', () => {
  const previous = { ...process.env }

  afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  })

  it('keeps the marker revoked while every iteration fails, so the probe can reach failureThreshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worker-marker-invariant-'))
    const readyFile = join(directory, 'ready')
    const target = await neverAnsweringPeer()
    const migrations: readonly Migration[] = await loadMigrations()
    let dependencyChecks = 0
    // Answers the readiness probe (the migration chain) and nothing else: the
    // loop reaches the queue, which is where the blackholed peer lives.
    const pool = {
      async query(sql: string) {
        if (/schema_migrations/u.test(sql)) {
          dependencyChecks += 1
          return { rows: migrations.map(migration => ({ version: migration.version, name: migration.name })) }
        }
        return { rows: [] }
      },
    } as unknown as Pool
    Object.assign(process.env, {
      WORKER_READY_FILE: readyFile,
      REDIS_URL: target.url,
      REDIS_OPERATION_TIMEOUT_MS: OPERATION_TIMEOUT_MS,
    })
    const config = readWorkerConfig({
      ...process.env,
      NODE_ENV: 'test', WORKER_ROLE: 'publish', WORKER_WORKSPACES: 'ws_a', WORKER_ONCE: 'false',
      WORKER_METRICS_PORT: '0', WORKER_POLL_INTERVAL_MS: '25', WORKER_DEPENDENCY_CHECK_INTERVAL_MS: '25',
      DATABASE_URL: 'postgres://worker@127.0.0.1:9/worker',
    })
    const running = runWorker(config, pool, { readyFileHeartbeatIntervalMs: 20, redisClientFactory: blackholedRealClient })
    try {
      // The loop's first iteration passes the dependency check and writes the
      // marker; from then on every iteration fails on the queue.
      expect(await waitFor(async () => await exists(readyFile))).toBe(true)
      // The first failing iteration revokes it. One further iteration is
      // allowed to write it back (`READY_MARKER_TOLERATED_FAILURES`), so what
      // this waits for is a *sustained* absence - longer than an iteration -
      // and not a single gap between two refreshes.
      expect(await absentFor(readyFile, 750), MARKER_DOES_NOT_TRACK_PROGRESS).toBe(true)
      const checksAtStart = dependencyChecks
      const samples: boolean[] = []
      for (let index = 0; index < 80; index += 1) {
        samples.push(await exists(readyFile))
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      // The loop really is iterating and failing (not stuck before the marker):
      // without the gate the marker is rewritten within one iteration, which is
      // the regression this pins. Without this guard the absence below could be
      // a loop that never reached the dependency check.
      expect(dependencyChecks - checksAtStart).toBeGreaterThanOrEqual(3)
      expect(samples.filter(Boolean)).toEqual([])
    } finally {
      process.emit('SIGTERM')
      await running
      await target.close()
    }
  }, 30_000)

  it('restores the marker on the next healthy iteration after one transient failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worker-marker-invariant-'))
    const readyFile = join(directory, 'ready')
    const target = await neverAnsweringPeer()
    const migrations: readonly Migration[] = await loadMigrations()
    let transientFailures = 0
    let healthyIterationInFlight = false
    const query = async (sql: string) => {
      if (/schema_migrations/u.test(sql)) return { rows: migrations.map(migration => ({ version: migration.version, name: migration.name })) }
      if (/worker_active_workspace_catalog/u.test(sql)) {
        // Exactly one transient failure - a Redis round trip over its budget, an
        // API 503 - and then a healthy iteration that is long enough for the
        // liveness probe to have fired three times had the marker stayed absent.
        if (transientFailures === 0) {
          transientFailures += 1
          throw new Error('transient discovery failure')
        }
        healthyIterationInFlight = true
        await new Promise(resolve => setTimeout(resolve, 2_000))
        return { rows: [{ workspace_id: 'ws_a' }] }
      }
      return { rows: [] }
    }
    // `listActiveWorkspaceIds` takes a pooled client, so the mock has to hand
    // one out; `WORKER_WORKSPACES=auto` is what routes the loop through it.
    const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool
    Object.assign(process.env, {
      WORKER_READY_FILE: readyFile,
      REDIS_URL: target.url,
      REDIS_OPERATION_TIMEOUT_MS: OPERATION_TIMEOUT_MS,
    })
    const config = readWorkerConfig({
      ...process.env,
      NODE_ENV: 'test', WORKER_ROLE: 'publish', WORKER_WORKSPACES: 'auto', WORKER_ONCE: 'false',
      // Long enough between iterations for the revocation to be observed: the
      // next iteration writes the marker as soon as it passes the dependency
      // check, so the revoke-to-restore gap is one dependency-check interval.
      WORKER_METRICS_PORT: '0', WORKER_POLL_INTERVAL_MS: '400', WORKER_DEPENDENCY_CHECK_INTERVAL_MS: '400',
      DATABASE_URL: 'postgres://worker@127.0.0.1:9/worker',
    })
    const running = runWorker(config, pool, { readyFileHeartbeatIntervalMs: 20, redisClientFactory: blackholedRealClient })
    try {
      // Iteration 1 passes the dependency check, fails on the injected
      // transient error, and the failure path revokes the marker.
      expect(await waitFor(async () => transientFailures === 1)).toBe(true)
      expect(await waitFor(async () => !(await exists(readyFile)), 2_000)).toBe(true)
      // Iteration 2 passes the same dependency check and is healthy. Its work
      // runs for two seconds, which the liveness probe (`periodSeconds` 10,
      // default `failureThreshold` 3) would read as a dead process if the
      // marker stayed revoked this side of the iteration's end.
      expect(await waitFor(async () => healthyIterationInFlight)).toBe(true)
      const samples: boolean[] = []
      for (let index = 0; index < 16; index += 1) {
        samples.push(await exists(readyFile))
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(samples, MARKER_DOES_NOT_TRACK_PROGRESS).toEqual(new Array(16).fill(true))
    } finally {
      process.emit('SIGTERM')
      await running
      await target.close()
    }
  }, 30_000)
})
