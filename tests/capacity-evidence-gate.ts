import { readFileSync } from 'node:fs'

type Profile = 'pilot_50' | 'wave_100' | 'wave_250' | 'target_500'
type CapacityEvidence = {
  schema_version?: string; status?: string; release_id?: string; config_version?: string; environment?: string; target_url?: string
  started_at?: string; ended_at?: string; expires_at?: string; profile?: Profile; cloud_gate?: boolean; raw_metrics_ref?: string
  metrics?: Record<string, number>; platform_mock_ratio?: number; model_mock_ratio?: number
  duration?: { sustained_minutes?: number; burst_seconds?: number; stability_hours?: number }
  tenant?: { workspace_count?: number; noise_multiplier?: number; isolation_verified?: boolean; max_p95_degradation_percent?: number }
  fault?: { injected?: boolean; scenarios?: string[]; passed?: boolean }
  steady_state?: { verified?: boolean; queue_converged?: boolean; stability_hours?: number }
  sign_off?: { verified_by?: string; verified_at?: string }
}

const minimums: Record<Profile, Record<string, number>> = {
  pilot_50: { workspaces: 50, client_connections: 150, sustained_rps: 30, sustained_duration_minutes: 30, burst_rps: 60, burst_duration_seconds: 60, async_jobs_per_minute: 50 },
  wave_100: { workspaces: 100, client_connections: 300, sustained_rps: 60, sustained_duration_minutes: 30, burst_rps: 120, burst_duration_seconds: 60, async_jobs_per_minute: 100 },
  wave_250: { workspaces: 250, client_connections: 375, sustained_rps: 75, sustained_duration_minutes: 30, burst_rps: 150, burst_duration_seconds: 60, async_jobs_per_minute: 250 },
  target_500: { workspaces: 500, client_connections: 750, sustained_rps: 150, sustained_duration_minutes: 30, burst_rps: 300, burst_duration_seconds: 60, async_jobs_per_minute: 500 },
}
const p95Budgets: Record<Profile, number> = { pilot_50: 1000, wave_100: 1200, wave_250: 1600, target_500: 2000 }

const requiredMetrics = ['workspaces', 'client_connections', 'sustained_rps', 'sustained_duration_minutes', 'burst_rps', 'burst_duration_seconds', 'async_jobs_per_minute', 'p95_ms', 'p99_ms', 'error_count', 'duplicate_writes', 'lost_jobs', 'fairness_p95_degradation_percent', 'stability_hours'] as const
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isIsoInstant = (value: unknown): value is string => nonEmpty(value)
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && !Number.isNaN(Date.parse(value))

export function validateCapacityEvidence(document: unknown, options: { requireCloudGate?: boolean; expectedReleaseId?: string; expectedProfile?: Profile; now?: Date } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as CapacityEvidence
  for (const field of ['schema_version', 'status', 'release_id', 'config_version', 'environment', 'target_url', 'started_at', 'ended_at', 'raw_metrics_ref'] as const) if (!nonEmpty(value[field])) errors.push(`${field} is required`)
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (options.expectedProfile && value.profile !== options.expectedProfile) errors.push(`profile must match ${options.expectedProfile}`)
  if (!value.profile || !(value.profile in minimums)) errors.push('profile must be pilot_50, wave_100, wave_250 or target_500')
  for (const field of ['started_at', 'ended_at'] as const) if (!isIsoInstant(value[field])) errors.push(`${field} must be an ISO instant`)
  if (isIsoInstant(value.started_at) && isIsoInstant(value.ended_at) && Date.parse(value.ended_at) < Date.parse(value.started_at)) errors.push('ended_at must not be before started_at')
  const metrics = value.metrics
  if (!metrics || typeof metrics !== 'object') return [...errors, 'metrics is required']
  for (const metric of requiredMetrics) if (typeof metrics[metric] !== 'number' || !Number.isFinite(metrics[metric])) errors.push(`metrics.${metric} must be a finite number`)
  for (const [metric, amount] of Object.entries(metrics)) if (typeof amount === 'number' && Number.isFinite(amount) && amount < 0) errors.push(`metrics.${metric} must not be negative`)
  if (value.profile && minimums[value.profile]) for (const [metric, minimum] of Object.entries(minimums[value.profile])) if (typeof metrics[metric] === 'number' && metrics[metric] < minimum) errors.push(`metrics.${metric} is below ${value.profile} threshold ${minimum}`)
  if (value.profile && typeof metrics.p95_ms === 'number' && metrics.p95_ms > p95Budgets[value.profile]) errors.push(`metrics.p95_ms exceeds ${value.profile} budget ${p95Budgets[value.profile]}`)
  if (typeof metrics.p95_ms === 'number' && typeof metrics.p99_ms === 'number' && metrics.p99_ms < metrics.p95_ms) errors.push('metrics.p99_ms must be greater than or equal to metrics.p95_ms')
  if (metrics.error_count !== 0) errors.push('metrics.error_count must be 0')
  if (metrics.duplicate_writes !== 0) errors.push('metrics.duplicate_writes must be 0')
  if (metrics.lost_jobs !== 0) errors.push('metrics.lost_jobs must be 0')
  if (typeof metrics.fairness_p95_degradation_percent === 'number' && metrics.fairness_p95_degradation_percent > 20) errors.push('metrics.fairness_p95_degradation_percent must be <= 20')
  if (typeof metrics.stability_hours === 'number' && metrics.stability_hours < 6) errors.push('metrics.stability_hours must be >= 6')
  for (const field of ['platform_mock_ratio', 'model_mock_ratio'] as const) if (typeof value[field] !== 'number' || value[field] < 0 || value[field] > 1) errors.push(`${field} must be between 0 and 1`)
  try {
    const target = new URL(value.target_url!)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) errors.push('target_url must be a plain HTTP(S) URL')
  } catch { errors.push('target_url must be a valid URL') }
  if (!value.sign_off || !nonEmpty(value.sign_off.verified_by) || !nonEmpty(value.sign_off.verified_at)) errors.push('sign_off.verified_by and sign_off.verified_at are required')
  else if (!isIsoInstant(value.sign_off.verified_at)) errors.push('sign_off.verified_at must be an ISO instant')
  else if (isIsoInstant(value.started_at) && isIsoInstant(value.ended_at)) {
    const signedAt = Date.parse(value.sign_off.verified_at)
    if (signedAt < Date.parse(value.started_at) || signedAt > Date.parse(value.ended_at)) errors.push('sign_off.verified_at must fall within the test interval')
  }
  if (options.requireCloudGate || value.cloud_gate === true) {
    if (value.status !== 'pass') errors.push('status must be pass for cloud gate')
    if (value.cloud_gate !== true) errors.push('cloud_gate must be true')
    if (value.environment !== 'preproduction' && value.environment !== 'production') errors.push('environment must be preproduction or production')
    try { if (new URL(value.target_url!).protocol !== 'https:') errors.push('target_url must use HTTPS') } catch { errors.push('target_url must be a valid URL') }
    if (value.platform_mock_ratio !== 0 || value.model_mock_ratio !== 0) errors.push('cloud gate requires zero platform/model mock ratio')
    if (!isIsoInstant(value.expires_at)) errors.push('expires_at must be an ISO instant')
    else {
      const expiresAt = Date.parse(value.expires_at)
      const now = (options.now ?? new Date()).getTime()
      if (isIsoInstant(value.ended_at) && expiresAt <= Date.parse(value.ended_at)) errors.push('expires_at must be after ended_at')
      if (expiresAt <= now) errors.push('capacity evidence is expired')
    }

    const duration = value.duration
    if (!duration || typeof duration !== 'object') errors.push('duration is required')
    else {
      for (const field of ['sustained_minutes', 'burst_seconds', 'stability_hours'] as const) {
        if (typeof duration[field] !== 'number' || !Number.isFinite(duration[field]) || duration[field] <= 0) errors.push(`duration.${field} must be a positive finite number`)
      }
      if (typeof duration.sustained_minutes === 'number' && duration.sustained_minutes !== metrics.sustained_duration_minutes) errors.push('duration.sustained_minutes must match metrics.sustained_duration_minutes')
      if (typeof duration.burst_seconds === 'number' && duration.burst_seconds !== metrics.burst_duration_seconds) errors.push('duration.burst_seconds must match metrics.burst_duration_seconds')
      if (typeof duration.stability_hours === 'number' && duration.stability_hours !== metrics.stability_hours) errors.push('duration.stability_hours must match metrics.stability_hours')
    }

    const tenant = value.tenant
    if (!tenant || typeof tenant !== 'object') errors.push('tenant is required')
    else {
      if (tenant.workspace_count !== metrics.workspaces) errors.push('tenant.workspace_count must match metrics.workspaces')
      if (typeof tenant.workspace_count !== 'number' || !Number.isSafeInteger(tenant.workspace_count) || tenant.workspace_count <= 0) errors.push('tenant.workspace_count must be a positive safe integer')
      if (typeof tenant.noise_multiplier !== 'number' || !Number.isFinite(tenant.noise_multiplier) || tenant.noise_multiplier < 10) errors.push('tenant.noise_multiplier must be at least 10')
      if (tenant.isolation_verified !== true) errors.push('tenant.isolation_verified must be true')
      if (tenant.max_p95_degradation_percent !== 20) errors.push('tenant.max_p95_degradation_percent must be 20')
    }

    const fault = value.fault
    if (!fault || typeof fault !== 'object') errors.push('fault is required')
    else {
      if (fault.injected !== true) errors.push('fault.injected must be true')
      if (!Array.isArray(fault.scenarios) || fault.scenarios.length === 0 || fault.scenarios.some(scenario => !nonEmpty(scenario))) errors.push('fault.scenarios must contain at least one named scenario')
      if (fault.passed !== true) errors.push('fault.passed must be true')
    }

    const steadyState = value.steady_state
    if (!steadyState || typeof steadyState !== 'object') errors.push('steady_state is required')
    else {
      if (steadyState.verified !== true) errors.push('steady_state.verified must be true')
      if (steadyState.queue_converged !== true) errors.push('steady_state.queue_converged must be true')
      if (steadyState.stability_hours !== metrics.stability_hours || typeof steadyState.stability_hours !== 'number' || steadyState.stability_hours < 6) errors.push('steady_state.stability_hours must match metrics.stability_hours and be at least 6')
    }
  }
  return errors
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const path = (fileIndex >= 0 ? args[fileIndex + 1] : undefined) ?? 'doc/todo/infra/capacity-evidence.example.json'
  const releaseIndex = args.indexOf('--release-id')
  const expectedReleaseId = releaseIndex >= 0 ? args[releaseIndex + 1] : undefined
  const profileIndex = args.indexOf('--profile')
  const expectedProfile = profileIndex >= 0 ? args[profileIndex + 1] as Profile : undefined
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read JSON capacity evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCapacityEvidence(document, { requireCloudGate: args.includes('--require-cloud-gate'), expectedReleaseId, expectedProfile })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(args.includes('--require-cloud-gate')
    ? `capacity evidence gate passed: ${path} (real cloud requirements validated; release binding is a separate gate)`
    : `capacity evidence schema passed: ${path} (fixture/non-production validation only; not real-cloud evidence)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
