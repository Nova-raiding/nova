export interface ApiHealth {
  status: string
  writesEnabled: boolean
  connectors: Record<string, string>
  persistence?: { mode: string; ready: boolean }
  setup?: { objectStorage?: { configured: boolean; mode: string } }
}

export type PlatformId = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'
export type TaskState = string
export type PublishState = string

export interface ApiEnvelope<T> {
  request_id: string
  trace_id: string
  workspace_id: string
  data: T | null
  warnings: Array<{ code?: string; message?: string }>
  next_actions: string[]
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

export interface PlatformAccount {
  platform: PlatformId
  state: 'fixture_ready' | 'connected' | 'not_configured' | string
  readEnabled: boolean
  writeEnabled: boolean
  authorizationUrl?: string
  accountId?: string
  label?: string
  alias?: string
  storeName?: string
  readiness?: { ready: boolean; reasons: string[]; verifiedCapabilities: string[] }
}

export interface CapabilityEvidenceRow {
  capability: string
  state: 'unverified' | 'documented' | 'fixture_verified' | 'test_e2e' | 'production_canary' | string
  evidenceRef?: string
  verifiedBy?: string
  verifiedAt?: string
  apiVersion?: string
  scope?: string
}

export interface PlatformCapability {
  platform: PlatformId
  readiness: { ready: boolean; reasons: string[]; verifiedCapabilities: string[] }
  capabilities: CapabilityEvidenceRow[]
}
export interface RulePack {
  id: string
  name: string
  version: string
  scope: string
  status: string
  updatedAt: string
  source?: { kind: string; reference: string; checkedAt: string }
  checksum?: string
  revision?: number
  targetId?: string
  scopeValue?: string
  activatedAt?: string
  deactivatedAt?: string
}

export interface CatalogCategory {
  code: string
  name: string
  fields: string[]
  platforms: PlatformId[]
  status: string
  updatedAt: string
}

export interface ApiError extends Error {
  code?: string
  status?: number
}

export interface BillingStatus {
  balance_cny: string
  billing_mode: string
  model_access: { access_state: string; message: string }
  plugin_access: { unlocked: boolean; balance_cny: string; unlocks: string[] }
  recharge_channels: string[]
  provider_ready: boolean
}

export interface RechargeOrder {
  id: string
  state: string
  amount_cny?: string
  channel?: 'alipay' | 'wechat' | string
  payment_url?: string
  payment_mode?: string
  paymentUrl?: string
  paymentMode?: string
  warning?: string
}

export interface WorkspaceMetrics {
  stores: Array<{ platform: PlatformId; accountId: string; connection?: { state: string; readable: boolean; dataMode: string }; product?: { total: number } }>
  productSummary: { total: number; lowStock: number; missingImages: number }
  riskSummary: { total: number; returned: number; truncated: boolean }
  riskItems: Array<{ severity: 'high' | 'medium'; type: string }>
  taskFunnel: Record<string, number>
}

export interface Product {
  id: string
  workspaceId: string
  platform: PlatformId
  accountId?: string
  storeName: string
  storeDifferentiation?: string
  remoteId?: string
  title: string
  skuCount: number
  stock: number
  factsConfirmed: boolean
  source: string
  updatedAt: string
  price?: number
  category?: string
  images?: string[]
  attributes?: Record<string, string>
  skus?: Array<{ id: string; name: string; price?: number; stock?: number; images?: string[]; attributes?: Record<string, string> }>
}

export interface Task {
  id: string
  workspaceId: string
  productId: string
  platform: PlatformId
  state: TaskState
  selectedDirectionId?: string
  contentVersionId?: string
  version: number
  createdAt: string
  accountId?: string
  remoteState?: string
  requestText?: string
  inputSnapshotId?: string
  answers?: Record<string, string | number | boolean | string[]>
  missingQuestions?: TaskQuestion[]
  taskGroupId?: string
  parentTaskId?: string
}

export interface TaskQuestion {
  id: string
  kind: 'blocking' | 'recommended' | 'optional'
  prompt: string
  why: string
  ifSkipped: string
}

export interface TaskUnderstanding {
  requestText: string
  platformCandidates: PlatformId[]
  productCandidates: Array<{ id: string; title: string; platform: PlatformId; remoteId?: string }>
  extracted: Record<string, string>
  questions: TaskQuestion[]
  executionPlan: { mode: 'single_task' | 'split_by_platform' | 'needs_clarification'; canCreate: boolean; reason: string; childTasks: Array<{ platform: PlatformId; candidateProductIds: string[]; bindingState: 'ready' | 'missing' | 'ambiguous' }> }
}

export interface ContentVersion {
  id: string
  taskId: string
  parentId?: string
  version: number
  body: { title: string; detail: string; sellingPoints: string[]; modules?: Array<{ key: string; title: string; purpose: string; body: string; contentKind?: 'fact' | 'creative' | 'pending'; pendingReason?: string; imageGuidance?: string }>; brief?: { placement: string; targetDimensions: string; headline: string; subheadline: string; coreSellingPoint: string; cta: string; safeArea: string; protectedAreas: string[] } }
  factVersionIds: string[]
  ruleVersionIds: string[]
  state: string
  revision: number
}

export interface ReviewFinding { code: string; severity: 'error' | 'warning'; priority: 'P0' | 'P1' | 'P2'; status: 'open' | 'acknowledged' | 'resolved' | 'waived'; field: string; message: string; repairSuggestion: string; evidence?: { kind: 'fact' | 'rule' | 'brand' | 'content' | 'image'; sourceIds: string[] }; decision?: { reason: string; actorId: string; updatedAt: string } }
export interface ReviewCategory { id: string; name: string; status: 'passed' | 'warning' | 'blocking' | 'not_evaluated' | 'external_pending'; findingCount: number; summary: string }

export type FeedbackRating = 'liked' | 'neutral' | 'needs_improvement'
export interface TaskFeedback {
  id: string
  workspaceId: string
  taskId: string
  contentVersionId?: string
  rating: FeedbackRating
  reason?: string
  comment?: string
  actorId: string
  createdAt: string
  revision: number
}

export interface TaskTimelineEvent {
  id: string
  aggregate_id: string
  event_type: string
  sequence: number
  occurred_at: string
  delivery: 'pending' | 'delivered' | 'unknown' | string
  attempts?: number
  error?: Record<string, unknown>
  payload?: Record<string, unknown>
}

export interface GenerationJob {
  id: string
  workspaceId: string
  taskId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | string
  idempotencyKey: string
  attempt: number
  contentVersionId?: string
  errorCode?: string
  errorMessage?: string
}

export interface PublishPreview {
  task: Task
  version: ContentVersion
  remoteSnapshotHash: string
  confirmationHash: string
  operation: 'create' | 'update'
  changes: string[]
  protectedFields: string[]
}

export interface PublishJob {
  id: string
  workspaceId: string
  taskId: string
  contentVersionId: string
  platform: PlatformId
  idempotencyKey: string
  state: PublishState
  confirmationHash: string
  remoteSnapshotHash: string
  createdAt: string
  accountId?: string
  remoteState?: string
  rejection?: {
    rawCode: string
    message?: string
    fields: Array<{ path: string; rawCode?: string; message: string }>
  }
}

export interface SyncFailureItem {
  id: string
  remoteId?: string
  cursor?: string
  pageNumber: number
  code: string
  message: string
  retryable: boolean
  createdAt: string
}

export interface SyncJob {
  id: string
  platform: PlatformId
  state: string
  itemsReceived: number
  itemsUpserted: number
  itemsFailed: number
  failedItems: SyncFailureItem[]
  nextCursor?: string
}

export interface AssetMetadata {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  rightsStatus: 'approved' | 'rejected' | 'pending' | string
  rightsScope?: string
  applicablePlatforms?: PlatformId[]
  aiModificationAllowed?: boolean
  scanStatus: 'quarantined' | 'clean' | 'rejected' | string
  parseStatus: 'pending' | 'processing' | 'succeeded' | 'failed' | string
  parseError?: string
  extractedFacts?: Record<string, unknown>
  factsConfirmedBy?: string
  factsConfirmedAt?: string
  preference?: { verdict: 'excellent' | 'disliked'; reasons: string[]; note?: string; updatedBy: string; updatedAt: string }
  contentTrust: { classification: 'untrusted'; mode: 'data_only'; canOverrideInstructions: false; canTriggerTools: false; requiresMerchantConfirmation: true }
  references: Array<{ name: string; mimeType: string; firstSeenAt: string }>
  revision: number
  createdAt: string
}

export type BrandCandidateFieldKey = 'name' | 'positioning' | 'audience' | 'tone' | 'forbiddenTerms' | 'logoRules' | 'colors' | 'fonts' | 'rights'
export interface BrandProfile {
  id: string
  name: string
  positioning?: string
  audience?: string
  tone?: string[]
  forbiddenTerms?: string[]
  details?: Record<string, unknown>
  visualRules?: BrandVisualRules
  revision: number
}
export interface BrandVisualRules {
  logo?: { assetIds: string[]; allowRecolor: boolean; allowDistortion: boolean; allowRedraw: boolean; clearSpace?: string }
  colors?: { primary: string[]; secondary: string[]; forbidden: string[] }
  fonts?: Array<{ family: string; assetId?: string; licenseStatus: 'approved' | 'restricted' | 'unknown' }>
  styleKeywords?: string[]
  restrictedSubjects?: { people: string[]; spokespersons: string[]; intellectualProperties: string[]; prohibitedContent: string[] }
}
export interface BrandCandidateField {
  key: BrandCandidateFieldKey
  label: string
  value: string | string[]
  confidence: number
  status: 'needs_confirmation' | 'conflict'
  confirmationRequired: true
  sources: Array<{ assetId: string; assetName: string; reference: string; confidence: number }>
  alternatives: Array<{ value: string | string[]; confidence: number; sourceAssetIds: string[] }>
}
export interface BrandExtraction {
  assetIds: string[]
  fields: Partial<Record<BrandCandidateFieldKey, BrandCandidateField>>
  ignoredAssets: Array<{ assetId: string; assetName: string; reason: string }>
  warnings: string[]
}

const apiUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/$/, '')}${path}`
const API_REQUEST_TIMEOUT_MS = 10_000
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('API response exceeded safety limit')
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('API response exceeded safety limit')
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('API response exceeded safety limit')
      }
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }
  return chunks.join('')
}

export async function requestApi<T>(baseUrl: string, path: string, init: RequestInit = {}, workspaceId = (import.meta.env.VITE_WORKSPACE_ID as string | undefined) ?? 'ws_demo'): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('x-workspace-id', workspaceId)
  const token = import.meta.env.VITE_API_TOKEN as string | undefined
  if (token) headers.set('authorization', `Bearer ${token}`)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS)
  const forwardAbort = () => controller.abort()
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    const response = await fetch(apiUrl(baseUrl, path), { ...init, headers, signal: controller.signal })
    const raw = await readBoundedResponseText(response, MAX_API_RESPONSE_BYTES)
    let envelope: ApiEnvelope<T> | null = null
    try { envelope = raw ? JSON.parse(raw) as ApiEnvelope<T> : null } catch {
      const error = new Error(`API request failed: ${response.status}`) as ApiError
      error.status = response.status
      throw error
    }
    if (!envelope) {
      const error = new Error(`API request failed: ${response.status}`) as ApiError
      error.status = response.status
      throw error
    }
    if (!response.ok || envelope.error) {
      const error = new Error(envelope.error?.message ?? `API request failed: ${response.status}`) as Error & { code?: string; status?: number }
      error.code = envelope.error?.code
      error.status = response.status
      throw error
    }
    if (envelope.data === null) throw new Error('API returned no data')
    return envelope.data
  } catch (cause) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      const error = new Error('API request timed out') as ApiError
      error.code = 'API_REQUEST_TIMEOUT'
      throw error
    }
    throw cause
  } finally {
    window.clearTimeout(timeout)
    init.signal?.removeEventListener('abort', forwardAbort)
  }
}

export function isNotConfigured(error: unknown) {
  return (error as ApiError | undefined)?.code === 'NOT_CONFIGURED' || (error as ApiError | undefined)?.status === 503
}

export function describeApiError(error: unknown) {
  if ((error as ApiError | undefined)?.code === 'API_REQUEST_TIMEOUT') return 'API 请求超时。请检查 API、数据库和网关状态后重试。'
  if (isNotConfigured(error)) return '该平台尚未配置官方 API 或授权，当前不会执行任何外部写入。'
  if (error instanceof Error && error.message) return error.message
  return '请求失败，请稍后重试。'
}

export async function fetchApiHealth(baseUrl = import.meta.env.VITE_API_BASE_URL): Promise<ApiHealth | null> {
  if (!baseUrl) return null
  return requestApi<ApiHealth>(baseUrl, '/healthz')
}

export async function requestMcp<T>(baseUrl: string, method: string, params: Record<string, unknown> = {}) {
  const response = await requestApi<{ result: T }>(baseUrl, '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: `studio-${Date.now()}`, method, params }) })
  return response.result
}

export const fetchBillingStatus = (baseUrl: string) => requestMcp<BillingStatus>(baseUrl, 'billing.status')
export const fetchWorkspaceMetrics = (baseUrl: string) => requestMcp<WorkspaceMetrics>(baseUrl, 'workspace.metrics')
export const createRechargeOrder = (baseUrl: string, amountCny: string, channel: 'alipay' | 'wechat' = 'alipay') => requestMcp<RechargeOrder>(baseUrl, 'billing.recharge.create', { amount_cny: amountCny, channel, idempotency_key: `studio-${channel}-${amountCny}-${Date.now()}` })
export const fetchRechargeOrder = (baseUrl: string, orderId: string) => requestMcp<RechargeOrder>(baseUrl, 'billing.recharge.get', { order_id: orderId })
export const optimizeProductTitle = (baseUrl: string, input: { product_id: string; platform?: PlatformId; keyword?: string; objective?: string }) => requestMcp<{ product_id: string; platform: PlatformId; suggestions: Array<{ title: string; score: { seo: number; geo: number; total: number }; keywords: string[]; evidence: Array<{ source: string; value: string }>; risks: string[]; rankingGuarantee: false }>; humanConfirmationRequired: boolean; rankingGuarantee: false }>(baseUrl, 'catalog.title.optimize', input)

export const fetchPlatformAccounts = (baseUrl: string) => requestApi<{ items: PlatformAccount[] }>(baseUrl, '/v1/platform-accounts')
export const fetchPlatformCapabilities = (baseUrl: string) => requestApi<{ items: PlatformCapability[] }>(baseUrl, '/v1/platform-capabilities')
export const fetchRulePacks = (baseUrl: string, platform?: PlatformId) => requestApi<RulePack[]>(baseUrl, `/v1/rules${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`)
export const fetchCatalogCategories = (baseUrl: string) => requestApi<CatalogCategory[]>(baseUrl, '/v1/catalog/categories')
export const fetchProducts = (baseUrl: string) => requestApi<Product[]>(baseUrl, '/v1/products')
export const fetchAssets = (baseUrl: string) => requestApi<AssetMetadata[]>(baseUrl, '/v1/assets')
const assetMimeType = (file: File) => file.type || ({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.ai': 'application/postscript', '.eps': 'application/postscript',
} as Record<string, string>)[file.name.slice(file.name.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream'
export const uploadAsset = async (baseUrl: string, file: File) => requestApi<AssetMetadata>(baseUrl, '/v1/assets/upload', {
  method: 'POST',
  headers: { 'content-type': assetMimeType(file), 'x-asset-name': encodeURIComponent(file.name) },
  body: await file.arrayBuffer(),
})
export const fetchBrandProfile = (baseUrl: string) => requestApi<{ profile: BrandProfile | null }>(baseUrl, '/v1/brand-profile')
export const extractBrandProfile = (baseUrl: string, assetIds?: string[]) => requestApi<BrandExtraction>(baseUrl, '/v1/brand-profile/extract', { method: 'POST', body: JSON.stringify(assetIds?.length ? { asset_ids: assetIds } : {}) })
export const saveBrandProfile = (baseUrl: string, input: { name: string; positioning?: string; audience?: string; tone?: string[]; forbidden_terms?: string[]; details?: Record<string, unknown>; visual_rules?: BrandVisualRules; source?: string; conflict_resolutions?: Record<string, 'existing' | 'candidate'> }) => requestApi<BrandProfile>(baseUrl, '/v1/brand-profile', { method: 'PUT', body: JSON.stringify(input) })
export const saveAssetPreference = (baseUrl: string, assetId: string, input: { verdict: 'excellent' | 'disliked' | 'unrated'; reasons?: string[]; note?: string; expected_revision?: number }) => requestApi<AssetMetadata>(baseUrl, `/v1/assets/${encodeURIComponent(assetId)}/preference`, { method: 'PUT', body: JSON.stringify(input) })
export const updateAssetRights = (baseUrl: string, assetId: string, input: { rights_status: 'approved' | 'rejected' | 'pending'; rights_scope?: string; applicable_platforms?: PlatformId[]; applicable_regions?: string[]; usage_scopes?: string[]; ai_modification_allowed?: boolean }) => requestApi<AssetMetadata>(baseUrl, `/v1/assets/${encodeURIComponent(assetId)}/rights`, { method: 'PUT', body: JSON.stringify(input) })
export const confirmAssetFacts = (baseUrl: string, assetId: string, facts: Record<string, unknown>, reason: string) => requestApi<AssetMetadata>(baseUrl, `/v1/assets/${encodeURIComponent(assetId)}/facts`, { method: 'POST', body: JSON.stringify({ facts, reason }) })
export const parseAsset = (baseUrl: string, assetId: string) => requestApi<AssetMetadata>(baseUrl, `/v1/assets/${encodeURIComponent(assetId)}/parse`, { method: 'POST' })
export async function fetchAssetBlob(baseUrl: string, assetId: string, signal?: AbortSignal): Promise<Blob> {
  const headers = new Headers({ accept: 'application/octet-stream' })
  headers.set('x-workspace-id', (import.meta.env.VITE_WORKSPACE_ID as string | undefined) ?? 'ws_demo')
  const token = import.meta.env.VITE_API_TOKEN as string | undefined
  if (token) headers.set('authorization', `Bearer ${token}`)
  const response = await fetch(apiUrl(baseUrl, `/v1/assets/${encodeURIComponent(assetId)}/download`), { headers, signal })
  if (!response.ok) {
    const error = new Error(`素材读取失败：HTTP ${response.status}`) as ApiError
    error.status = response.status
    throw error
  }
  return response.blob()
}
export const reviewProductImages = (baseUrl: string, productId: string) => requestApi<{ productId: string; images: string[]; findings: ReviewFinding[]; externallyUnverified: string[] }>(baseUrl, `/v1/products/${encodeURIComponent(productId)}/image-review`)
export const importProduct = (baseUrl: string, input: { platform: PlatformId; title: string; local_product_key?: string; remote_id?: string; category?: string; price?: number; stock?: number; sku_count?: number; store_name?: string }) => requestApi<Product>(baseUrl, '/v1/products/import', { method: 'POST', body: JSON.stringify(input) })
export const fetchPublishJobs = (baseUrl: string) => requestApi<PublishJob[]>(baseUrl, '/v1/publish-jobs')
export const createTask = (baseUrl: string, input: { product_id: string; platform: PlatformId; account_id?: string }) => requestApi<Task>(baseUrl, '/v1/tasks', { method: 'POST', body: JSON.stringify(input) })
export const fetchTask = (baseUrl: string, taskId: string) => requestApi<Task>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}`)
export const fetchTasks = (baseUrl: string, filters: { state?: string; platform?: PlatformId; query?: string } = {}) => { const params = new URLSearchParams(); if (filters.state) params.set('state', filters.state); if (filters.platform) params.set('platform', filters.platform); if (filters.query) params.set('query', filters.query); return requestApi<Task[]>(baseUrl, `/v1/tasks${params.toString() ? `?${params.toString()}` : ''}`) }
export const understandTask = (baseUrl: string, requestText: string) => requestApi<TaskUnderstanding>(baseUrl, '/v1/tasks/understand', { method: 'POST', body: JSON.stringify({ request_text: requestText }) })
export const answerTask = (baseUrl: string, taskId: string, answers: Record<string, string | number | boolean | string[]>, expectedVersion?: number) => requestApi<Task>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/answers`, { method: 'POST', body: JSON.stringify({ answers, ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }) }) })
export const createTaskGroup = (baseUrl: string, entries: Array<{ product_id: string; platform: PlatformId; account_id?: string }>, requestText?: string) => requestApi<{ id: string; taskIds: string[]; tasks: Task[] }>(baseUrl, '/v1/task-groups', { method: 'POST', body: JSON.stringify({ entries, ...(requestText ? { request_text: requestText } : {}) }) })
export const selectDirection = (baseUrl: string, taskId: string, directionId: string) => requestApi<Task>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/directions`, { method: 'POST', body: JSON.stringify({ direction_id: directionId }) })
export const confirmTaskPlan = (baseUrl: string, taskId: string, expectedVersion?: number) => requestApi<Task>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/plan/confirm`, { method: 'POST', body: JSON.stringify(expectedVersion === undefined ? {} : { expected_version: expectedVersion }) })
export const enqueueContentGeneration = (baseUrl: string, taskId: string, idempotencyKey: string) => requestApi<GenerationJob>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/content-jobs`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey } })
export const fetchGenerationJob = (baseUrl: string, jobId: string) => requestApi<GenerationJob>(baseUrl, `/v1/generation-jobs/${encodeURIComponent(jobId)}`)
export const fetchContentVersions = (baseUrl: string, taskId: string) => requestApi<ContentVersion[]>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/content-versions`)
export const reviewContent = (baseUrl: string, contentVersionId: string) => requestApi<{ findings: ReviewFinding[]; categories: ReviewCategory[]; blocking: boolean }>(baseUrl, `/v1/content-versions/${encodeURIComponent(contentVersionId)}/review`)
export const decideReviewFinding = (baseUrl: string, contentVersionId: string, input: { code: string; field: string; status: 'acknowledged' | 'waived'; reason?: string; expected_revision?: number }) => requestApi<{ version: ContentVersion; report: { findings: ReviewFinding[]; categories: ReviewCategory[]; blocking: boolean } }>(baseUrl, `/v1/content-versions/${encodeURIComponent(contentVersionId)}/review-decisions`, { method: 'POST', body: JSON.stringify(input) })
export const fetchTaskFeedback = (baseUrl: string, taskId: string) => requestApi<TaskFeedback[]>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/feedback`)
export const fetchTaskTimeline = (baseUrl: string, taskId: string) => requestApi<TaskTimelineEvent[]>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/timeline?limit=200`)
export const submitTaskFeedback = (baseUrl: string, taskId: string, input: { content_version_id?: string; rating: FeedbackRating; reason?: string }) => requestApi<TaskFeedback>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/feedback`, { method: 'POST', body: JSON.stringify(input) })
export const diffContentVersions = (baseUrl: string, contentVersionId: string, againstVersionId?: string) => requestApi<{ fromVersionId: string; toVersionId: string; changes: Array<{ path: string; before: unknown; after: unknown }> }>(baseUrl, `/v1/content-versions/${encodeURIComponent(contentVersionId)}/diff${againstVersionId ? `?against=${encodeURIComponent(againstVersionId)}` : ''}`)
export async function generateContent(baseUrl: string, taskId: string, idempotencyKey = `merchant-studio-generation-${taskId}`): Promise<ContentVersion> {
  const job = await enqueueContentGeneration(baseUrl, taskId, idempotencyKey)
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = attempt === 0 ? job : await fetchGenerationJob(baseUrl, job.id)
    if (current.state === 'succeeded' && current.contentVersionId) {
      const versions = await fetchContentVersions(baseUrl, taskId)
      const version = versions.find(candidate => candidate.id === current.contentVersionId)
      if (version) return version
    }
    if (current.state === 'failed') throw new Error(current.errorMessage ?? '内容生成失败')
    await new Promise(resolve => window.setTimeout(resolve, 500))
  }
  throw new Error('内容生成超时，请到任务详情查看生成任务状态')
}
export const approveContent = (baseUrl: string, taskId: string, contentVersionId: string) => requestApi<{ task: Task; version: ContentVersion }>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/approve`, { method: 'POST', body: JSON.stringify({ content_version_id: contentVersionId }) })
export const preparePublish = (baseUrl: string, taskId: string) => requestApi<PublishPreview>(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/publish-preview`, { method: 'POST' })
export const confirmPublish = (baseUrl: string, input: { task_id: string; content_version_id: string; confirmation_hash: string; remote_snapshot_hash: string; account_id?: string }, idempotencyKey: string) => requestApi<PublishJob>(baseUrl, '/v1/publish-jobs', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) })
export const getPublishJob = (baseUrl: string, jobId: string) => requestApi<PublishJob>(baseUrl, `/v1/publish-jobs/${encodeURIComponent(jobId)}`)
export const authorizePlatform = (baseUrl: string, platform: PlatformId) => requestApi<{ platform: PlatformId; mode: string; authorizationUrl: string }>(baseUrl, `/v1/platform-accounts/${platform}/authorize`, { method: 'POST', body: JSON.stringify({ actor_id: 'actor_demo' }) })
export const completeFixtureAuthorization = (baseUrl: string, platform: PlatformId, authorizationUrl: string) => {
  const state = new URL(authorizationUrl).searchParams.get('state')
  if (!state) return Promise.reject(new Error('fixture 授权地址缺少 state'))
  return requestApi<{ platform: PlatformId; accountId: string; connected: boolean; initialSync?: { state: string; jobId: string } }>(baseUrl, `/v1/oauth/callback/${platform}?state=${encodeURIComponent(state)}&code=fixture-code`)
}
export const syncPlatform = (baseUrl: string, platform: PlatformId, accountId?: string) => requestApi<{ platform: PlatformId; source: string; simulated: boolean; items: Product[] }>(baseUrl, `/v1/platform-accounts/${platform}/sync`, { method: 'POST', headers: accountId ? { 'x-account-id': accountId } : undefined, body: JSON.stringify(accountId ? { account_id: accountId } : {}) })
export const fetchSyncJobs = (baseUrl: string) => requestApi<SyncJob[]>(baseUrl, '/v1/sync-jobs')
export const revokePlatform = (baseUrl: string, platform: PlatformId, accountId: string) => requestApi<{ platform: PlatformId; accountId: string; state: string; remoteRevoked: boolean }>(baseUrl, `/v1/platform-accounts/${platform}`, { method: 'DELETE', headers: { 'x-account-id': accountId } })
export const retrySyncFailures = (baseUrl: string, syncJobId: string, failureIds?: string[]) => requestApi<{ jobs: SyncJob[] }>(baseUrl, `/v1/sync-jobs/${encodeURIComponent(syncJobId)}/retry-failed`, { method: 'POST', body: JSON.stringify(failureIds?.length ? { failure_ids: failureIds } : {}) })
export const modifyContentVersion = (baseUrl: string, contentVersionId: string, input: { changes: Record<string, unknown>; locked_fields?: string[]; reason: string; expected_revision?: number }) => requestApi<{ source: ContentVersion; version: ContentVersion; task: Task }>(baseUrl, `/v1/content-versions/${encodeURIComponent(contentVersionId)}/modify`, { method: 'POST', body: JSON.stringify(input) })
