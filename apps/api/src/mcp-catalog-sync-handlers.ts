import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type PlatformAccount, type Product, type SyncJob } from '../../../packages/application/src/service.js'
import type { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'

type Dependencies = {
  service: MerchantService
  connectorRuntime: ConnectorRuntime
  required: (params: Record<string, unknown>, key: string) => string
  platformConnectorConfigured: (platform: Platform) => boolean
  header: (req: IncomingMessage, name: string) => string | undefined
  isProduction: () => boolean
  fixtureMode: boolean
  defaultFixtureAccountId: (workspaceId: string, platform: Platform) => string
  requireActivePlatformAccount: (workspaceId: string, accountId: string, platform: Platform) => PlatformAccount
  ensureFixtureAccount: (workspaceId: string, platform: Platform, accountId: string) => Promise<unknown>
  requestId: (req: IncomingMessage) => string
  invalidateCanonicalFactsAfterSync: (workspaceId: string, products: readonly Product[]) => Promise<unknown>
  persistSnapshot: (workspaceId: string, entityType: 'product', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
  scanAutomationAfterOperationalCompletion: (workspaceId: string, platform: Platform, accountId: string, trigger: string) => Promise<object>
  requestCatalogSync: (workspaceId: string, req: IncomingMessage, params: Record<string, unknown>) => Promise<unknown>
  projectSyncWorkflow: (workspaceId: string, job: SyncJob) => unknown
}

export const MCP_CATALOG_SYNC_METHODS = new Set(['catalog.sync', 'catalog.sync.start', 'catalog.sync.get'])

export async function handleMcpCatalogSyncMethod(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, dependencies: Dependencies): Promise<unknown> {
  const { service, connectorRuntime, required, platformConnectorConfigured, header, isProduction,
    fixtureMode, defaultFixtureAccountId, requireActivePlatformAccount, ensureFixtureAccount,
    requestId, invalidateCanonicalFactsAfterSync, persistSnapshot,
    scanAutomationAfterOperationalCompletion, requestCatalogSync, projectSyncWorkflow } = dependencies
  if (method === 'catalog.sync') {
      const platform = required(params, 'platform') as Platform
      if (!platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
      const accountId = (typeof params.account_id === 'string' && params.account_id.trim()) || header(req, 'x-account-id')?.trim() || (isProduction() ? '' : defaultFixtureAccountId(workspaceId, platform))
      if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
      const platformAccount = isProduction() || fixtureMode ? requireActivePlatformAccount(workspaceId, accountId, platform) : undefined
      await ensureFixtureAccount(workspaceId, platform, accountId)
      try {
        const synced = await connectorRuntime.sync(platform, { workspaceId, accountId, ...(platformAccount ? { credentialRef: platformAccount.credentialRef } : {}), traceId: requestId(req) }, typeof params.cursor === 'string' ? params.cursor : undefined)
        const products = service.upsertSyncedProducts({ workspaceId, platform, accountId, items: synced.items })
        await invalidateCanonicalFactsAfterSync(workspaceId, products)
        for (const product of products) await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
        const automation = await scanAutomationAfterOperationalCompletion(workspaceId, platform, accountId, 'catalog.sync.completed')
        return ({ ...synced, products, automation })
      } catch (error) { throw error }
    }
  if (method === 'catalog.sync.start') {
      return (await requestCatalogSync(workspaceId, req, params))
    }
  if (method === 'catalog.sync.get') {
      const job = service.getSyncJob(workspaceId, required(params, 'job_id'))
      return ({ ...job, workflow: projectSyncWorkflow(workspaceId, job) })
    }
  throw new Error(`Unsupported catalog sync MCP method: ${method}`)
}
