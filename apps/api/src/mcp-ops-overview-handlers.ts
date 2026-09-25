import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { BrandUnitRepository, OperationAudit } from '../../../packages/persistence/src/index.js'
import { mapWithConcurrency } from './bounded-concurrency.js'
import type { ApiPersistence, workspaceStoreDirectory } from './server.js'

export const MCP_OPS_OVERVIEW_METHODS = new Set([
  'ops.workspaces.list', 'ops.stores.list', 'ops.platform.store.record.create',
  'ops.brand-units.summary', 'ops.tasks.summary',
])

type StoreDirectory = typeof workspaceStoreDirectory
export interface OpsOverviewDependencies {
  persistence: () => ApiPersistence
  brandUnits: () => BrandUnitRepository
  service: MerchantService
  knownWorkspaces: () => string[]
  principalWorkspaces: (req: IncomingMessage) => string[]
  requiresStrictAuth: () => boolean
  isPlatformOperations: (req: IncomingMessage) => boolean
  requireOperationsRole: (req: IncomingMessage, allowed: readonly string[]) => string
  requirePlatformReadRole: (req: IncomingMessage) => string
  required: (params: Record<string, unknown>, key: string) => string
  header: (req: IncomingMessage, name: string) => string | undefined
  workspaceStoreDirectory: StoreDirectory
  platformLabels: Record<Platform, string>
  supportedPlatforms: readonly Platform[]
  loadPlatformWorkspaceEnterpriseNames: (workspaceIds: readonly string[]) => Promise<Map<string, string>>
  workspaceSummary: (workspaceId: string, enterpriseName: string) => Promise<{ workspaceId: string; enterpriseName: string; status: 'active' | 'disabled'; planName: string; monthlyPriceCny: number; usedTasks: number; includedTasks: number; subscriptionStatus: string; memberCount: number }>
  activeMerchantWorkspaceIds: () => Promise<ReadonlySet<string>>
  persistSnapshot: (workspaceId: string, entityType: 'platform_account', entity: { id: string; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  manualPlatformOperations: () => boolean
  hydrateWorkspace: (workspaceId: string) => Promise<unknown>
}

export async function handleOpsOverviewMcpMethod(method: string, params: Record<string, unknown>, workspaceId: string, req: IncomingMessage, dependencies: OpsOverviewDependencies): Promise<unknown> {
  const {
    service, knownWorkspaces, principalWorkspaces, requiresStrictAuth, isPlatformOperations,
    requireOperationsRole, requirePlatformReadRole, required, header, workspaceStoreDirectory,
    platformLabels: PLATFORM_LABELS, supportedPlatforms: SUPPORTED_PLATFORMS,
    loadPlatformWorkspaceEnterpriseNames, workspaceSummary, activeMerchantWorkspaceIds,
    persistSnapshot, persistEvent, recordOperationAudit, manualPlatformOperations,
    hydrateWorkspace,
  } = dependencies
  const persistence = dependencies.persistence()
  switch (method) {
    case 'ops.workspaces.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops', 'platform_admin', 'ops_admin', 'support_agent', 'finance_ops', 'auditor', 'rules_admin', 'model_admin', 'release_admin'])
      const hasDirectoryParams = ['query', 'status', 'subscription_status', 'merchant_only', 'offset', 'limit'].some(key => Object.prototype.hasOwnProperty.call(params, key))
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      if (query.length > 200) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'query 最多 200 个字符', 400)
      const status = typeof params.status === 'string' && params.status.trim() ? params.status.trim() : undefined
      if (status && status !== 'active' && status !== 'disabled') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 active 或 disabled', 400)
      const subscriptionStatus = typeof params.subscription_status === 'string' && params.subscription_status.trim() ? params.subscription_status.trim() : undefined
      if (subscriptionStatus && subscriptionStatus.length > 64) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'subscription_status 最多 64 个字符', 400)
      const merchantOnly = params.merchant_only === true || params.merchant_only === 'true'
      const requestedLimit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 20
      const offset = typeof params.offset === 'string' && /^\d+$/u.test(params.offset) ? Number(params.offset) : 0
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 100 的整数', 400)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'offset 必须是 0 到 1000000 的整数', 400)
      if (isPlatformOperations(req) && hasDirectoryParams && persistence.listWorkspaceDirectory) return (await persistence.listWorkspaceDirectory({ query: query || undefined, status: status as 'active' | 'disabled' | undefined, subscriptionStatus, merchantOnly, offset, limit: requestedLimit }))
      // Reached only when a caller sends none of query/status/subscription_status/
      // merchant_only/offset/limit; the Ops console always sends offset+limit and
      // therefore takes the paged branch below. This branch is the one remaining
      // unfiltered summary read: it returns a bare array, so capping it here would
      // turn an honest list into a silently truncated one. The paged branch — and
      // the array branch with it — is dominated by the `security_barrier` view's
      // full materialization anyway, so the bound belongs in the view/projection
      // rather than in a server-side LIMIT.
      if (isPlatformOperations(req) && persistence.listWorkspaceSummaries && !hasDirectoryParams) return (await persistence.listWorkspaceSummaries())
      const principal = { workspaces: principalWorkspaces(req) }
      const granted = requiresStrictAuth() ? principal.workspaces : knownWorkspaces()
      const platformWorkspaceIds = isPlatformOperations(req) && persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : []
      const platformScopeIds = isPlatformOperations(req) ? [...new Set([...platformWorkspaceIds, ...knownWorkspaces()])] : []
      const workspaceIds = platformScopeIds.length ? platformScopeIds : granted.length ? [...new Set(granted)] : [workspaceId]
      // Each summary performs five repository reads. Keep only two summaries in
      // flight so a platform-wide directory cannot exhaust the shared SQL pool
      // while the rest of the Ops page is loading.
      const enterpriseNames = await loadPlatformWorkspaceEnterpriseNames(workspaceIds)
      const summaries = await mapWithConcurrency(workspaceIds, 16, id => workspaceSummary(id, enterpriseNames.get(id) ?? '未命名企业主体'))
      if (!hasDirectoryParams) return (summaries)
      const merchantWorkspaceIds = merchantOnly
        ? await activeMerchantWorkspaceIds()
        : undefined
      const filtered = summaries.filter(item => (!merchantOnly || merchantWorkspaceIds?.has(item.workspaceId)) && (!query || [item.workspaceId, item.planName].some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) && (!status || item.status === status) && (!subscriptionStatus || item.subscriptionStatus === subscriptionStatus))
      return ({ items: filtered.slice(offset, offset + requestedLimit), total: filtered.length, offset, limit: requestedLimit, hasMore: offset + requestedLimit < filtered.length })
    }
    case 'ops.stores.list': {
      requirePlatformReadRole(req)
      if (params.platform_scope !== 'platform') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台店铺目录必须显式声明 platform_scope=platform', 400)
      const workspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : knownWorkspaces()
      const stores = workspaceIds.flatMap(targetWorkspaceId => workspaceStoreDirectory(targetWorkspaceId).map(store => ({ ...store })))
      const groups = new Map<string, { platform: Platform; state: string; dataMode: string; readable: boolean; writeEnabled: boolean; count: number }>()
      for (const store of stores) {
        const key = [store.platform, store.state, store.dataMode, store.readable, store.writeEnabled].join(':')
        const current = groups.get(key)
        if (current) current.count += 1
        else groups.set(key, { platform: store.platform, state: store.state, dataMode: store.dataMode, readable: store.readable, writeEnabled: store.writeEnabled, count: 1 })
      }
      const items = [...groups.values()].map(group => ({ platform: group.platform, accountId: `platform-aggregate:${group.platform}:${group.state}:${group.dataMode}`, label: `${group.count} 个${PLATFORM_LABELS[group.platform]}店铺`, state: group.state, dataMode: group.dataMode, readable: group.readable, writeEnabled: group.writeEnabled, revision: 0, aggregate: true }))
      return ({ items, total: items.length, aggregate: true })
    }
    case 'ops.platform.store.record.create': {
      // Platform operations only. This is an authority check, not a parameter
      // check: a merchant principal must be refused for *who it is*, never
      // because it happened to omit a field. `requireOperationsRole` is the
      // guard the rest of the platform-scope writes use; it canonicalizes the
      // gateway aliases (`ops_admin`, `platform_admin`) onto `platform_ops` and
      // deliberately refuses a raw `platform_ops` *membership* role, so a
      // merchant workspace member cannot clear it by holding a same-named role.
      //
      // Independently of this call, the method's registry policy pins it to the
      // platform workbench and the platform scope, so a workspace-workbench
      // caller is denied by the authorization decision before the handler runs,
      // and the `ops.` prefix keeps it out of every merchant tools/list. This
      // guard is the layer that still holds in local (non-strict) mode.
      const actorId = requireOperationsRole(req, ['platform_ops'])
      const targetWorkspaceId = required(params, 'workspace_id')
      const platform = required(params, 'platform') as Platform
      if (!SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
      const accountId = required(params, 'account_id')
      const reason = required(params, 'reason')
      // The target workspace is caller-supplied scope. Make the two ways of
      // declaring it agree instead of silently preferring the header.
      const headerWorkspace = header(req, 'x-workspace-id')?.trim()
      if (headerWorkspace && headerWorkspace !== targetWorkspaceId) throw new DomainError(ERROR_CODES.WORKSPACE_SCOPE_MISMATCH, '人工店铺记录的工作区范围声明不一致', 403)
      if (persistence.listWorkspaceIds) {
        const workspaceIds = await persistence.listWorkspaceIds()
        if (!workspaceIds.includes(targetWorkspaceId)) throw new DomainError('WORKSPACE_NOT_FOUND', '目标商家工作区不存在', 404, { workspace_id: targetWorkspaceId })
      }
      const storeAlias = typeof params.store_alias === 'string' && params.store_alias.trim() ? params.store_alias : undefined
      const account = service.registerManualPlatformAccount({ workspaceId: targetWorkspaceId, platform, remoteAccountId: accountId, ...(storeAlias ? { storeAlias } : {}) })
      await persistSnapshot(targetWorkspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
      await persistEvent(targetWorkspaceId, account.id, 'platform_account.manual_record_created', account.revision, { platform, account_id: account.id, token_state: account.tokenState, credential_free: true, reason })
      // The operator's stated reason is what a `platform_authorization_audit`
      // row cannot hold: that row records the authorization *decision* (written
      // automatically because this method's policy audits allow_and_deny),
      // while `reason` obliges the operator to state a business justification.
      // Persisting it here keeps the justification queryable next to the
      // decision through `ops.audit.*` and the audit center.
      await recordOperationAudit({ workspaceId: targetWorkspaceId, actorId, action: 'platform.store.record.create', resourceType: 'platform_account', resourceId: account.id, before: {}, after: { platform, account_id: account.id, remote_account_id: account.remoteAccountId, token_state: account.tokenState, store_alias: account.storeAlias ?? null, credential_free: true }, reason })
      const store = workspaceStoreDirectory(targetWorkspaceId, platform).find(item => item.accountId === account.id)
      return ({
        workspace_id: targetWorkspaceId,
        store,
        selectionKey: { platform, accountId: account.id },
        // Never report a connection. The record has no credential, no scope and
        // no platform receipt; `applies_to_store_boundary` tells the operator
        // whether this deployment currently lets it stand in for a store scope,
        // which is true only in manual operations mode.
        connection: { mode: 'manual_store_record', token_state: account.tokenState, credential_free: true, authorization_receipt: null },
        applies_to_store_boundary: manualPlatformOperations(),
      })
    }
    case 'ops.brand-units.summary': {
      requirePlatformReadRole(req)
      if (params.platform_scope !== 'platform') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台品牌汇总必须显式声明 platform_scope=platform', 400)
      const repository = dependencies.brandUnits()
      const summaries = await repository.listPlatformSummary()
      return ({ scope: 'platform', workspaceCount: persistence.listWorkspaceIds ? (await persistence.listWorkspaceIds()).length : summaries.length, brandCount: summaries.reduce((sum, row) => sum + row.brandCount, 0), boundStoreCount: summaries.reduce((sum, row) => sum + row.boundStoreCount, 0), unboundBrandCount: summaries.reduce((sum, row) => sum + row.unboundBrandCount, 0), canonicalProductCount: summaries.reduce((sum, row) => sum + row.canonicalProductCount, 0), listingCount: summaries.reduce((sum, row) => sum + row.listingCount, 0) })
    }
    case 'ops.tasks.summary': {
      requirePlatformReadRole(req)
      if (params.platform_scope !== 'platform') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台任务汇总必须显式声明 platform_scope=platform', 400)
      const workspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : knownWorkspaces()
      // Platform reads fan out across all tenants. Keep enough parallelism to
      // remain responsive when the directory contains many small workspaces;
      // each repository call is still bounded by the pool and its own query.
      const summaries = await mapWithConcurrency(workspaceIds, 24, async targetWorkspaceId => {
        try {
          await hydrateWorkspace(targetWorkspaceId)
          const tasks = service.listTasks(targetWorkspaceId)
          const byState = tasks.reduce((counts, task) => { counts[task.state] = (counts[task.state] ?? 0) + 1; return counts }, {} as Record<string, number>)
          const generationQueueCount = [...service.generationJobs.values()].filter(job => job.workspaceId === targetWorkspaceId && ['queued', 'running'].includes(job.state)).length
          const publishQueueCount = service.listPublishJobs(targetWorkspaceId).filter(job => ['queued', 'submitted', 'publishing'].includes(job.state)).length
          return { taskCount: tasks.length, byState, generationQueueCount, publishQueueCount, failed: false }
        } catch {
          return { taskCount: 0, byState: {}, generationQueueCount: 0, publishQueueCount: 0, failed: true }
        }
      })
      const byState = summaries.reduce((counts, summary) => { for (const [state, count] of Object.entries(summary.byState)) counts[state] = (counts[state] ?? 0) + count; return counts }, {} as Record<string, number>)
      return ({ scope: 'platform', workspaceCount: workspaceIds.length, failedWorkspaceCount: summaries.filter(summary => summary.failed).length, taskCount: summaries.reduce((sum, summary) => sum + summary.taskCount, 0), generationQueueCount: summaries.reduce((sum, summary) => sum + summary.generationQueueCount, 0), publishQueueCount: summaries.reduce((sum, summary) => sum + summary.publishQueueCount, 0), byState })
    }
  }
  throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知运营概览方法: ${method}`, 400)
}
