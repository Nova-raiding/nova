import type { Platform } from '../../../packages/application/src/service.js'
import type { MerchantService } from '../../../packages/application/src/service.js'
import type { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'

export interface RuntimeHealthDependencies {
  service: Pick<MerchantService, 'health'>
  maxActiveJobsPerWorkspace: number
  redisRateLimitHealth: { state: 'not_configured' | 'configured' | 'ready' | 'degraded'; lastFailureAt?: string }
  redisJobAdmission: unknown
  SUPPORTED_PLATFORMS: readonly Platform[]
  platformWriteReady: (platform: Platform) => boolean
  setupDiagnostics: (options: { commercialReadiness?: { ready: boolean; reasons?: string[] } }) => ReturnType<typeof import('./health-setup.js').setupDiagnostics>
  manualPlatformOperationsMode: boolean
  connectorRuntime: Pick<ConnectorRuntime, 'isOAuthConfigured'>
}

const DEFAULT_RATE_LIMIT = 120

export function runtimeHealth(options: { commercialReadiness?: { ready: boolean; reasons?: string[] } } = {}, deps: RuntimeHealthDependencies) {
  const { service, maxActiveJobsPerWorkspace, redisRateLimitHealth, redisJobAdmission, SUPPORTED_PLATFORMS, platformWriteReady, setupDiagnostics, manualPlatformOperationsMode, connectorRuntime } = deps
  const base = service.health()
  const configuredRateLimit = Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT)
  const configuredOpsRateLimit = Number(process.env.OPS_API_RATE_LIMIT_PER_MINUTE ?? 600)
  return {
    ...base,
    capacity: {
      maxActiveJobsPerWorkspace,
      apiRateLimitPerMinute: Number.isFinite(configuredRateLimit) && configuredRateLimit > 0 ? configuredRateLimit : DEFAULT_RATE_LIMIT,
      opsApiRateLimitPerMinute: Number.isFinite(configuredOpsRateLimit) && configuredOpsRateLimit > 0 ? configuredOpsRateLimit : 600,
      rateLimitScope: 'workspace_actor',
      rateLimit: { mode: redisRateLimitHealth.state === 'ready' ? 'redis_atomic' : 'process_local', ...redisRateLimitHealth },
      jobAdmission: redisJobAdmission ? 'redis_atomic' : 'process_local',
    },
    writesEnabled: SUPPORTED_PLATFORMS.some(platform => platformWriteReady(platform)),
    setup: setupDiagnostics(options),
    connectors: {
      ...base.connectors,
      ...(manualPlatformOperationsMode ? Object.fromEntries(SUPPORTED_PLATFORMS.map(platform => [platform, 'manual_operations'])) : {}),
      ...(!manualPlatformOperationsMode ? {
        jd: connectorRuntime.isOAuthConfigured('jd') ? 'configured_provider_required' : base.connectors.jd,
        taobao: connectorRuntime.isOAuthConfigured('taobao') ? 'configured_provider_required' : base.connectors.taobao,
        tmall: connectorRuntime.isOAuthConfigured('tmall') ? 'configured_provider_required' : base.connectors.tmall,
        pinduoduo: connectorRuntime.isOAuthConfigured('pinduoduo') ? 'configured_provider_required' : base.connectors.pinduoduo,
      } : {}),
    },
  }
}

