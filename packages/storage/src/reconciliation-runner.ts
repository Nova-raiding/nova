import { reconcileObjectInventory, type DurableObjectReference, type ObjectInventoryEntry, type ReconciliationErrorEvidence, type ReconciliationReport } from './reconciliation.js'

export interface ObjectInventoryProvider {
  list(workspaceId: string): Promise<readonly ObjectInventoryEntry[]>
}

export interface DurableReferenceProvider {
  list(workspaceId: string): Promise<readonly DurableObjectReference[]>
}

export interface ReconciliationQuotaProvider {
  get(workspaceId: string): Promise<{ limitBytes: number; reservedBytes: number }>
}

export interface ReconciliationStatusStore {
  put(report: ReconciliationReport): Promise<void>
  get(workspaceId: string): Promise<ReconciliationReport | undefined>
  list(workspaceId: string): Promise<readonly ReconciliationReport[]>
}

export class MemoryReconciliationStatusStore implements ReconciliationStatusStore {
  private readonly reports = new Map<string, ReconciliationReport>()

  async put(report: ReconciliationReport) { this.reports.set(report.workspaceId, structuredClone(report)) }
  async get(workspaceId: string) { const report = this.reports.get(workspaceId); return report ? structuredClone(report) : undefined }
  async list(workspaceId: string) {
    if (!workspaceId.trim()) throw new Error('RECONCILIATION_WORKSPACE_REQUIRED')
    return [...this.reports.values()].filter(report => report.workspaceId === workspaceId).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)).map(report => structuredClone(report))
  }
}

export interface ReconciliationCycleInput {
  workspaces: readonly string[]
  inventory: ObjectInventoryProvider
  references: DurableReferenceProvider
  quota?: ReconciliationQuotaProvider
  status: ReconciliationStatusStore
  onError?: (workspaceId: string, error: unknown) => void
}

export interface ReconciliationCycleResult {
  completed: number
  failed: number
  reports: ReconciliationReport[]
}

function validateWorkspaces(workspaces: readonly string[]): void {
  const seen = new Set<string>()
  for (const workspaceId of workspaces) {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('RECONCILIATION_WORKSPACE_REQUIRED')
    if (seen.has(workspaceId)) throw new Error('RECONCILIATION_WORKSPACE_DUPLICATE')
    seen.add(workspaceId)
  }
}

function safeReconciliationErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'reconciliation provider failed'
  let message = error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ')
  // Provider errors are persisted for retry/manual review. Keep the useful
  // failure class while removing credentials and opaque request material.
  message = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|api[_-]?key|token|secret|signature|password|authorization|code)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|client[_-]?secret|clientSecret|private[_-]?key|privateKey|authorizationCode|codeVerifier|password|authorization)\s*[:=]\s*[^,;\s}]+/giu, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s]+/giu, value => value.replace(/([?&]).*$/u, '$1[REDACTED]'))
  return message.trim().slice(0, 1_000) || 'reconciliation provider failed'
}

function reconciliationErrorEvidence(error: unknown): ReconciliationErrorEvidence {
  const message = safeReconciliationErrorMessage(error)
  const retryable = error instanceof Error && /(?:temporarily|timeout|unavailable|rate limit|too many requests|network)/iu.test(message)
  return {
    code: 'RECONCILIATION_PROVIDER_FAILED',
    message,
    retryable,
    nextActions: retryable ? ['retry'] : ['manual_review'],
  }
}

export async function runReconciliationCycle(input: ReconciliationCycleInput): Promise<ReconciliationCycleResult> {
  validateWorkspaces(input.workspaces)
  const reports: ReconciliationReport[] = []
  let failed = 0
  for (const workspaceId of input.workspaces) {
    try {
      const [inventory, references, quota] = await Promise.all([
        input.inventory.list(workspaceId),
        input.references.list(workspaceId),
        input.quota?.get(workspaceId),
      ])
      const report = { ...reconcileObjectInventory({ workspaceId, inventory, references, quota }), runStatus: 'succeeded' as const, lastRunAt: new Date().toISOString() }
      await input.status.put(report)
      reports.push(report)
    } catch (error) {
      failed += 1
      const failure = {
        workspaceId,
        status: 'attention_required' as const,
        runStatus: 'failed' as const,
        lastRunAt: new Date().toISOString(),
        quota: { reservedBytes: 0, usedBytes: 0, projectedBytes: 0 },
        counts: { references: 0, inventoryObjects: 0, matched: 0, missing: 0, metadataMismatches: 0, orphans: 0, crossWorkspace: 0, duplicates: 0, invalidMetadata: 0 },
        findings: [],
        error: reconciliationErrorEvidence(error),
      }
      await input.status.put(failure)
      input.onError?.(workspaceId, error)
    }
  }
  return { completed: reports.length, failed, reports }
}

export function startReconciliationScheduler(input: ReconciliationCycleInput & { intervalMs: number; setTimer?: typeof setInterval; clearTimer?: typeof clearInterval }) {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000) throw new Error('STORAGE_RECONCILIATION_INTERVAL_INVALID')
  const setTimer = input.setTimer ?? setInterval
  const clearTimer = input.clearTimer ?? clearInterval
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await runReconciliationCycle(input) } finally { running = false }
  }
  const timer = setTimer(() => { void tick() }, input.intervalMs)
  return { runNow: tick, stop: () => clearTimer(timer) }
}
