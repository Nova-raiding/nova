import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import type { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { isManualStoreRecord } from '../../../packages/application/src/service.js'

type Input = Record<string, unknown>
type Send = (status: number, workspaceId: string, data: unknown) => void
type Account = ReturnType<MerchantService['getActivePlatformAccount']>

export interface PlatformAccountRouteDependencies {
  service: MerchantService
  connectorRuntime: ConnectorRuntime
  readBody: () => Promise<Input>
  send: Send
  sendOAuthPage: (input: { state: 'success'; platform: string; storeLabel?: string; syncState: string }) => void
  wantsOAuthHtml: () => boolean
  resolveWorkspace: (input?: unknown) => string
  header: (name: string) => string | undefined
  beginAuthorization: (platform: Platform, input: Input, workspaceId: string) => Promise<unknown>
  ensureOAuthStateReady: () => void
  consumeOAuthState: (state: string, platform: Platform, suppliedWorkspace?: string) => Promise<{ workspaceId: string; platform: string; codeVerifier?: string }> | { workspaceId: string; platform: string; codeVerifier?: string }
  platformConnectorConfigured: (platform: Platform) => boolean
  requireActivePlatformAccount: (workspaceId: string, accountId: string, platform: Platform) => Account
  defaultFixtureAccountId: (workspaceId: string, platform: Platform) => string
  production: boolean
  fixtureMode: boolean
  strictAuth: () => boolean
  requestId: () => string
  invalidateCanonicalFactsAfterSync: (workspaceId: string, products: readonly Product[]) => Promise<void>
  scanImportedProductRules: (workspaceId: string, product: Product) => Promise<unknown>
  persistSnapshot: (workspaceId: string, entityType: 'product' | 'platform_account' | 'sync_job', entity: { id: string; version?: number; revision?: number }) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  scanAutomation: (workspaceId: string, platform: Platform, accountId: string, trigger: string) => Promise<unknown>
  storeDirectory: (workspaceId: string, platform?: Platform) => Array<{ accountId: string; label: string }>
  platformAccountAccessItems: (workspaceId: string) => unknown
  grantedScopes: (scope?: string) => string[] | undefined
}

export async function handlePlatformAccountRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: PlatformAccountRouteDependencies): Promise<boolean> {
  if (req.method === 'GET' && path === '/v1/platform-accounts') {
    const workspaceId = deps.resolveWorkspace()
    deps.send(200, workspaceId, { items: deps.platformAccountAccessItems(workspaceId) })
    return true
  }
  const authorizeMatch = path.match(/^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/authorize$/)
  if (req.method === 'POST' && authorizeMatch) {
    const input = await deps.readBody()
    const platform = authorizeMatch[1] as Platform
    const workspaceId = deps.resolveWorkspace()
    const result = await deps.beginAuthorization(platform, input, workspaceId)
    deps.send(200, workspaceId, result)
    return true
  }
  const syncMatch = path.match(/^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/sync$/)
  if (req.method === 'POST' && syncMatch) {
    const input = await deps.readBody()
    const workspaceId = deps.resolveWorkspace(input.workspace_id)
    const platform = syncMatch[1] as Platform
    if (!deps.platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
    const accountId = deps.header('x-account-id')?.trim() || (typeof input.account_id === 'string' && input.account_id.trim()) || (deps.production ? '' : deps.defaultFixtureAccountId(workspaceId, platform))
    if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
    const platformAccount = deps.production || deps.fixtureMode ? deps.requireActivePlatformAccount(workspaceId, accountId, platform) : undefined
    const result = await deps.connectorRuntime.sync(platform, { workspaceId, accountId, ...(platformAccount ? { credentialRef: platformAccount.credentialRef } : {}), traceId: deps.requestId() }, typeof input.cursor === 'string' ? input.cursor : undefined)
    const products = deps.service.upsertSyncedProducts({ workspaceId, platform, accountId, items: result.items })
    await deps.invalidateCanonicalFactsAfterSync(workspaceId, products)
    for (const product of products) {
      await deps.scanImportedProductRules(workspaceId, product)
      await deps.persistSnapshot(workspaceId, 'product', product)
    }
    const automation = await deps.scanAutomation(workspaceId, platform, accountId, 'platform-account.sync.completed')
    deps.send(200, workspaceId, { ...result, products, automation })
    return true
  }
  const revokeMatch = path.match(/^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)$/)
  if (req.method === 'DELETE' && revokeMatch) {
    const workspaceId = deps.resolveWorkspace()
    const platform = revokeMatch[1] as Platform
    const accountId = deps.header('x-account-id')?.trim() || new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('account_id')?.trim()
    if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '撤销授权必须指定平台账号', 400)
    const manualRecord = isManualStoreRecord(deps.service.getPlatformAccount(workspaceId, accountId, platform))
    const account = deps.service.revokePlatformAccount(workspaceId, accountId, platform)
    await deps.persistSnapshot(workspaceId, 'platform_account', account)
    await deps.persistEvent(workspaceId, account.id, 'platform_account.revoked', account.revision, { account_id: account.id, platform, remote_revoked: false, ...(manualRecord ? { credential_free: true } : {}) })
    if (manualRecord) {
      deps.send(200, workspaceId, { platform, accountId: account.id, state: account.tokenState, remoteRevoked: false, remoteRevocation: 'not_applicable_manual_store_record' })
      return true
    }
    try { await deps.connectorRuntime.connector(platform).revoke({ accountId: account.remoteAccountId, credentialRef: account.credentialRef }) }
    catch (error) { throw new DomainError('PLATFORM_REVOKE_REMOTE_FAILED', error instanceof Error ? error.message : '平台远端凭证撤销失败，本地账号已停止使用', 503) }
    deps.send(200, workspaceId, { platform, accountId: account.id, state: account.tokenState, remoteRevoked: true })
    return true
  }
  const callbackMatch = path.match(/^\/v1\/oauth\/callback\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)$/)
  if (req.method === 'GET' && callbackMatch) {
    deps.ensureOAuthStateReady()
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (!code) throw new DomainError(ERROR_CODES.OAUTH_CODE_REQUIRED, 'OAuth callback code is required', 400)
    const suppliedWorkspace = deps.header('x-workspace-id')?.trim()
    const callback = await deps.consumeOAuthState(state, callbackMatch[1] as Platform, suppliedWorkspace)
    const credential = await deps.connectorRuntime.connector(callbackMatch[1] as Platform).exchangeCode({ code, state, workspaceId: callback.workspaceId, ...(callback.codeVerifier ? { codeVerifier: callback.codeVerifier } : {}) })
    const account = deps.service.registerPlatformAccount({ workspaceId: callback.workspaceId, platform: callback.platform as Platform, remoteAccountId: credential.accountId, credentialRef: credential.credentialRef, grantedScopes: deps.grantedScopes(credential.scope), accessTokenExpiresAt: credential.expiresAt, credentialRefreshable: credential.refreshable })
    await deps.persistSnapshot(callback.workspaceId, 'platform_account', account)
    let initialSync: Record<string, unknown> = { state: 'not_started', reason: 'connector_not_ready' }
    if (deps.platformConnectorConfigured(callback.platform as Platform) && deps.strictAuth()) {
      initialSync = { state: 'blocked', reason: 'service_principal_authorization_not_configured', fail_closed: true }
    } else if (deps.platformConnectorConfigured(callback.platform as Platform)) {
      const job = deps.service.createSyncJob({ workspaceId: callback.workspaceId, platform: callback.platform as Platform, accountId: account.id, mode: 'full' })
      await deps.persistSnapshot(callback.workspaceId, 'sync_job', job)
      await deps.persistEvent(callback.workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform: callback.platform, account_id: account.id, mode: job.mode })
      initialSync = { state: 'queued', jobId: job.id }
    }
    const store = deps.storeDirectory(callback.workspaceId, callback.platform as Platform).find(item => item.accountId === account.id)
    if (deps.wantsOAuthHtml()) {
      deps.sendOAuthPage({ state: 'success', platform: callback.platform, ...(store?.label ? { storeLabel: store.label } : {}), syncState: String(initialSync.state) })
      return true
    }
    deps.send(200, callback.workspaceId, { platform: callback.platform, accountId: account.id, remoteAccountId: account.remoteAccountId, connected: true, tokenState: 'stored_in_vault', ...(store ? { store } : {}), initialSync, nextActions: ['refresh_workspace_health', 'select_store_by_platform_and_account_id', ...(initialSync.state === 'queued' ? [] : ['start_catalog_sync_with_account_id'])] })
    return true
  }
  return false
}
