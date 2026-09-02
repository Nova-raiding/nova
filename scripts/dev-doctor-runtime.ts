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

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

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
