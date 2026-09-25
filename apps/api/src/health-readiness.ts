import { alertNotificationReadiness } from './alert-notifier.js'
import { evaluatePlatformModelRelayGate, evaluatePlatformModelGate, evaluatePlatformModelCostGate, evaluatePlatformModelTaskCostLimit } from '../../../packages/ai/src/platform-model-gate.js'
import { COMMERCIAL_OPERATION_REGISTRY } from '../../../packages/contracts/src/index.js'
import type { CommercialCatalogRepository } from '../../../packages/persistence/src/index.js'

type ProductionReadinessGate = { ready: boolean; reasons: string[] }
export interface ProductionReadinessDependencies {
  requiredModelCostEvidenceByModality: (source?: NodeJS.ProcessEnv) => Record<string, boolean>
  productionAuthorizationReadiness: (source: NodeJS.ProcessEnv, production: boolean) => ProductionReadinessGate
  productionIdentityReadiness: (source: NodeJS.ProcessEnv) => ProductionReadinessGate
  productionObjectStorageReadiness: (source: NodeJS.ProcessEnv) => ProductionReadinessGate
  productionAssetScannerReadiness: (source: NodeJS.ProcessEnv) => ProductionReadinessGate
  productionPaymentReadiness: (source: NodeJS.ProcessEnv) => ProductionReadinessGate
  productionRuleSyncReadiness: (source: NodeJS.ProcessEnv) => ProductionReadinessGate
  productionReleaseMetadataReadiness: (source: NodeJS.ProcessEnv) => ProductionReadinessGate
}

/** Deployment readiness is stricter than process liveness. Test profiles keep
 * their dependency-only readiness behavior; every production process,
 * including one accidentally configured for fixtures, must fail closed before
 * it receives traffic when a critical external-control-plane gate is missing. */
export function productionReadinessDiagnostics(source: NodeJS.ProcessEnv = process.env, dependencies: ProductionReadinessDependencies) {
  const { requiredModelCostEvidenceByModality, productionAuthorizationReadiness, productionIdentityReadiness, productionObjectStorageReadiness, productionAssetScannerReadiness, productionPaymentReadiness, productionRuleSyncReadiness, productionReleaseMetadataReadiness } = dependencies
  // CONNECTOR_FIXTURE_MODE is acceptable for local/test acceptance only. It
  // must never make a production process ready or eligible for traffic.
  const required = source.NODE_ENV === 'production'
  if (!required) return { required: false, ready: true, gates: {} as Record<string, ProductionReadinessGate> }

  const relayResults = {
    relay: evaluatePlatformModelRelayGate(source),
    text: evaluatePlatformModelGate(source, 'text'),
    image: evaluatePlatformModelGate(source, 'image'),
    image_edit: evaluatePlatformModelGate(source, 'image_edit'),
    ocr: evaluatePlatformModelGate(source, 'ocr'),
    video: evaluatePlatformModelGate(source, 'video'),
  }
  const relay: ProductionReadinessGate = {
    ready: Object.values(relayResults).every(result => result.ready),
    reasons: Object.entries(relayResults).flatMap(([kind, result]) => result.reasons.map(reason => `${kind}:${reason}`)),
  }
  const costGate = evaluatePlatformModelCostGate(source)
  const taskCostGate = evaluatePlatformModelTaskCostLimit(source)
  const costEvidence = requiredModelCostEvidenceByModality(source)
  const cost: ProductionReadinessGate = {
    ready: costGate.ready && taskCostGate.ready && Object.values(costEvidence).every(Boolean),
    reasons: [
      ...costGate.reasons.map(reason => `limits:${reason}`),
      ...taskCostGate.reasons.map(reason => `limits:${reason}`),
      ...Object.entries(costEvidence).filter(([, ready]) => !ready).map(([kind]) => `${kind}:cost_evidence_missing`),
    ],
  }
  const gates: Record<string, ProductionReadinessGate> = {
    relay,
    authorization: productionAuthorizationReadiness(source, true),
    identity: productionIdentityReadiness(source),
    object_storage: productionObjectStorageReadiness(source),
    asset_scanner: productionAssetScannerReadiness(source),
    payment: productionPaymentReadiness(source),
    rule_sync: productionRuleSyncReadiness(source),
    cost,
    alerts: (() => {
      const readiness = alertNotificationReadiness(source)
      return { ready: readiness.ready, reasons: readiness.ready ? [] : [readiness.reason ?? 'alert_notification_not_ready'] }
    })(),
    release_metadata: productionReleaseMetadataReadiness(source),
  }
  return { required: true, ready: Object.values(gates).every(gate => gate.ready), gates }
}

/**
 * Persistence-backed commercial readiness. Environment checks alone cannot
 * prove that production can charge safely: the catalog and rate card must be
 * approved, effective, executable snapshots, and at least one charged MCP
 * operation must be explicitly enabled by the business registry. This check
 * is intentionally read-only and fail-closed.
 */
export async function productionCommercialReadiness(repository: CommercialCatalogRepository | undefined) {
  const reasons: string[] = []
  if (!repository) {
    reasons.push('commercial_catalog_repository_missing')
    return { ready: false, reasons, catalog: { executable: 0, executable_monthly: 0 }, rates: { executable: 0 }, charged_methods: { enabled: 0 } }
  }
  const [catalog, rates] = await Promise.all([repository.list({ includePrivate: false, capabilities: [] }), repository.listRates()])
  const executableCatalog = catalog.filter(item => item.lifecycle === 'approved' && item.executable && item.effectiveAt !== null)
  // Point packs add balance but do not create the entitlement snapshot required
  // by CommercialAccessService.  Treating a point-pack-only catalog as ready
  // would advertise a purchase path that still cannot use the product.
  const executableMonthlyCatalog = executableCatalog.filter(item => item.kind === 'monthly')
  const executableRates = rates.filter(rate => rate.lifecycle === 'approved' && rate.approvalStatus === 'approved' && rate.executable && rate.ruleExecutable && Number.isSafeInteger(rate.integerPoints) && (rate.integerPoints ?? 0) > 0 && rate.effectiveAt !== null)
  const enabledChargedMethods = COMMERCIAL_OPERATION_REGISTRY.filter(policy => policy.surface === 'MCP' && policy.classification === 'POINT_CHARGED' && policy.enabled)
  if (executableCatalog.length === 0) reasons.push('commercial_executable_catalog_missing')
  if (executableMonthlyCatalog.length === 0) reasons.push('commercial_executable_monthly_plan_missing')
  if (executableRates.length === 0) reasons.push('commercial_approved_rate_missing')
  if (enabledChargedMethods.length === 0) reasons.push('commercial_charged_methods_disabled')
  return {
    ready: reasons.length === 0,
    reasons,
    catalog: { executable: executableCatalog.length, executable_monthly: executableMonthlyCatalog.length },
    rates: { executable: executableRates.length },
    charged_methods: { enabled: enabledChargedMethods.length },
  }
}

