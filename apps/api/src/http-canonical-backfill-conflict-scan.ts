import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { BrandUnitRepository, OperationAudit } from '../../../packages/persistence/src/index.js'
import type { CanonicalBackfillRunRepository } from '../../../packages/persistence/src/canonical-backfill-run-repository.js'
import type { CanonicalBackfillConflictRepository } from '../../../packages/persistence/src/canonical-backfill-conflict-repository.js'
import type { canonicalConsistencyApiReport, canonicalConflictScanItems } from './server.js'

type Dependencies = {
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>
  resolveWorkspace: (req: IncomingMessage, candidate?: unknown) => string
  requireOperationsRole: (req: IncomingMessage, roles: readonly string[]) => string
  required: (input: Record<string, unknown>, key: string) => string
  canonicalBackfillRuns: () => CanonicalBackfillRunRepository | undefined
  canonicalBackfillConflicts: () => CanonicalBackfillConflictRepository | undefined
  brandUnits: () => BrandUnitRepository
  storageMode: () => 'postgres' | 'memory'
  canonicalConsistencyApiReport: typeof canonicalConsistencyApiReport
  canonicalConflictScanItems: typeof canonicalConflictScanItems
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  requestActor: (req: IncomingMessage) => string
}

export async function scanCanonicalBackfillConflicts(req: IncomingMessage, dependencies: Dependencies): Promise<{ workspaceId: string; data: unknown }> {
  const { body, resolveWorkspace, requireOperationsRole, required, canonicalConsistencyApiReport,
    canonicalConflictScanItems, recordOperationAudit, requestActor } = dependencies
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    requireOperationsRole(req, ['platform_ops'])
    const auditBatchId = required(input, 'audit_batch_id')
    const reason = required(input, 'reason')
    const run = await dependencies.canonicalBackfillRuns()?.get({ workspaceId, id: auditBatchId })
    if (!run) throw new DomainError('CANONICAL_BACKFILL_RUN_NOT_FOUND', 'canonical conflict scan 审计批次不存在或不属于当前工作区', 404, { audit_batch_id: auditBatchId })
    const conflictRepository = dependencies.canonicalBackfillConflicts()
    if (!conflictRepository) throw new DomainError('CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE', 'canonical backfill 冲突队列未配置', 503)
    const repository = dependencies.brandUnits()
    const rows = await repository.listCanonicalChainConsistencyRows({ workspaceId })
    const report = canonicalConsistencyApiReport({ workspaceId, ...rows }, dependencies.storageMode())
    // The legacy conflict queue intentionally has a narrower vocabulary than
    // the full consistency report.  Only enqueue migration/backfill conflicts
    // whose evidence can be represented losslessly; relationship findings
    // remain in the read-only consistency report.
    const scanItems = canonicalConflictScanItems(report)
      .map(item => item.code === 'BRAND_SCOPE_MISMATCH' ? { ...item, code: 'CANONICAL_BRAND_MISMATCH' as const } : item)
      .filter((item): item is typeof item & { code: 'MISSING_BRAND' | 'CANONICAL_MAPPING_AMBIGUOUS' | 'CANONICAL_BRAND_MISMATCH' | 'CANONICAL_LEGACY_PRODUCT_MISSING' | 'CANONICAL_ID_COLLISION' | 'TASK_ACCOUNT_MISMATCH' } => ['MISSING_BRAND', 'CANONICAL_MAPPING_AMBIGUOUS', 'CANONICAL_BRAND_MISMATCH', 'CANONICAL_LEGACY_PRODUCT_MISSING', 'CANONICAL_ID_COLLISION', 'TASK_ACCOUNT_MISMATCH'].includes(item.code))
    const queued = await conflictRepository.enqueue({ workspaceId, runId: auditBatchId, conflicts: scanItems })
    await recordOperationAudit({ workspaceId, actorId: requestActor(req), action: 'canonical.backfill.conflicts.scan', resourceType: 'canonical_backfill_run', resourceId: auditBatchId, before: { audit_batch_id: auditBatchId, revision: run.revision }, after: { audit_batch_id: auditBatchId, revision: run.revision, consistency_revision: report.revision, finding_count: scanItems.length, queued_count: queued.length }, reason })
    return { workspaceId, data: { audit_batch_id: auditBatchId, consistency_revision: report.revision, findings_scanned: report.findings.length, conflicts: queued, idempotent_key: `${auditBatchId}:legacy_product_id:code` } }
}
