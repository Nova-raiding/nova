import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiEnvelope } from '../../../packages/contracts/src/index.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { CommercialCatalogRepository } from '../../../packages/persistence/src/index.js'
import type { RedisHealthPort } from './redis-ports.js'
import type { ScannerReadinessSummary } from './server.js'

/** Dependencies are captured by the server so health probes observe live persistence state. */
export interface HttpHealthRouteDependencies {
  send: <T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error?: ApiEnvelope<T>['error'], req?: IncomingMessage) => void
  fail: (res: ServerResponse, status: number, workspaceId: string, code: string, message: string, req?: IncomingMessage, details?: Readonly<Record<string, unknown>>) => void
  persistence: { mode: string; checkHealth?: () => Promise<unknown>; commercialCatalog?: CommercialCatalogRepository }
  persistenceError: unknown
  persistenceReady: Promise<unknown>
  redisHealth: RedisHealthPort | undefined
  runtimeHealth: typeof import('./server.js').runtimeHealth
  productionReadinessDiagnostics: typeof import('./server.js').productionReadinessDiagnostics
  productionCommercialReadiness: typeof import('./server.js').productionCommercialReadiness
  setupDiagnostics: (options: { commercialReadiness?: { ready: boolean; reasons?: string[] } }) => { productionGate: boolean; nextActions: string[] }
  isProduction: () => boolean
  requiresStrictAuth: () => boolean
  scannerHeartbeatRequiredForProbe: typeof import('./server.js').scannerHeartbeatRequiredForProbe
  productionAssetScannerReadiness: (source: NodeJS.ProcessEnv) => { ready: boolean; reasons: string[] }
  evaluateScannerHeartbeatReadiness: typeof import('./server.js').evaluateScannerHeartbeatReadiness
}

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export async function handleHttpHealthRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpHealthRouteDependencies): Promise<boolean> {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !['/livez', '/releasez', '/healthz', '/readyz'].includes(path)) return false
  const {
    send, fail, persistence, persistenceError, persistenceReady, redisHealth,
    runtimeHealth, productionReadinessDiagnostics, productionCommercialReadiness,
    setupDiagnostics, isProduction, requiresStrictAuth, scannerHeartbeatRequiredForProbe,
    productionAssetScannerReadiness, evaluateScannerHeartbeatReadiness,
  } = deps
  async function respond(): Promise<void> {
  if (path === '/livez') return send(res, 200, 'system', { process: { ready: true } }, null, req)
  if (path === '/releasez') {
    const release = {
      release_id: process.env.RELEASE_ID?.trim() || null,
      release_git_sha: process.env.RELEASE_GIT_SHA?.trim() || null,
      manifest_sha256: process.env.RELEASE_MANIFEST_SHA256?.trim() || null,
      image_set_digest: process.env.RELEASE_IMAGE_SET_DIGEST?.trim() || null,
    }
    const valid = Boolean(
      RELEASE_ID_PATTERN.test(release.release_id ?? '')
      && /^[0-9a-f]{40}$/u.test(release.release_git_sha ?? '')
      && /^[0-9a-f]{64}$/u.test(release.manifest_sha256 ?? '')
      && /^sha256:[0-9a-f]{64}$/u.test(release.image_set_digest ?? ''),
    )
    if (isProduction() && !valid) return send(res, 503, 'system', { release, ready: false }, { code: 'RELEASE_METADATA_UNAVAILABLE', message: '生产发布元数据未完整注入' }, req)
    return send(res, 200, 'system', { release, ready: valid }, null, req)
  }
  if (path === '/healthz' || path === '/readyz') {
    if (persistenceError) return send(res, 503, 'system', { ...runtimeHealth(), persistence: { mode: 'postgres', ready: false } }, { code: ERROR_CODES.DATABASE_UNAVAILABLE, message: '数据库未就绪' }, req)
    try {
      await persistenceReady
      await persistence.checkHealth?.()
    } catch {
      return send(res, 503, 'system', { ...runtimeHealth(), persistence: { mode: persistence.mode, ready: false } }, { code: ERROR_CODES.DATABASE_UNAVAILABLE, message: '数据库未就绪' }, req)
    }
    const productionReadiness = productionReadinessDiagnostics()
    const commercialReadiness = productionReadiness.required
      ? await productionCommercialReadiness(persistence.commercialCatalog).catch(() => ({
          ready: false,
          reasons: ['commercial_readiness_unavailable'],
          catalog: { executable: 0, executable_monthly: 0 },
          rates: { executable: 0 },
          charged_methods: { enabled: 0 },
        }))
      : { ready: true, reasons: [], catalog: { executable: 0, executable_monthly: 0 }, rates: { executable: 0 }, charged_methods: { enabled: 0 } }
    const healthOptions = productionReadiness.required ? { commercialReadiness } : {}
    if (path === '/readyz') {
      const setup = productionReadiness.required ? setupDiagnostics({ commercialReadiness }) : undefined
      const setupReadiness = setup
        ? { ready: setup.productionGate, reasons: setup.productionGate ? [] : setup.nextActions }
        : { ready: true, reasons: [] as string[] }
      if (!productionReadiness.ready || !commercialReadiness.ready || !setupReadiness.ready) {
        // The per-gate detail is deliberately kept here. `/readyz` is public and
        // does leak which subsystems are unconfigured, but this body is the
        // documented operator triage surface (the runbook and
        // production-readiness.e2e.test.ts both depend on it), and the endpoint
        // already fails closed with a stable code. Restrict the ingress if the
        // reconnaissance surface matters more than that affordance.
        return fail(res, 503, 'system', 'PRODUCTION_READINESS_BLOCKED', '生产关键依赖或发布元数据未就绪', req, {
          gates: productionReadiness.gates,
          commercial: commercialReadiness,
          runtime_setup: setupReadiness,
          next_actions: ['完成模型中转、授权强制模式、持久角色权威、身份、对象存储、支付、规则同步、成本控制和 release metadata 配置后重新检查 /readyz'],
        })
      }
    }
    if (redisHealth) {
      try { await redisHealth.ping() } catch { return send(res, 503, 'system', { ...runtimeHealth(healthOptions), persistence: { mode: persistence.mode, ready: true }, redis: { ready: false } }, { code: 'REDIS_UNAVAILABLE', message: 'Redis 未就绪' }, req) }
    } else if (requiresStrictAuth()) {
      return send(res, 503, 'system', { ...runtimeHealth(healthOptions), persistence: { mode: persistence.mode, ready: true }, redis: { ready: false } }, { code: 'REDIS_UNAVAILABLE', message: '生产环境未配置 Redis', }, req)
    }
    let scanner: ScannerReadinessSummary | undefined
    if (scannerHeartbeatRequiredForProbe(path, process.env)) {
      const trust = productionAssetScannerReadiness(process.env)
      if (!trust.ready) {
        return fail(res, 503, 'system', 'SCANNER_NOT_READY', '素材安全扫描信任配置未就绪', req, {
          scanner: { ready: false, configured: false, recovery_ready: false },
          reasons: trust.reasons,
        })
      }
      if (!redisHealth) {
        return fail(res, 503, 'system', 'SCANNER_HEARTBEAT_MISSING', '未发现新鲜的素材安全扫描心跳', req, {
          scanner: { ready: false, configured: true, recovery_ready: false },
          reasons: ['SCANNER_HEARTBEAT_MISSING'],
        })
      }
      let readiness: Awaited<ReturnType<typeof evaluateScannerHeartbeatReadiness>>
      try {
        readiness = await evaluateScannerHeartbeatReadiness({ redis: redisHealth, env: process.env })
      } catch {
        return send(res, 503, 'system', { ...runtimeHealth(healthOptions), persistence: { mode: persistence.mode, ready: true }, redis: { ready: false } }, { code: 'REDIS_UNAVAILABLE', message: 'Redis 未就绪' }, req)
      }
      scanner = readiness.summary
      if (!readiness.ready) {
        return fail(res, 503, 'system', readiness.code, '素材安全扫描服务未就绪', req, {
          scanner: readiness.summary,
          reasons: readiness.reasons,
        })
      }
    }
    return send(res, 200, 'system', { ...runtimeHealth(healthOptions), persistence: { mode: persistence.mode, ready: true }, redis: { ready: Boolean(redisHealth) }, ...(scanner ? { scanner } : {}) }, null, req)
  }
  }
  await respond()
  return true
}
