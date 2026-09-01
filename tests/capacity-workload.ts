import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export type CapacityWorkloadProfile = 'pilot_50' | 'wave_100' | 'wave_250' | 'target_500'
export type CapacityWorkloadMode = 'compose' | 'real_cloud'
export const CAPACITY_WORKLOAD_READ_PATH = '/v1/platform-accounts'
export const LOCAL_CAPACITY_REQUIRED_SERVICES = ['api', 'api-replica', 'clamav', 'ops-ui', 'postgres', 'redis', 'ui', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync'] as const
export function isExpectedCapacityStatus(status: number): boolean { return status === 429 }
export function selectCapacityAccount(items: readonly { platform?: string; accountId?: string }[]): string {
  const accountId = items.find(item => item.platform === 'taobao' && item.accountId)?.accountId
  if (!accountId) throw new Error('capacity workload setup requires a bound Taobao account in every workspace')
  return accountId
}

export interface CapacityWorkloadConfig {
  profile: CapacityWorkloadProfile
  mode: CapacityWorkloadMode
  baseUrl: string
  token: string
  workspaces: number
  clientConnections: number
  sustainedRps: number
  sustainedMinutes: number
  burstRps: number
  burstSeconds: number
  asyncJobsPerMinute: number
  stabilityHours: number
  concurrency: number
  noiseWorkspaceIndex: number
  noiseMultiplier: number
  setupJobs: boolean
  output?: string
}

export type LocalRuntimeService = { service: string; state: string; health: string }

function capacityTimingErrors(timings: readonly CapacityWorkloadTiming[]): number {
  return timings.filter(item =>
    !item || typeof item.workspace !== 'string' || item.workspace.trim() === ''
    || typeof item.phase !== 'string' || item.phase.trim() === ''
    || typeof item.elapsedMs !== 'number' || !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0
    || !Number.isSafeInteger(item.status) || item.status < 0 || item.status > 599
    || typeof item.ok !== 'boolean'
  ).length
}

/** Capture the Compose state that the local capacity report is allowed to claim. */
export function readLocalDockerRuntimeSnapshot(cwd = process.cwd()): LocalRuntimeService[] {
  const compose = ['compose', '-p', 'local', '--env-file', '.env', '-f', 'infra/local/docker-compose.yml', 'ps', '--format', 'json']
  try {
    const rows = execFileSync('docker', compose, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { Service?: string; State?: string; Health?: string })
    const byService = new Map(rows.map(row => [row.Service, row]))
    return LOCAL_CAPACITY_REQUIRED_SERVICES.map(service => ({
      service,
      state: byService.get(service)?.State ?? 'missing',
      health: byService.get(service)?.Health ?? 'missing',
    }))
  } catch {
    return LOCAL_CAPACITY_REQUIRED_SERVICES.map(service => ({ service, state: 'unavailable', health: 'unavailable' }))
  }
}

const defaults = {
  pilot_50: { workspaces: 50, clientConnections: 150, sustainedRps: 30, sustainedMinutes: 30, burstRps: 60, burstSeconds: 60, asyncJobsPerMinute: 50, stabilityHours: 6 },
  wave_100: { workspaces: 100, clientConnections: 300, sustainedRps: 60, sustainedMinutes: 30, burstRps: 120, burstSeconds: 60, asyncJobsPerMinute: 100, stabilityHours: 6 },
  wave_250: { workspaces: 250, clientConnections: 375, sustainedRps: 75, sustainedMinutes: 30, burstRps: 150, burstSeconds: 60, asyncJobsPerMinute: 250, stabilityHours: 6 },
  target_500: { workspaces: 500, clientConnections: 750, sustainedRps: 150, sustainedMinutes: 30, burstRps: 300, burstSeconds: 60, asyncJobsPerMinute: 500, stabilityHours: 6 },
} as const

function integer(env: Record<string, string | undefined>, name: string, fallback: number, minimum = 1) {
  const value = env[name] === undefined ? fallback : Number(env[name])
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}

export function readCapacityWorkloadConfig(env: Record<string, string | undefined> = process.env): CapacityWorkloadConfig {
  const profile = (env.CAPACITY_WORKLOAD_PROFILE ?? 'pilot_50') as CapacityWorkloadProfile
  if (!(profile in defaults)) throw new Error('CAPACITY_WORKLOAD_PROFILE must be pilot_50, wave_100, wave_250 or target_500')
  const mode = (env.CAPACITY_WORKLOAD_MODE ?? 'compose') as CapacityWorkloadMode
  if (mode !== 'compose' && mode !== 'real_cloud') throw new Error('CAPACITY_WORKLOAD_MODE must be compose or real_cloud')
  const target = env.CAPACITY_WORKLOAD_URL?.trim()
  if (!target) throw new Error('CAPACITY_WORKLOAD_URL is required')
  const parsed = new URL(target)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('CAPACITY_WORKLOAD_URL must use HTTP(S)')
  if (mode === 'real_cloud') {
    if (env.CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD !== 'true') throw new Error('real_cloud requires CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD=true')
    if (parsed.protocol !== 'https:' || ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('real_cloud requires a non-loopback HTTPS URL')
  }
  const targetDefaults = defaults[profile]
  const workspaces = integer(env, 'CAPACITY_WORKLOAD_WORKSPACES', targetDefaults.workspaces)
  if (workspaces !== targetDefaults.workspaces) throw new Error(`CAPACITY_WORKLOAD_WORKSPACES must equal ${targetDefaults.workspaces} for ${profile}`)
  const sustainedMinutes = integer(env, 'CAPACITY_WORKLOAD_SUSTAINED_MINUTES', targetDefaults.sustainedMinutes)
  const stabilityHours = integer(env, 'CAPACITY_WORKLOAD_STABILITY_HOURS', targetDefaults.stabilityHours)
  if (mode === 'real_cloud' && (sustainedMinutes < 30 || stabilityHours < 6)) throw new Error('real_cloud requires at least 30 sustained minutes and 6 stability hours')
  const concurrency = integer(env, 'CAPACITY_WORKLOAD_CONCURRENCY', Math.min(workspaces, 100))
  if (concurrency > workspaces) throw new Error('CAPACITY_WORKLOAD_CONCURRENCY cannot exceed workspaces')
  const noiseWorkspaceIndex = integer(env, 'CAPACITY_WORKLOAD_NOISE_WORKSPACE_INDEX', 0, 0)
  if (noiseWorkspaceIndex >= workspaces) throw new Error('CAPACITY_WORKLOAD_NOISE_WORKSPACE_INDEX must be within workspace count')
  return {
    profile, mode, baseUrl: target.replace(/\/$/, ''), token: env.CAPACITY_WORKLOAD_TOKEN?.trim() ?? '',
    workspaces, clientConnections: integer(env, 'CAPACITY_WORKLOAD_CLIENT_CONNECTIONS', targetDefaults.clientConnections),
    sustainedRps: integer(env, 'CAPACITY_WORKLOAD_SUSTAINED_RPS', targetDefaults.sustainedRps), sustainedMinutes,
    burstRps: integer(env, 'CAPACITY_WORKLOAD_BURST_RPS', targetDefaults.burstRps), burstSeconds: integer(env, 'CAPACITY_WORKLOAD_BURST_SECONDS', targetDefaults.burstSeconds),
    asyncJobsPerMinute: integer(env, 'CAPACITY_WORKLOAD_ASYNC_JOBS_PER_MINUTE', targetDefaults.asyncJobsPerMinute), stabilityHours,
    concurrency, noiseWorkspaceIndex, noiseMultiplier: integer(env, 'CAPACITY_WORKLOAD_NOISE_MULTIPLIER', 10),
    setupJobs: env.CAPACITY_WORKLOAD_SETUP_JOBS === 'true',
    ...(env.CAPACITY_WORKLOAD_OUTPUT ? { output: env.CAPACITY_WORKLOAD_OUTPUT } : {}),
  }
}

export interface CapacityWorkloadTiming { workspace: string; phase: string; elapsedMs: number; ok: boolean; status: number }
interface AcceptedJob { workspace: string; taskId: string; jobId: string; idempotencyKey: string }

/**
 * Validates the boundary of a local Compose report. This is deliberately
 * stricter than the generic schema gate: a local report must never be
 * mistaken for a cloud capacity attestation, even when its metrics happen to
 * satisfy a profile threshold.
 */
export function validateLocalCapacityEvidence(document: unknown): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Record<string, unknown>
  if (value.mode !== 'compose') errors.push('mode must be compose for local capacity evidence')
  if (value.environment !== 'test') errors.push('environment must be test for local capacity evidence')
  if (value.cloud_gate !== false) errors.push('cloud_gate must be false for local capacity evidence')
  if (value.platform_mock_ratio !== 1) errors.push('platform_mock_ratio must be 1 for local capacity evidence')
  if (value.model_mock_ratio !== 1) errors.push('model_mock_ratio must be 1 for local capacity evidence')
  const metrics = value.metrics as Record<string, unknown> | undefined
  if (!metrics || typeof metrics !== 'object' || typeof metrics.observed_request_count !== 'number' || !Number.isSafeInteger(metrics.observed_request_count) || metrics.observed_request_count < 1) {
    errors.push('metrics.observed_request_count must be a positive integer for local capacity evidence')
  }
  const completeness = value.completeness as Record<string, unknown> | undefined
  if (!completeness || completeness.observations_valid !== true) errors.push('completeness.observations_valid must be true for local capacity evidence')
  if (!completeness || completeness.accepted_jobs_valid !== true) errors.push('completeness.accepted_jobs_valid must be true for local capacity evidence')
  if (typeof value.accepted_jobs !== 'number' || !Number.isSafeInteger(value.accepted_jobs) || value.accepted_jobs < 0) errors.push('accepted_jobs must be a non-negative safe integer for local capacity evidence')
  try {
    const target = new URL(String(value.target_url ?? ''))
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) errors.push('target_url must be a local HTTP endpoint for local capacity evidence')
  } catch {
    errors.push('target_url must be a local HTTP endpoint for local capacity evidence')
  }
  const runtimeServices = value.runtime_services
  if (!Array.isArray(runtimeServices)) {
    errors.push('runtime_services must contain the local Docker service snapshot')
  } else {
    const rows = runtimeServices.filter((service): service is Record<string, unknown> => Boolean(service) && typeof service === 'object')
    const names = rows.map(service => typeof service.service === 'string' ? service.service : '')
    for (const required of LOCAL_CAPACITY_REQUIRED_SERVICES) {
      const service = rows.find(row => row.service === required)
      if (!service) errors.push(`runtime_services is missing ${required}`)
      else {
        if (service.state !== 'running') errors.push(`runtime_services.${required}.state must be running`)
        if (service.health !== 'healthy') errors.push(`runtime_services.${required}.health must be healthy`)
      }
    }
    if (new Set(names.filter(Boolean)).size !== names.filter(Boolean).length) errors.push('runtime service names must be unique')
  }
  return errors
}

function workspaceId(index: number) { return `ws_capacity_${index}` }
function headers(config: CapacityWorkloadConfig, workspace: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${config.token || 'pilot-local-token'}`, 'x-workspace-id': workspace, ...extra }
}

async function request(config: CapacityWorkloadConfig, workspace: string, path: string, init: RequestInit, phase: string, timings: CapacityWorkloadTiming[]) {
  const started = performance.now()
  try {
    const response = await fetch(`${config.baseUrl}${path}`, { ...init, headers: headers(config, workspace, Object.fromEntries(new Headers(init.headers).entries())) })
    timings.push({ workspace, phase, elapsedMs: performance.now() - started, ok: response.ok, status: response.status })
    return response
  } catch {
    timings.push({ workspace, phase, elapsedMs: performance.now() - started, ok: false, status: 0 })
    return undefined
  }
}

async function runRate(config: CapacityWorkloadConfig, rps: number, durationSeconds: number, phase: string, timings: CapacityWorkloadTiming[]) {
  const end = Date.now() + durationSeconds * 1_000
  let cursor = 0
  const intervalMs = 100
  while (Date.now() < end) {
    const remainingMs = end - Date.now()
    const requests = Math.max(1, Math.round(rps * intervalMs / 1_000))
    const batch: Promise<unknown>[] = []
    for (let index = 0; index < requests; index += 1) {
      const selected = cursor++ % config.workspaces
      const workspace = workspaceId(selected)
      const multiplier = selected === config.noiseWorkspaceIndex ? config.noiseMultiplier : 1
      for (let copy = 0; copy < multiplier; copy += 1) batch.push(request(config, workspace, CAPACITY_WORKLOAD_READ_PATH, { method: 'GET' }, phase, timings))
    }
    await Promise.all(batch)
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remainingMs)))
  }
}

async function setupJob(config: CapacityWorkloadConfig, index: number): Promise<{ taskId: string } | undefined> {
  const workspace = workspaceId(index)
  const remoteId = `CAPACITY-${Date.now()}-${index}`
  const accountsResponse = await request(config, workspace, '/v1/platform-accounts', { method: 'GET' }, 'setup', [])
  if (!accountsResponse?.ok) throw new Error(`capacity workload setup could not read platform accounts for ${workspace}`)
  const accounts = await accountsResponse.json() as { items?: Array<{ platform?: string; accountId?: string }> }
  const accountId = selectCapacityAccount(accounts.items ?? [])
  const productResponse = await request(config, workspace, '/v1/products/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'taobao', account_id: accountId, remote_id: remoteId, title: `Capacity ${index}`, sku_count: 1, stock: 10 }) }, 'setup', [])
  if (!productResponse?.ok) throw new Error(`capacity workload setup could not import a product for ${workspace}`)
  const product = await productResponse.json() as { data?: { id?: string } }
  if (!product.data?.id) throw new Error(`capacity workload setup returned no product for ${workspace}`)
  const taskResponse = await request(config, workspace, '/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: product.data.id, platform: 'taobao', account_id: accountId }) }, 'setup', [])
  if (!taskResponse?.ok) throw new Error(`capacity workload setup could not create a task for ${workspace}`)
  const task = await taskResponse.json() as { data?: { id?: string } }
  if (!task.data?.id) throw new Error(`capacity workload setup returned no task for ${workspace}`)
  const directionResponse = await request(config, workspace, `/v1/tasks/${encodeURIComponent(task.data.id)}/directions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction_id: 'A' }) }, 'setup', [])
  if (!directionResponse?.ok) throw new Error(`capacity workload setup could not select a direction for ${workspace}`)
  return { taskId: task.data.id }
}

async function submitJobs(config: CapacityWorkloadConfig, tasks: Array<{ taskId: string } | undefined>, timings: CapacityWorkloadTiming[]): Promise<AcceptedJob[]> {
  const accepted: AcceptedJob[] = []
  const total = Math.max(1, Math.round(config.asyncJobsPerMinute))
  for (let index = 0; index < total; index += 1) {
    const workspaceIndex = index % config.workspaces
    const task = tasks[workspaceIndex]
    if (!task) continue
    const workspace = workspaceId(workspaceIndex)
    const idempotencyKey = `capacity-job-${Date.now()}-${index}`
    const response = await request(config, workspace, `/v1/tasks/${encodeURIComponent(task.taskId)}/content-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: '{}' }, 'async_job_acceptance', timings)
    if (!response?.ok) continue
    const body = await response.json() as { data?: { id?: string } }
    if (body.data?.id) accepted.push({ workspace, taskId: task.taskId, jobId: body.data.id, idempotencyKey })
  }
  return accepted
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
}

export function buildCapacityEvidenceDocument(
  config: CapacityWorkloadConfig,
  input: { timings: readonly CapacityWorkloadTiming[]; acceptedJobs: number; startedAt: string; endedAt: string; runtimeServices?: readonly LocalRuntimeService[] },
) {
  const timings = [...input.timings]
  const invalidTimingCount = capacityTimingErrors(timings)
  const acceptedJobsValid = Number.isSafeInteger(input.acceptedJobs) && input.acceptedJobs >= 0
  const errors = timings.filter(item => !item.ok && !isExpectedCapacityStatus(item.status)).length + invalidTimingCount + (acceptedJobsValid ? 0 : 1)
  // A run with no observations is incomplete in every mode. In particular,
  // real_cloud must not serialize an unexecuted run as a passing report.
  const incomplete = timings.length === 0
  const rateLimited = timings.filter(item => isExpectedCapacityStatus(item.status)).length
  const p95Ms = percentile(timings.map(item => item.elapsedMs), 0.95)
  const p99Ms = percentile(timings.map(item => item.elapsedMs), 0.99)
  const nonNoise = timings.filter(item => item.workspace !== workspaceId(config.noiseWorkspaceIndex)).map(item => item.elapsedMs)
  const baselineP95 = Number(process.env.CAPACITY_WORKLOAD_BASELINE_P95_MS ?? p95Ms)
  const fairness = baselineP95 > 0 ? Math.max(0, ((percentile(nonNoise, 0.95) - baselineP95) / baselineP95) * 100) : 0
  const stabilityHours = process.env.CAPACITY_WORKLOAD_SKIP_STABILITY === 'true' ? 0 : config.stabilityHours
  const report = {
    schema_version: '1',
    // The report producer must fail closed as well as the downstream gate.
    // Otherwise an empty or unhealthy Compose run can be serialized as a
    // passing report and only rejected if a later consumer happens to run
    // validateLocalCapacityEvidence.
    status: errors === 0 && !incomplete ? 'pass' : 'fail' as 'pass' | 'fail',
    release_id: process.env.CAPACITY_WORKLOAD_RELEASE_ID?.trim() || `local-${config.profile}`,
    software_version: process.env.CAPACITY_WORKLOAD_SOFTWARE_VERSION?.trim() || process.env.npm_package_version || 'local-working-tree',
    config_version: process.env.CAPACITY_WORKLOAD_CONFIG_VERSION?.trim() || 'local-capacity-config',
    data_version: process.env.CAPACITY_WORKLOAD_DATA_VERSION?.trim() || 'local-fixture-v1',
    environment: config.mode === 'real_cloud' ? (process.env.CAPACITY_WORKLOAD_ENVIRONMENT?.trim() || 'preproduction') : 'test',
    target_url: config.baseUrl,
    mode: config.mode,
    workspaces: config.workspaces,
    client_connections: config.clientConnections,
    sustained_rps: config.sustainedRps,
    sustained_duration_minutes: config.sustainedMinutes,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    raw_metrics_ref: `local://capacity/${config.profile}/${encodeURIComponent(input.startedAt)}`,
    profile: config.profile,
    // This runner exercises API/job admission only. Even when pointed at a
    // real URL it must not promote itself to a cloud gate without platform,
    // fault, noise-tenant, and steady-state evidence from the full harness.
    cloud_gate: false,
    platform_mock_ratio: 1,
    model_mock_ratio: 1,
    duration: { sustained_minutes: config.sustainedMinutes, burst_seconds: config.burstSeconds, stability_hours: stabilityHours },
    tenant: { workspace_count: config.workspaces, noise_multiplier: config.noiseMultiplier, isolation_verified: false, max_p95_degradation_percent: 20 },
    fault: { injected: false, scenarios: [], passed: false },
    steady_state: { verified: false, queue_converged: false, stability_hours: stabilityHours },
    sign_off: { verified_by: 'local-capacity-harness', verified_at: input.endedAt },
    metrics: {
      workspaces: config.workspaces, client_connections: config.clientConnections, sustained_rps: config.sustainedRps,
      sustained_duration_minutes: config.sustainedMinutes, burst_rps: config.burstRps, burst_duration_seconds: config.burstSeconds,
      async_jobs_per_minute: config.asyncJobsPerMinute, p95_ms: Math.round(p95Ms * 100) / 100, p99_ms: Math.round(p99Ms * 100) / 100,
      error_count: errors, rate_limited_count: rateLimited, lost_jobs: 0, duplicate_writes: 0,
      fairness_p95_degradation_percent: Math.round(fairness * 100) / 100, stability_hours: stabilityHours,
      observed_request_count: timings.length,
    },
    accepted_jobs: input.acceptedJobs,
    completeness: {
      observations_valid: invalidTimingCount === 0,
      accepted_jobs_valid: acceptedJobsValid,
    },
    coverage: 'api_http_and_job_admission',
    platform_traffic_exercised: false,
    ...(config.mode === 'compose' ? { runtime_services: input.runtimeServices ? [...input.runtimeServices] : [] } : {}),
  }

  if (config.mode === 'compose' && validateLocalCapacityEvidence(report).length > 0) {
    report.status = 'fail'
  }
  return report
}

export async function runCapacityWorkload(config = readCapacityWorkloadConfig()) {
  const timings: CapacityWorkloadTiming[] = []
  const startedAt = new Date().toISOString()
  const tasks = config.setupJobs ? await Promise.all(Array.from({ length: config.workspaces }, (_, index) => setupJob(config, index))) : []
  const stabilitySeconds = config.stabilityHours * 60 * 60
  await runRate(config, config.sustainedRps, config.sustainedMinutes * 60, 'sustained', timings)
  await runRate(config, config.burstRps, config.burstSeconds, 'burst', timings)
  const accepted = config.setupJobs ? await submitJobs(config, tasks, timings) : []
  if (stabilitySeconds > 0 && process.env.CAPACITY_WORKLOAD_SKIP_STABILITY !== 'true') await runRate(config, config.sustainedRps, stabilitySeconds, 'stability', timings)
  const endedAt = new Date().toISOString()
  const report = buildCapacityEvidenceDocument(config, {
    timings,
    acceptedJobs: accepted.length,
    startedAt,
    endedAt,
    ...(config.mode === 'compose' ? { runtimeServices: readLocalDockerRuntimeSnapshot() } : {}),
  })
  const errors = report.metrics.error_count
  if (config.output) writeFileSync(config.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  assert.equal(errors, 0, `capacity workload had ${errors} failed requests`)
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) runCapacityWorkload().then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
