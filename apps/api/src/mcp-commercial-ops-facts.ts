import { randomUUID } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import type { CommercialAccessService } from '../../../packages/application/src/commercial-access-service.js'
import { commercialOpsPageLimit, decodeCommercialContractPageCursor, decodeCreativePointStatementCursor, encodeCommercialContractPageCursor, projectCommercialAccessBlocks, projectCommercialAccessSummary, projectCommercialEntitlement, projectCreativePointLedgerEntry } from './ops/commercial-ops-read-model.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>
type FactRepositories = Pick<ApiPersistence, 'creativePoints' | 'commercialContracts'>

export interface CommercialOpsFactDependencies {
  persistence: FactRepositories
  commercialAccessService: Pick<CommercialAccessService, 'decide'>
  required(params: Params, key: string): string
  commercialOpsReadInput<T>(project: () => T): T
}

/** Returns undefined for methods outside this bounded set. */
export async function handleCommercialOpsFactMethod(method: string, params: Params, deps: CommercialOpsFactDependencies): Promise<Record<string, unknown> | undefined> {
  const { persistence, commercialAccessService, required, commercialOpsReadInput } = deps
  switch (method) {
    case 'ops.commercial.access.summary': {
      const targetWorkspaceId = required(params, 'target_workspace_id')
      if (!persistence.creativePoints) throw new DomainError('CREATIVE_POINT_BALANCE_REPOSITORY_UNAVAILABLE', '创意点余额仓储尚未配置，不能返回未知或零余额假成功', 503)
      const access = await commercialAccessService.decide({ surface: 'MCP', operation: 'merchant.start', workspace_id: targetWorkspaceId })
      const balance = await persistence.creativePoints.getBalance(targetWorkspaceId)
      const decision = access.outcome === 'DECISION' ? access.decision : null
      const fallbackError = access.outcome === 'DENY_DISABLED' ? 'COMMERCIAL_OPERATION_DISABLED' : access.outcome === 'DENY_UNCLASSIFIED' ? 'COMMERCIAL_OPERATION_UNCLASSIFIED' : null
      const summary = projectCommercialAccessSummary({ workspaceId: targetWorkspaceId, decision, balance, decisionOutcome: access.outcome, verifiedAt: new Date().toISOString(), unavailableDecisionId: `commercial_unavailable_${randomUUID()}` })
      return { ...summary, error_code: summary.error_code ?? fallbackError }
    }
    case 'ops.commercial.access-blocks.list': {
      if (!persistence.commercialContracts) throw new DomainError('COMMERCIAL_ACCESS_BLOCK_REPOSITORY_UNAVAILABLE', '商业阻断事实仓储尚未配置，不能返回伪造的空列表', 503)
      const targetWorkspaceId = required(params, 'target_workspace_id')
      const status = params.status === 'resolved' || params.status === 'all' ? params.status : 'open'
      const limit = commercialOpsReadInput(() => commercialOpsPageLimit(params.limit, 100))
      const result = await persistence.commercialContracts.listAccessDecisions(targetWorkspaceId, { blockedOnly: status !== 'resolved', limit, cursor: decodeCommercialContractPageCursor(params.cursor, 'access-blocks') })
      const legacyArray = Array.isArray(result)
      const rows = legacyArray ? result : result.items
      const hasMore = legacyArray ? false : result.hasMore
      const items = projectCommercialAccessBlocks(rows, status)
      const last = rows.at(-1)
      return { schema_version: 'commercial.access-blocks.v2', items, total: items.length, next_cursor: hasMore && last ? encodeCommercialContractPageCursor('access-blocks', last.decidedAt, last.id) : null, truncated: hasMore }
    }
    case 'ops.commercial.entitlements.list': {
      if (!persistence.commercialContracts) throw new DomainError('COMMERCIAL_ENTITLEMENT_V2_REPOSITORY_UNAVAILABLE', 'V2 权益快照仓储尚未配置，不能回退到旧任务额度', 503)
      const targetWorkspaceId = required(params, 'target_workspace_id')
      const limit = commercialOpsReadInput(() => commercialOpsPageLimit(params.limit, 100))
      const page = await persistence.commercialContracts.listEntitlementSnapshots(targetWorkspaceId, { limit, cursor: decodeCommercialContractPageCursor(params.cursor, 'entitlements') })
      const items = page.items.map(projectCommercialEntitlement)
      const last = page.items.at(-1)
      return { schema_version: 'commercial.entitlements.v2', items, total: items.length, next_cursor: page.hasMore && last ? encodeCommercialContractPageCursor('entitlements', last.createdAt, last.id) : null, truncated: page.hasMore }
    }
    case 'ops.commercial.points-ledger.list': {
      if (!persistence.creativePoints) throw new DomainError('CREATIVE_POINT_STATEMENT_REPOSITORY_UNAVAILABLE', '创意点流水读取仓储尚未配置', 503)
      const targetWorkspaceId = required(params, 'target_workspace_id')
      const statementInput = commercialOpsReadInput(() => ({ limit: commercialOpsPageLimit(params.limit), cursor: decodeCreativePointStatementCursor(params.cursor) }))
      const statement = await persistence.creativePoints.listStatement(targetWorkspaceId, statementInput)
      const items = statement.items.map(projectCreativePointLedgerEntry)
      return { schema_version: 'creative-points.statement.v1', items, total: items.length, next_cursor: statement.nextCursor ? Buffer.from(JSON.stringify(statement.nextCursor)).toString('base64url') : null }
    }
    default:
      return undefined
  }
}
