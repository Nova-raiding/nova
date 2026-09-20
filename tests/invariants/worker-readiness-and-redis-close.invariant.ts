import type { InvariantMutation } from './registry.js'

/**
 * Worker invariants: the Redis close contract and the ready marker.
 *
 * Both were repaired twice by patching the call site the audit happened to
 * name, and both stayed broken on the sibling path, so both are registered
 * here against their chokepoint rather than against a call site:
 *
 *  - `closeRedisClient` is the only close implementation the worker has. The
 *    queue transport, the quota counters and the credential refresh lock all
 *    return it as their `close`, and the mutation below takes its fallback away
 *    - the exact regression it was written for: `destroy()` after an abandoned
 *    `quit()` throws `ClientClosedError`, the socket is never released, and the
 *    caller's `finally` is interrupted before the other two connections are
 *    closed at all.
 *  - the ready marker is only written while the loop is completing iterations.
 *    The first mutation restores the dependency-check write-back, which is what
 *    kept a worker failing every single iteration advertised as ready: the
 *    marker was absent only for the sleep between two failures, so the probes
 *    could never accumulate `failureThreshold` consecutive failures. The second
 *    pins the gate's *threshold* from the other side - the loop tolerates
 *    exactly one failed iteration, so a single transient failure does not revoke
 *    the marker for the whole of the next healthy iteration. `0` is the
 *    regression that fix replaced, and it is applied by mutating the constant
 *    the tolerance is declared in.
 *
 * The evidence is `apps/worker/src/worker-readiness-and-redis-close.invariant.test.ts`:
 * a real node-redis 5.12.1 client (real socket, real state machine, real command
 * queue) against a real TCP peer that completes the connection and then never
 * answers, plus the real poll loop driven through the transports' own
 * `clientFactory` seam.
 *
 * The chokepoints are the exported `closeRedisClient` in `redis-transport.ts`
 * (all three connections return it as their `close`) and the
 * `consecutiveIterationFailures`/`READY_MARKER_TOLERATED_FAILURES` gate on the
 * marker write in `main.ts`; the registry keeps a file path in the row, because
 * the consistency gate resolves that field on disk.
 */
/**
 * The two files that legitimately contain this fragment's own rule text: the
 * fragment that declares the rule (a rule has to match its own `sample`) and
 * the evidence that names the tolerance in a comment explaining what the gate
 * tolerates. Named per rule rather than exempting the directory, so a file that
 * joins either contract later still fails the audit.
 */
const RULE_DECLARATION_SITE = 'tests/invariants/worker-readiness-and-redis-close.invariant.ts'

/**
 * The message both marker tests fail with. It is the `evidenceFailsWith` of
 * both marker rows: each is broken in both directions by the gate, and whichever
 * direction a mutation breaks prints this sentence.
 */
const MARKER_DOES_NOT_TRACK_PROGRESS = 'the ready marker does not track whether the loop is completing iterations'

const mutations: InvariantMutation[] = [
  {
    id: 'worker-redis-close-releases-the-socket',
    chokepointSymbol: 'closeRedisClient',
    invariant: 'Closing a Redis connection is bounded, never throws at the caller, and releases the TCP socket - including when the peer stopped answering.',
    // The exported `closeRedisClient`; the queue transport, the quota counter
    // store and the credential refresh lock all return it as their `close`.
    chokepoint: 'apps/worker/src/redis-transport.ts',
    file: 'apps/worker/src/redis-transport.ts',
    // The anchor stops at the socket release rather than spanning the whole
    // `catch`: a mutation that replaced the closing brace of the block left a
    // `try` with no `catch`/`finally`, so the file did not parse and the gate
    // could only ever report NOT ATTRIBUTABLE ("Unable to parse …"), never the
    // named assertion this row exists to pin.
    find: `    // touch the socket; \`destroyEjectedSocket\` below is what releases it.
    destroyEjectedSocket(client)
  }`,
    replace: `    // touch the socket; with the release removed, nothing does.
  }`,
    evidence: 'apps/worker/src/worker-readiness-and-redis-close.invariant.test.ts',
    overRejection: {
      find: 'export async function closeRedisClient(client: RedisClientType): Promise<void> {\n  if (!redisClientIsOpen(client)) return',
      replace: "export async function closeRedisClient(client: RedisClientType): Promise<void> {\n  throw new Error('refusing to close the connection')\n  if (!redisClientIsOpen(client)) return",
      why: 'a close that refuses every connection is the mirror of one that leaks the socket: the caller cannot shut down at all, which the same evidence has to catch',
    },
    evidenceFailsWith: 'closes a blackholed client inside the budget and releases its socket',
    uniqueness: {
      // `scripts/verify-payment-reconciliation.ts` owns a fixture Redis
      // connection for its lease scenarios and closes it through this
      // chokepoint too: a raw `quit()` there had no timeout, so a fixture Redis
      // that stopped answering parked the script's `finally` forever.
      callers: ['apps/worker/src/quota-transport.ts', 'scripts/verify-payment-reconciliation.ts'],
      noSecondImplementation: [
        {
          pattern: '\\b(?:client|redis|redisClient)\\??\\.(?:destroy|disconnect|quit)\\(|redis\\??\\.quit\\(',
          sample: 'if (redis?.isOpen) await redis.quit().catch(() => { redis?.destroy(); errors.push(1) })',
          allow: ['apps/worker/src/redis-transport.ts', 'apps/worker/src/clamav-scanner.ts'],
          why: 'every Redis connection the worker owns is closed through `closeRedisClient`; a raw `destroy()`/`disconnect()` anywhere else is a second close implementation with different timeout and ejection behaviour',
        },
      ],
    },
    rationale: 'This is the shipped regression verbatim: the budget abandons `quit()`, which has already flipped the socket open flag to false, so the bare `destroy()` in the catch throws `ClientClosedError` and never reaches `destroySocket()`. The evidence asserts all three of: no rejection, the peer sees the connection close, and a second close is a no-op.',
  },
  {
    id: 'worker-ready-marker-stays-revoked-while-failing',
    invariant: 'A loop that fails every iteration leaves the ready marker absent, so consecutive probe failures accumulate and the pod is restarted.',
    // The `consecutiveIterationFailures` gate on the marker write in the poll loop.
    chokepoint: 'apps/worker/src/main.ts',
    chokepointSymbol: 'readyMarkerRefreshAllowed',
    file: 'apps/worker/src/main.ts',
    find: `if (!scannerHeartbeat && readyMarkerRefreshAllowed(consecutiveIterationFailures)) await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, state: 'idle',`,
    replace: `if (!scannerHeartbeat) await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, state: 'idle',`,
    evidence: 'apps/worker/src/worker-readiness-and-redis-close.invariant.test.ts',
    overRejection: {
      find: 'if (!scannerHeartbeat && readyMarkerRefreshAllowed(consecutiveIterationFailures)) await writeFile(readyFile,',
      replace: 'if (false) await writeFile(readyFile,',
      why: 'never publishing the marker is the mirror of always publishing it: a healthy worker would be restarted forever, so the evidence has to fail when the marker stops being written at all',
    },
    evidenceFailsWith: MARKER_DOES_NOT_TRACK_PROGRESS,
    uniqueness: {
      callers: ['apps/worker/src/main.ts'],
      noSecondImplementation: [
        {
          pattern: 'writeFile\\(readyFile',
          sample: "await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, state: 'idle'",
          // `worker.test.ts` writes the marker as a *fixture* - it sets the file
          // up to drive the heartbeat's ENOENT and `utimes` behaviour - and does
          // not decide liveness, so it is named here rather than left to fail as
          // a second implementation.
          allow: ['apps/worker/src/main.ts', RULE_DECLARATION_SITE, 'apps/worker/src/worker.test.ts'],
          why: 'the ready marker is written through one liveness decision; a second writer that does not consult the failure counter is how a worker failing every iteration advertised itself as ready',
        },
      ],
    },
    rationale: 'Without the gate the next iteration writes the idle marker straight back after the failure path removed it, so the marker is missing only for the ~1s sleep between failures and kubelet\'s *consecutive*-failure counter never advances. The probe that restarts the pod is the liveness one (`workers.yaml`): `find <ready> -mmin -2`, `periodSeconds` 10, no `failureThreshold`, i.e. the Kubernetes default 3 (~30s), so a worker whose queue is blackholed is never restarted while every probe reads green. The evidence waits for the absence to be sustained for longer than one iteration, not merely observed once, which is what separates this from the tolerated single failure the next row pins.',
  },
  {
    id: 'worker-ready-marker-restored-after-a-transient-failure',
    invariant: 'A single transient iteration failure does not suppress the ready marker for the whole of the next healthy iteration.',
    // The tolerance itself: how many consecutive failures the gate absorbs.
    chokepoint: 'apps/worker/src/main.ts',
    chokepointSymbol: 'READY_MARKER_TOLERATED_FAILURES',
    file: 'apps/worker/src/main.ts',
    find: 'const READY_MARKER_TOLERATED_FAILURES = 1',
    replace: 'const READY_MARKER_TOLERATED_FAILURES = 0',
    evidence: 'apps/worker/src/worker-readiness-and-redis-close.invariant.test.ts',
    overRejection: {
      find: 'const READY_MARKER_TOLERATED_FAILURES = 1',
      replace: 'const READY_MARKER_TOLERATED_FAILURES = 99',
      why: 'tolerating an unbounded failure streak is the mirror of tolerating none: a wedged worker would keep advertising itself as ready forever, so the evidence has to fail here as well as at the `0` mutation',
    },
    evidenceFailsWith: MARKER_DOES_NOT_TRACK_PROGRESS,
    uniqueness: {
      callers: ['apps/worker/src/main.ts'],
      noSecondImplementation: [
        {
          pattern: 'READY_MARKER_TOLERATED_FAILURES',
          sample: 'const READY_MARKER_TOLERATED_FAILURES = 1',
          allow: ['apps/worker/src/main.ts', RULE_DECLARATION_SITE, 'apps/worker/src/worker-readiness-and-redis-close.invariant.test.ts'],
          why: 'how many consecutive failures the marker tolerates is one constant; a second threshold somewhere else (a hard-coded `<= 1`, a second counter) is a second liveness policy for the same pod',
        },
      ],
    },
    rationale: '`0` is the shipped regression: one failure (a Redis round trip over `REDIS_OPERATION_TIMEOUT_MS`, one API 503) sets the streak past the tolerance, the failure path has already unlinked the marker, and the next iteration\'s dependency check refuses to write it back - so a healthy iteration that is allowed to run for minutes (`WORKER_API_TIMEOUT_MS` 360s) is SIGTERMed by the liveness probe ~30s in, with its events under the 15-minute lease: the #29 stall with every probe green. The heartbeat cannot rescue it (`touch()` is `utimes`, and its ENOENT is swallowed). Tolerating one failure is the minimum that keeps a transient failure from speaking for the next iteration while staying strictly below the liveness probe\'s `failureThreshold` (3), so a genuinely wedged loop still accumulates the probe failures that restart it - see the sibling row above.',
  },
  {
    id: 'worker-credential-lock-close-uses-the-chokepoint',
    chokepointSymbol: 'closeRedisClient',
    invariant: 'The credential refresh lock closes through the same chokepoint as every other connection, not through a raw node-redis close.',
    // The same `closeRedisClient`, reached from the credential refresh lock.
    chokepoint: 'apps/worker/src/redis-transport.ts',
    file: 'apps/worker/src/redis-transport.ts',
    find: `    // Same chokepoint as the queue and quota connections: a bare \`close()\` here
    // waits for the command queue to drain, so one abandoned OAuth refresh
    // round trip parks this call until the container is SIGKILLed.
    close: () => closeRedisClient(client),`,
    replace: `    async close() { try { await client.close() } catch { /* already closed or never connected */ } },`,
    evidence: 'apps/worker/src/worker-readiness-and-redis-close.invariant.test.ts',
    overRejection: {
      find: 'close: () => closeRedisClient(client),',
      replace: "close: async () => { throw new Error('refusing to close the lock connection') },",
      why: 'a lock connection that refuses to close is the mirror of one that parks the whole grace period on a drained queue; the same evidence has to catch it',
    },
    evidenceFailsWith: 'closes the queue, quota and credential-lock connections through the same contract',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: 'await client\\.(?:close|quit|destroy|disconnect)\\(',
          sample: 'async close() { try { await client.close() } catch { /* already closed */ } },',
          allow: ['packages/storage/src/object-storage.ts'],
          why: 'a bare node-redis `close()` waits for the command queue to drain; closing a worker connection any other way re-introduces the shutdown that parks until SIGKILL',
        },
      ],
    },
    rationale: 'A bare `client.close()` waits for the pending command queue to drain. One OAuth refresh round trip the budget abandoned leaves that queue non-empty forever, so a SIGTERM during a Redis blackhole parks the lock close for the whole grace period and the pod is SIGKILLed - the same failure the queue connection was already fixed for.',
  },
]

export { mutations }
