export type ComposeServiceState = {
  Service?: unknown
  State?: unknown
  Health?: unknown
  Status?: unknown
}

export function parseComposeServiceStates(output: string): ComposeServiceState[] {
  const value = output.trim()
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object') as ComposeServiceState[]
    if (parsed && typeof parsed === 'object') return [parsed as ComposeServiceState]
  } catch {
    const rows: ComposeServiceState[] = []
    for (const line of value.split(/\r?\n/u).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as ComposeServiceState)
      } catch { return [] }
    }
    return rows
  }
  return []
}

export function composeServiceHealth(rows: ComposeServiceState[], service: string) {
  const row = rows.find(item => item.Service === service)
  if (!row) return { present: false, healthy: false, detail: 'not running' }
  const state = typeof row.State === 'string' ? row.State.toLowerCase() : ''
  const health = typeof row.Health === 'string' ? row.Health.toLowerCase() : ''
  const status = typeof row.Status === 'string' ? row.Status : ''
  return {
    present: true,
    healthy: state === 'running' && health === 'healthy',
    detail: status || [state, health].filter(Boolean).join('/'),
  }
}

export function releaseReadiness(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.ready === 'boolean') return record.ready
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return undefined
  const ready = (record.data as Record<string, unknown>).ready
  return typeof ready === 'boolean' ? ready : undefined
}

export type CommercialRuntimeReadiness = {
  mode?: string
  writesEnabled?: boolean
  persistenceReady?: boolean
  paymentReady?: boolean
  paymentMode?: string
  modelRelayReady?: boolean
  objectStorageReady?: boolean
  objectStorageMode?: string
  scannerReady?: boolean
  alertReady?: boolean
  productionGate?: boolean
}

const REQUIRED_PLATFORM_KEYS = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
const REQUIRED_RELAY_MODALITIES = ['text', 'image', 'image_edit', 'ocr', 'video'] as const

export type CommercialRuntimeAudit = {
  mode?: string
  writesEnabled?: boolean
  payment: { ready: boolean; mode?: string; reasons: string[] }
  platforms: { ready: boolean; missingOAuthPlatforms: string[]; blockedPlatforms: string[] }
  relay: { ready: boolean; costGateReady: boolean; blockedModalities: string[]; missingProviderConfigured: string[]; reasons: string[] }
  productionGate?: boolean
}

export type ModelRelayEvidenceAudit = {
  ready: boolean
  blockedModalities: string[]
  http503Modalities: string[]
  missingProviderRequestId: string[]
  missingUsageEvidence: string[]
  missingCostEvidence: string[]
  reasons: string[]
}

export type CodexAppHostEvidenceAudit = {
  ready: boolean
  reasons: string[]
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const objectArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(objectRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : []

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []

/** Extracts only non-secret readiness facts from the public /readyz envelope. */
export function commercialRuntimeReadiness(payload: unknown): CommercialRuntimeReadiness | undefined {
  const root = objectRecord(payload)
  const data = objectRecord(root?.data)
  const setup = objectRecord(data?.setup)
  if (!data || !setup) return undefined
  const payment = objectRecord(setup.payment)
  const ai = objectRecord(setup.ai)
  const modelReadiness = objectRecord(setup.modelReadiness)
  const objectStorage = objectRecord(setup.objectStorage)
  const scanner = objectRecord(setup.assetScanner)
  const alerts = objectRecord(setup.alertNotifications)
  const persistence = objectRecord(data.persistence)
  const modelRows = modelReadiness ? Object.values(modelReadiness).map(objectRecord).filter(Boolean) as Record<string, unknown>[] : []
  const paymentMode = typeof payment?.mode === 'string' ? payment.mode : undefined
  const paymentConfigured = payment?.configured === true
  const objectStorageMode = typeof objectStorage?.mode === 'string' ? objectStorage.mode : undefined
  return {
    ...(typeof setup.mode === 'string' ? { mode: setup.mode } : {}),
    ...(typeof data.writesEnabled === 'boolean' ? { writesEnabled: data.writesEnabled } : {}),
    ...(typeof persistence?.ready === 'boolean' ? { persistenceReady: persistence.ready } : {}),
    paymentReady: paymentMode === 'provider' && paymentConfigured,
    ...(paymentMode ? { paymentMode } : {}),
    modelRelayReady: setup.mode === 'production' && ai?.costGate === 'ready' && modelRows.length === 5 && modelRows.every(row => row.ready === true),
    objectStorageReady: objectStorage?.configured === true && objectStorageMode !== 'local',
    ...(objectStorageMode ? { objectStorageMode } : {}),
    scannerReady: scanner?.ready === true && scanner?.mode !== 'fixture' && scanner?.mode !== 'local',
    alertReady: alerts?.ready === true,
    ...(typeof setup.productionGate === 'boolean' ? { productionGate: setup.productionGate } : {}),
  }
}

export function commercialRuntimeAudit(payload: unknown): CommercialRuntimeAudit | undefined {
  const root = objectRecord(payload)
  const data = objectRecord(root?.data)
  const setup = objectRecord(data?.setup)
  if (!data || !setup) return undefined
  const payment = objectRecord(setup.payment)
  const platforms = objectRecord(setup.platforms)
  const ai = objectRecord(setup.ai)
  const modelReadiness = objectRecord(setup.modelReadiness)

  const missingOAuthPlatforms = REQUIRED_PLATFORM_KEYS.filter(platform => objectRecord(platforms?.[platform])?.oauthConfigured !== true)
  const blockedPlatforms = REQUIRED_PLATFORM_KEYS.filter(platform => objectRecord(platforms?.[platform])?.ready !== true)

  const blockedModalities: string[] = []
  const missingProviderConfigured: string[] = []
  const relayReasons: string[] = []
  for (const modality of REQUIRED_RELAY_MODALITIES) {
    const row = objectRecord(modelReadiness?.[modality])
    if (row?.ready !== true) {
      blockedModalities.push(modality)
      const reasons = stringArray(row?.reasons)
      relayReasons.push(...(reasons.length ? reasons.map(reason => `${modality}:${reason}`) : [`${modality}:blocked`]))
    }
    if (row?.providerConfigured !== true) missingProviderConfigured.push(modality)
  }
  const costGateReady = ai?.costGate === 'ready'
  if (!costGateReady) relayReasons.push('cost_gate_blocked')

  const paymentMode = typeof payment?.mode === 'string' ? payment.mode : undefined
  return {
    ...(typeof setup.mode === 'string' ? { mode: setup.mode } : {}),
    ...(typeof data.writesEnabled === 'boolean' ? { writesEnabled: data.writesEnabled } : {}),
    payment: {
      ready: paymentMode === 'provider' && payment?.configured === true,
      ...(paymentMode ? { mode: paymentMode } : {}),
      reasons: stringArray(payment?.reasons),
    },
    platforms: {
      ready: missingOAuthPlatforms.length === 0 && blockedPlatforms.length === 0,
      missingOAuthPlatforms,
      blockedPlatforms,
    },
    relay: {
      ready: costGateReady && blockedModalities.length === 0 && missingProviderConfigured.length === 0,
      costGateReady,
      blockedModalities,
      missingProviderConfigured,
      reasons: relayReasons,
    },
    ...(typeof setup.productionGate === 'boolean' ? { productionGate: setup.productionGate } : {}),
  }
}

export function modelRelayEvidenceAudit(payload: unknown): ModelRelayEvidenceAudit | undefined {
  const root = objectRecord(payload)
  if (!root) return undefined
  const rows = objectArray(root.results)
  const byModality = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const modality = typeof row.modality === 'string' ? row.modality : undefined
    if (modality) byModality.set(modality, row)
  }

  const blockedModalities: string[] = []
  const http503Modalities: string[] = []
  const missingProviderRequestId: string[] = []
  const missingUsageEvidence: string[] = []
  const missingCostEvidence: string[] = []
  const reasons: string[] = []

  for (const modality of REQUIRED_RELAY_MODALITIES) {
    const row = byModality.get(modality)
    if (!row) {
      blockedModalities.push(modality)
      reasons.push(`${modality}:result_missing`)
      continue
    }
    const state = typeof row.state === 'string' ? row.state : undefined
    const detail = typeof row.detail === 'string' ? row.detail : ''
    const httpStatus = typeof row.httpStatus === 'number' ? row.httpStatus : undefined
    if (state !== 'ready') {
      blockedModalities.push(modality)
      reasons.push(`${modality}:state_${state ?? 'unknown'}`)
    }
    if (httpStatus === 503 || /HTTP 503/iu.test(detail)) http503Modalities.push(modality)
    if (typeof row.providerRequestId !== 'string' || row.providerRequestId.trim().length === 0) missingProviderRequestId.push(modality)
    if (row.usageObserved !== true) missingUsageEvidence.push(modality)
    if (row.costObserved !== true || typeof row.costCny !== 'number' || !Number.isFinite(row.costCny)) missingCostEvidence.push(modality)
    if (detail === 'provider_request_id_missing') missingProviderRequestId.push(modality)
    if (detail === 'usage_evidence_missing') missingUsageEvidence.push(modality)
    if (detail === 'cost_evidence_missing') missingCostEvidence.push(modality)
  }

  const dedupe = (values: string[]) => [...new Set(values)]
  const providerMissing = dedupe(missingProviderRequestId)
  const usageMissing = dedupe(missingUsageEvidence)
  const costMissing = dedupe(missingCostEvidence)
  const blocked = dedupe(blockedModalities)
  const http503 = dedupe(http503Modalities)
  if (http503.length) reasons.push(...http503.map(modality => `${modality}:relay_http_503`))
  if (providerMissing.length) reasons.push(...providerMissing.map(modality => `${modality}:provider_request_id_missing`))
  if (usageMissing.length) reasons.push(...usageMissing.map(modality => `${modality}:usage_evidence_missing`))
  if (costMissing.length) reasons.push(...costMissing.map(modality => `${modality}:cost_evidence_missing`))

  return {
    ready: blocked.length === 0 && providerMissing.length === 0 && usageMissing.length === 0 && costMissing.length === 0,
    blockedModalities: blocked,
    http503Modalities: http503,
    missingProviderRequestId: providerMissing,
    missingUsageEvidence: usageMissing,
    missingCostEvidence: costMissing,
    reasons,
  }
}

export function codexAppHostEvidenceAudit(payload: unknown): CodexAppHostEvidenceAudit | undefined {
  const root = objectRecord(payload)
  if (!root) return undefined
  const scenarios = objectArray(root.scenarios)
  const errorRecovery = scenarios.find(scenario => scenario.id === 'error_recovery')
  const reasons: string[] = []
  if (!errorRecovery) reasons.push('error_recovery_missing')
  else {
    const evidence = objectRecord(errorRecovery.error_recovery)
    if (!evidence) reasons.push('error_recovery_evidence_missing')
    else {
      if (evidence.trigger_http_status !== 503) reasons.push('error_recovery_http_503_missing')
      if (evidence.trigger_error_code !== 'MODEL_PROVIDER_OUTCOME_UNKNOWN') reasons.push('error_recovery_code_invalid')
      if (evidence.reconciliation_required !== true) reasons.push('error_recovery_reconciliation_required_missing')
      if (typeof evidence.outcome_evidence_ref !== 'string' || evidence.outcome_evidence_ref.trim().length === 0) reasons.push('error_recovery_outcome_evidence_missing')
    }
  }
  return { ready: reasons.length === 0, reasons }
}
