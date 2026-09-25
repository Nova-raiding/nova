import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product, type SyncFailureItem, type SyncJob } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'

type Input = Record<string, unknown>
type SyncAuthorization = WorkerAuthorizationSnapshot & { capability: 'catalog.sync.execute' }

export interface SyncJobRouteDependencies {
  service: MerchantService
  supportedPlatforms: readonly Platform[]
  readBody: () => Promise<Input>
  resolveWorkspace: (input?: unknown) => string
  send: (status: number, workspaceId: string, data: unknown) => void
  platformConnectorConfigured: (platform: Platform) => boolean
  defaultFixtureAccountId: (workspaceId: string, platform: Platform) => string
  header: (name: string) => string | undefined
  production: boolean
  strictAuth: () => boolean
  ensureFixtureAccount: (workspaceId: string, platform: Platform, accountId: string) => Promise<unknown>
  workerAuthorizationSnapshot: (workspaceId: string, jobId: string, binding: Record<string, unknown>) => SyncAuthorization | undefined
  serializedWorkerAuthorizationSnapshot: (snapshot: SyncAuthorization) => unknown
  persistSnapshot: (workspaceId: string, job: SyncJob) => Promise<void>
  persistEvent: (workspaceId: string, job: SyncJob, payload: Record<string, unknown>) => Promise<void>
  persistProgress: (workspaceId: string, products: Product[], updated: SyncJob, pageNumber: number, failures: SyncFailureItem[]) => Promise<void>
  invalidateCanonicalFactsAfterSync: (workspaceId: string, products: readonly Product[]) => Promise<void>
  scanImportedProductRules: (workspaceId: string, product: Product) => Promise<unknown>
  scanAutomation: (workspaceId: string, platform: Platform, accountId: string, trigger: string) => Promise<unknown>
  requireWorkerAuthorization: () => Promise<unknown>
  requireWorkerCredentialAuthorization: () => Promise<unknown>
  enrichRequestObservation: (jobId: string) => void
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export async function handleSyncJobCreateRoute(req: IncomingMessage, _res: ServerResponse, path: string, deps: SyncJobRouteDependencies): Promise<boolean> {
  if (path !== '/v1/sync-jobs' || req.method !== 'POST') return false
  const input = await deps.readBody()
  const workspaceId = deps.resolveWorkspace(input.workspace_id)
  const platform = String(input.platform ?? '') as Platform
  if (!deps.supportedPlatforms.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
  if (!deps.platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
  const accountId = (typeof input.account_id === 'string' && input.account_id.trim()) || deps.header('x-account-id')?.trim() || (deps.production ? '' : deps.defaultFixtureAccountId(workspaceId, platform))
  if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
  if (deps.production) deps.service.getActionablePlatformAccount(workspaceId, accountId, platform)
  await deps.ensureFixtureAccount(workspaceId, platform, accountId)
  const job = deps.service.createSyncJob({ workspaceId, platform, accountId, mode: input.mode === 'full' ? 'full' : 'incremental', ...(typeof input.cursor === 'string' && input.cursor.trim() ? { cursor: input.cursor } : {}) })
  const authorizationSnapshot = deps.workerAuthorizationSnapshot(workspaceId, job.id, { route: 'POST /v1/sync-jobs', platform, account_id: accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}) })
  if (deps.strictAuth() && !authorizationSnapshot) {
    deps.service.removeSyncJob(workspaceId, job.id)
    throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', 'HTTP 商品同步入口尚未建立等价的持久授权决策，已拒绝入队', 503)
  }
  await deps.persistSnapshot(workspaceId, job)
  await deps.persistEvent(workspaceId, job, { job_id: job.id, platform, account_id: accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}), ...(authorizationSnapshot ? { authorization_snapshot: deps.serializedWorkerAuthorizationSnapshot(authorizationSnapshot) } : {}) })
  deps.send(202, workspaceId, job)
  return true
}

export async function handleSyncJobRoute(req: IncomingMessage, _res: ServerResponse, path: string, deps: SyncJobRouteDependencies): Promise<boolean> {
  const progressMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/progress$/)
  if (req.method === 'POST' && progressMatch) {
    await deps.requireWorkerAuthorization()
    const workspaceId = deps.resolveWorkspace()
    const input = await deps.readBody()
    const job = deps.service.getSyncJob(workspaceId, progressMatch[1]!)
    deps.enrichRequestObservation(job.id)
    if (['succeeded', 'partial', 'failed'].includes(job.state)) { deps.send(200, workspaceId, job); return true }
    const pageNumber = Number(input.page_number)
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'page_number 无效', 400)
    if (pageNumber <= job.pages) { deps.send(200, workspaceId, job); return true }
    if (!Array.isArray(input.items)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'items 必须是数组', 400)
    const mappedItems = input.items.filter(isObject).map(item => ({
      remoteId: typeof item.remoteId === 'string' ? item.remoteId : typeof item.remote_id === 'string' ? item.remote_id : '',
      title: typeof item.title === 'string' ? item.title : '',
      sku: Array.isArray(item.sku) ? item.sku : [],
      stock: typeof item.stock === 'number' ? item.stock : 0,
      source: item.source === 'fixture' ? 'fixture' as const : 'official_api' as const,
      ...(typeof item.price === 'number' ? { price: item.price } : {}),
      ...(typeof item.category === 'string' ? { category: item.category } : {}),
      ...(Array.isArray(item.images) ? { images: item.images.filter((value): value is string => typeof value === 'string') } : {}),
      ...(isObject(item.attributes) ? { facts: Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => [key, value as string | number])) } : {}),
      raw: item,
    }))
    const invalidItems = mappedItems.filter(item => !item.remoteId || !item.title)
    const items = mappedItems.filter(item => item.remoteId && item.title)
    const failures = invalidItems.map(item => ({ id: `sync-failure-${job.id}-${pageNumber}-${item.remoteId || 'unknown'}`, ...(item.remoteId ? { remoteId: item.remoteId } : {}), ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}), pageNumber, code: 'PRODUCT_REQUIRED_FIELD_MISSING', message: !item.remoteId ? '平台商品缺少 remote_id' : '平台商品缺少 title', raw: item.raw, retryable: true, createdAt: new Date().toISOString() }))
    const products = deps.service.upsertSyncedProducts({ workspaceId, platform: job.platform, accountId: job.accountId, items })
    await deps.invalidateCanonicalFactsAfterSync(workspaceId, products)
    for (const product of products) await deps.scanImportedProductRules(workspaceId, product)
    const updated = deps.service.updateSyncJob(workspaceId, job.id, { state: 'running', pages: pageNumber, itemsUpserted: job.itemsUpserted + products.length, itemsFailed: job.itemsFailed + failures.length, failedItems: [...job.failedItems, ...failures], ...(typeof input.next_cursor === 'string' && input.next_cursor ? { nextCursor: input.next_cursor, resumeCursor: input.next_cursor } : {}) })
    await deps.persistProgress(workspaceId, products, updated, pageNumber, failures)
    deps.send(200, workspaceId, updated)
    return true
  }
  const resultMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/result$/)
  if (req.method === 'POST' && resultMatch) {
    await deps.requireWorkerAuthorization()
    const workspaceId = deps.resolveWorkspace()
    const input = await deps.readBody()
    const job = deps.service.getSyncJob(workspaceId, resultMatch[1]!)
    deps.enrichRequestObservation(job.id)
    const state = input.state === 'failed' || input.state === 'partial' ? input.state : 'succeeded'
    if (['succeeded', 'partial', 'failed'].includes(job.state)) {
      if (job.state === state) { deps.send(200, workspaceId, { ...job, replayed: true }); return true }
      throw new DomainError('SYNC_JOB_TERMINAL_CONFLICT', '同步任务已进入不可逆终态，拒绝迟到结果覆盖', 409, { current_state: job.state, attempted_state: state })
    }
    const updated = deps.service.updateSyncJob(workspaceId, job.id, { state, ...(state === 'succeeded' ? { nextCursor: undefined, resumeCursor: undefined } : {}), ...(typeof input.error_message === 'string' ? { errorMessage: input.error_message } : {}) })
    await deps.persistSnapshot(workspaceId, updated)
    const automation = state === 'succeeded' || state === 'partial'
      ? await deps.scanAutomation(workspaceId, job.platform, job.accountId, `sync-job.result.${state}`)
      : { triggered: false as const, reason: 'sync_failed' as const }
    deps.send(200, workspaceId, { ...updated, automation })
    return true
  }
  const executionContextMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/execution-context$/)
  if (req.method === 'GET' && executionContextMatch) {
    await deps.requireWorkerCredentialAuthorization()
    const workspaceId = deps.resolveWorkspace()
    const job = deps.service.getSyncJob(workspaceId, executionContextMatch[1]!)
    deps.enrichRequestObservation(job.id)
    if (['succeeded', 'partial', 'failed'].includes(job.state)) throw new DomainError('SYNC_JOB_TERMINAL', '同步任务已结束，不再签发执行上下文', 409, { state: job.state })
    const account = deps.service.getActivePlatformAccount(workspaceId, job.accountId, job.platform)
    deps.send(200, workspaceId, { job_id: job.id, account_id: account.id, credential_ref: account.credentialRef })
    return true
  }
  const retryMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/retry-failed$/)
  if (req.method === 'POST' && retryMatch) {
    const workspaceId = deps.resolveWorkspace()
    const input = await deps.readBody()
    const failureIds = Array.isArray(input.failure_ids) ? input.failure_ids.filter((value): value is string => typeof value === 'string') : undefined
    const sourceJobId = retryMatch[1]!
    const jobs = deps.service.retrySyncFailures(workspaceId, sourceJobId, failureIds)
    const authorizationSnapshots = new Map(jobs.map(job => [job.id, deps.workerAuthorizationSnapshot(workspaceId, job.id, { route: 'POST /v1/sync-jobs/:id/retry-failed', source_job_id: sourceJobId, platform: job.platform, account_id: job.accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}) })]))
    if (deps.strictAuth() && [...authorizationSnapshots.values()].some(snapshot => !snapshot)) {
      for (const job of jobs) deps.service.removeSyncJob(workspaceId, job.id)
      throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '同步重试缺少已强制且 capability 匹配的持久身份授权快照，已拒绝入队', 503)
    }
    for (const job of jobs) {
      const authorizationSnapshot = authorizationSnapshots.get(job.id)
      await deps.persistSnapshot(workspaceId, job)
      await deps.persistEvent(workspaceId, job, { job_id: job.id, platform: job.platform, account_id: job.accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}), retry_of: sourceJobId, ...(authorizationSnapshot ? { authorization_snapshot: deps.serializedWorkerAuthorizationSnapshot(authorizationSnapshot) } : {}) })
    }
    deps.send(202, workspaceId, { jobs })
    return true
  }
  return false
}
