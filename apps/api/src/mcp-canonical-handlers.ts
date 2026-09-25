import type { IncomingMessage } from 'node:http'
import type { CanonicalProductReadMode } from '../../../packages/application/src/canonical-product-consistency.js'
import type { PlatformFieldMappingGateInput, PlatformFieldMappingGateResult } from '../../../packages/application/src/platform-field-mapping-gate.js'
import type { BrandUnitRepository, UnifiedLinkAuditRepository } from '../../../packages/persistence/src/index.js'
import type { canonicalConsistencyApiReport } from './server.js'

type CanonicalReport = ReturnType<typeof canonicalConsistencyApiReport>

export const MCP_CANONICAL_METHODS = new Set(['canonical.product.consistency', 'platform.mapping.preflight'])

export interface CanonicalMcpDependencies {
  brandUnits: BrandUnitRepository
  unifiedLinkAudit?: UnifiedLinkAuditRepository
  storageMode: 'memory' | 'postgres'
  canonicalConsistencyApiReport: typeof canonicalConsistencyApiReport
  canonicalProductReadControl: (workspaceId: string) => Promise<{ mode: CanonicalProductReadMode; source: 'feature_flag' | 'default'; reason?: string; revision?: number }>
  persistCanonicalLinkAudit: (report: CanonicalReport) => Promise<{ persisted: boolean; count: number }>
  parseJsonObjectParameter: (params: Record<string, unknown>, key: string) => Record<string, unknown>
  evaluatePlatformMappingForWorkspace: (req: IncomingMessage, workspaceId: string, input: PlatformFieldMappingGateInput) => Promise<PlatformFieldMappingGateResult>
  enforceMcpCommercialAccess: (req: IncomingMessage, workspaceId: string, operation: string) => Promise<unknown>
}

export async function handleCanonicalMcpMethod(
  method: string,
  params: Record<string, unknown>,
  workspaceId: string,
  req: IncomingMessage,
  dependencies: CanonicalMcpDependencies,
): Promise<unknown> {
  if (method === 'canonical.product.consistency') {
    const rows = await dependencies.brandUnits.listCanonicalChainConsistencyRows({ workspaceId })
    const report = dependencies.canonicalConsistencyApiReport({ workspaceId, ...rows }, dependencies.storageMode)
    const readControl = await dependencies.canonicalProductReadControl(workspaceId)
    const audit = await dependencies.persistCanonicalLinkAudit(report)
    const auditRecords = dependencies.unifiedLinkAudit ? await dependencies.unifiedLinkAudit.list({ workspaceId, limit: 100 }) : []
    return { ...report, readOnly: true, cutover: 'unchanged', read_control: readControl, unified_link_audit: { ...audit, items: auditRecords }, source: dependencies.storageMode, durable: dependencies.storageMode === 'postgres' }
  }
  if (method === 'platform.mapping.preflight') {
    const input = dependencies.parseJsonObjectParameter(params, 'input_json') as unknown as PlatformFieldMappingGateInput
    const evaluated = await dependencies.evaluatePlatformMappingForWorkspace(req, workspaceId, input)
    await dependencies.enforceMcpCommercialAccess(req, workspaceId, method)
    return evaluated
  }
  throw new Error(`Unknown canonical MCP method: ${method}`)
}
