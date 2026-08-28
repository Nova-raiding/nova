export type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type ActorId = Brand<string, 'ActorId'>
export type AccountId = Brand<string, 'AccountId'>
export type ProductId = Brand<string, 'ProductId'>
export type SkuId = Brand<string, 'SkuId'>
export type TaskId = Brand<string, 'TaskId'>
export type ContentVersionId = Brand<string, 'ContentVersionId'>
export type FactVersionId = Brand<string, 'FactVersionId'>
export type JobId = Brand<string, 'JobId'>
export type TraceId = Brand<string, 'TraceId'>

export type ContentExportFormat = 'manifest' | 'json' | 'markdown' | 'bundle'

export interface ContentVersionExportManifest {
  readonly schema_version: string
  readonly workspace_id: string
  readonly task_id: string
  readonly content_version_id: string
  readonly version: number
  readonly state: 'draft' | 'review_required' | 'approved' | 'delivered'
  readonly parent_id: string | null
  readonly files: readonly string[]
  readonly publish: Readonly<Record<string, unknown>>
  readonly publish_receipt: null
}

export const PLATFORMS = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export type Platform = (typeof PLATFORMS)[number]

export const TASK_STATES = [
  'draft', 'resolving_context', 'blocked_missing_facts', 'blocked_conflict',
  'ready_for_direction', 'direction_selected', 'plan_confirmed', 'generating',
  'review_required', 'changes_requested', 'approved', 'publish_prepared',
  'publishing', 'delivered', 'canceled', 'failed_recoverable', 'failed_terminal',
] as const
export type TaskState = (typeof TASK_STATES)[number]

export const PUBLISH_STATES = [
  'prepared', 'confirmed', 'queued', 'submitting', 'submitted', 'reviewing',
  'published', 'rejected', 'unknown', 'reconciling', 'manual_attention',
] as const
export type PublishState = (typeof PUBLISH_STATES)[number]

export interface ConnectorContext {
  readonly workspace_id: WorkspaceId
  readonly account_id: AccountId
  readonly actor_id?: ActorId
  readonly trace_id: TraceId
  readonly signal?: AbortSignal
}

export interface AuthorizeInput {
  readonly workspace_id: WorkspaceId
  readonly actor_id: ActorId
  readonly platform: Platform
  readonly return_uri: string
  readonly state: string
  readonly code_challenge?: string
}

export interface AuthorizeResult {
  readonly authorization_url: string
  readonly state_expires_at: string
}

export interface CallbackInput {
  readonly code: string
  readonly state: string
  readonly callback_uri: string
}

export interface CredentialRef {
  readonly secret_ref: string
  readonly platform: Platform
  readonly account_id: AccountId
  readonly expires_at?: string
  readonly refreshable: boolean
}

export interface Cursor { readonly value: string }
export interface Store { readonly remote_id: string; readonly name: string }
export interface StorePage { readonly items: readonly Store[]; readonly next_cursor?: Cursor }
export interface RawProduct { readonly remote_id: string; readonly payload_ref: string; readonly observed_at: string }
export interface ProductPage { readonly items: readonly RawProduct[]; readonly next_cursor?: Cursor }
export interface MappingVersion { readonly id: string; readonly profile: string }
export interface CommerceProductDraft { readonly remote_id: string; readonly fields: Readonly<Record<string, unknown>> }
export interface PlatformWriteDraft { readonly remote_id: string; readonly fields: Readonly<Record<string, unknown>>; readonly field_allowlist: readonly string[] }
export interface ValidationFinding { readonly path: string; readonly code: string; readonly message: string; readonly severity: 'error' | 'warning' }
export interface WriteIdentity { readonly idempotency_key: string; readonly remote_request_id?: string }
export interface WriteReceipt { readonly remote_id: string; readonly request_id: string; readonly accepted_at: string }
export interface WriteStatus { readonly state: 'submitted' | 'reviewing' | 'published' | 'rejected' | 'not_found'; readonly remote_id?: string; readonly raw_error_code?: string }
export interface NormalizedPlatformError { readonly code: string; readonly message: string; readonly retryable: boolean; readonly raw_code?: string; readonly field_path?: string }

export interface PlatformConnector {
  readonly platform: Platform
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>
  exchangeCode(input: CallbackInput): Promise<CredentialRef>
  refreshCredential(ref: CredentialRef): Promise<CredentialRef>
  revoke(ref: CredentialRef): Promise<void>
  listStores(ctx: ConnectorContext): Promise<StorePage>
  syncProducts(ctx: ConnectorContext, cursor?: Cursor): Promise<ProductPage>
  getProduct(ctx: ConnectorContext, remote_id: string): Promise<RawProduct>
  mapToCanonical(raw: RawProduct, mapping: MappingVersion): CommerceProductDraft
  validateWrite(input: PlatformWriteDraft): readonly ValidationFinding[]
  createProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>
  updateProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>
  queryWrite(ctx: ConnectorContext, request: WriteIdentity): Promise<WriteStatus>
  normalizeError(error: unknown): NormalizedPlatformError
}
