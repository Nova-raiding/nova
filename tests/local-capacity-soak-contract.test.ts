import { describe, expect, it } from 'vitest'
import { InMemoryJobRunner, WorkerFailure } from '../packages/workers/src/runner.js'

type LocalPayload = { workspaceId: string; round: number; sequence: number; fault?: 'transient' }

export type LocalCapacitySoakReport = {
  profile: 'local_capacity_soak'
  cloud_gate: false
  real_world_evidence: false
  workspace_count: number
  rounds: number
  submitted_jobs: number
  unique_jobs: number
  completed_jobs: number
  failed_jobs: number
  transient_recoveries: number
  cross_tenant_provider_calls: number
  queue_converged: boolean
  fault_recovered: boolean
  max_queue_depth: number
}

const WORKSPACES = ['ws_soak_a', 'ws_soak_b', 'ws_soak_c', 'ws_soak_d']
const ROUNDS = 6
const JOBS_PER_WORKSPACE_PER_ROUND = 4

/**
 * Runs a bounded local queue soak. This intentionally does not claim the
 * production 50-tenant/6-hour capacity target; it only exercises deterministic
 * queue, tenant-scope, and retry invariants without external services.
 */
export async function runLocalCapacitySoakHarness(): Promise<LocalCapacitySoakReport> {
  let now = 0
  let submittedJobs = 0
  let transientRecoveries = 0
  let crossTenantProviderCalls = 0
  const providerCalls: Array<{ workspaceId: string; sequence: number }> = []
  const attempts = new Map<string, number>()

  const worker = new InMemoryJobRunner<LocalPayload, { workspaceId: string; sequence: number }>(
    'publish',
    async ({ job }) => {
      const payload = job.payload
      if (payload.workspaceId !== job.workspaceId) {
        throw new WorkerFailure({ code: 'TENANT_SCOPE_DENIED', message: 'payload workspace does not match job workspace', retryable: false })
      }

      const key = `${job.workspaceId}:${payload.round}:${payload.sequence}`
      const attempt = (attempts.get(key) ?? 0) + 1
      attempts.set(key, attempt)
      if (payload.fault === 'transient' && attempt === 1) {
        throw new WorkerFailure({ code: 'LOCAL_DEPENDENCY_RESTART', message: 'local dependency restart', retryable: true })
      }

      // The provider boundary is represented only by this observation. The
      // scope assertion above must pass before a call can be recorded.
      if (payload.workspaceId !== job.workspaceId) crossTenantProviderCalls += 1
      providerCalls.push({ workspaceId: job.workspaceId, sequence: payload.sequence })
      return { workspaceId: job.workspaceId, sequence: payload.sequence }
    },
    { now: () => now, baseDelayMs: 1, maxDelayMs: 10, idFactory: (() => { let id = 0; return () => `local-${++id}` })() },
  )

  let maxQueueDepth = 0
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const workspaceId of WORKSPACES) {
      for (let sequence = 0; sequence < JOBS_PER_WORKSPACE_PER_ROUND; sequence += 1) {
        submittedJobs += 1
        const fault = workspaceId === 'ws_soak_c' && round === 2 && sequence === 0 ? 'transient' : undefined
        worker.enqueue({ workspaceId, idempotencyKey: `soak-${round}-${sequence}`, payload: { workspaceId, round, sequence, ...(fault ? { fault } : {}) } })
        // A duplicate request in the same tenant must not add a second job.
        worker.enqueue({ workspaceId, idempotencyKey: `soak-${round}-${sequence}`, payload: { workspaceId, round, sequence, ...(fault ? { fault } : {}) } })
      }
    }
    maxQueueDepth = Math.max(maxQueueDepth, [...worker.jobs.values()].filter(job => job.state === 'queued').length)
    await drainReady(worker, () => { now += 1 })
  }

  // Exercise the scope guard with a forged payload. It must fail without a
  // provider observation and must not be retried.
  const forged = worker.enqueue({ workspaceId: 'ws_soak_a', idempotencyKey: 'forged-scope', payload: { workspaceId: 'ws_soak_b', round: ROUNDS, sequence: 999 } })
  await drainReady(worker, () => { now += 1 })

  const jobs = [...worker.jobs.values()]
  const completedJobs = jobs.filter(job => job.state === 'succeeded').length
  const failedJobs = jobs.filter(job => job.state === 'failed').length
  const faultJob = jobs.find(job => job.payload.fault === 'transient')

  expect(forged.state).toBe('failed')
  expect(forged.lastError?.code).toBe('TENANT_SCOPE_DENIED')
  expect(providerCalls.some(call => call.workspaceId === 'ws_soak_a' && call.sequence === 999)).toBe(false)
  expect(new Set(providerCalls.map(call => call.workspaceId))).toEqual(new Set(WORKSPACES))

  return {
    profile: 'local_capacity_soak',
    cloud_gate: false,
    real_world_evidence: false,
    workspace_count: WORKSPACES.length,
    rounds: ROUNDS,
    submitted_jobs: submittedJobs,
    unique_jobs: jobs.length - 1,
    completed_jobs: completedJobs,
    failed_jobs: failedJobs,
    transient_recoveries: faultJob?.attempt === 2 && faultJob.state === 'succeeded' ? 1 : 0,
    cross_tenant_provider_calls: crossTenantProviderCalls,
    queue_converged: jobs.every(job => ['succeeded', 'failed'].includes(job.state)),
    fault_recovered: faultJob?.attempt === 2 && faultJob.state === 'succeeded',
    max_queue_depth: maxQueueDepth,
  }
}

async function drainReady<T, R>(worker: InMemoryJobRunner<T, R>, advance: () => void) {
  for (let guard = 0; guard < 1_000; guard += 1) {
    const result = await worker.runNext()
    if (result) continue
    const next = [...worker.jobs.values()]
      .filter(job => job.state === 'queued')
      .map(job => job.notBefore)
      .sort((left, right) => left - right)[0]
    if (next === undefined) return
    advance()
  }
  throw new Error('local capacity soak did not drain within the bounded harness limit')
}

describe('local capacity soak contract', () => {
  it('converges a bounded local workload without claiming cloud capacity evidence', async () => {
    const report = await runLocalCapacitySoakHarness()

    expect(report).toMatchObject({
      profile: 'local_capacity_soak',
      cloud_gate: false,
      real_world_evidence: false,
      workspace_count: 4,
      rounds: 6,
      submitted_jobs: 96,
      unique_jobs: 96,
      completed_jobs: 96,
      failed_jobs: 1,
      transient_recoveries: 1,
      cross_tenant_provider_calls: 0,
      queue_converged: true,
      fault_recovered: true,
    })
    expect(report.max_queue_depth).toBeGreaterThan(0)
  })

  it('keeps idempotency tenant-scoped while the harness shares one queue runner', async () => {
    let id = 0
    const providerWrites: string[] = []
    const worker = new InMemoryJobRunner<{ value: string }, string>('publish', async ({ job }) => {
      providerWrites.push(job.workspaceId)
      return job.payload.value
    }, { idFactory: () => `same-id-${++id}` })
    const first = worker.enqueue({ workspaceId: 'tenant-a', idempotencyKey: 'same', payload: { value: 'a' } })
    const duplicate = worker.enqueue({ workspaceId: 'tenant-a', idempotencyKey: 'same', payload: { value: 'a' } })
    const otherTenant = worker.enqueue({ workspaceId: 'tenant-b', idempotencyKey: 'same', payload: { value: 'b' } })

    expect(duplicate).toBe(first)
    expect(otherTenant).not.toBe(first)
    expect(worker.jobs.size).toBe(2)
    await worker.runUntilIdle()
    expect(first.result).toBe('a')
    expect(otherTenant.result).toBe('b')
    expect(providerWrites).toEqual(['tenant-a', 'tenant-b'])
  })
})
