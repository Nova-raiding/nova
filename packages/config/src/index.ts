export interface CapacityProfile {
  readonly name: 'pilot_50' | 'scale_500'
  readonly max_concurrent_workspaces: number
  readonly max_active_jobs_per_workspace: number
  readonly api_rate_limit_rps: number
  readonly publish_rate_limit_per_minute: number
}

export const DEFAULT_CAPACITY_PROFILE: CapacityProfile = {
  name: 'pilot_50',
  max_concurrent_workspaces: 50,
  max_active_jobs_per_workspace: 3,
  api_rate_limit_rps: 30,
  publish_rate_limit_per_minute: 50,
}

export interface RuntimeConfig {
  readonly environment: 'development' | 'test' | 'staging' | 'production'
  readonly public_base_url: string
  readonly capacity: CapacityProfile
}

export function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}
