import type {
  AccountId,
  ActorId,
  ContentVersionId,
  JobId,
  Platform,
  ProductId,
  TaskId,
  TraceId,
  WorkspaceId,
} from './domain.js'

export interface ApiWarning {
  readonly code: string
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface ApiError {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface NextAction {
  readonly type: string
  readonly label: string
  readonly tool?: string
  readonly href?: string
  readonly requires_confirmation?: boolean
}

/**
 * A UI-safe, executable suggestion returned alongside legacy next_actions.
 * The bridge renders these as cards; it never executes them implicitly.
 */
export interface ActionCard {
  readonly id: string
  readonly type: 'recharge' | 'upgrade' | 'store_addon' | 'connect' | 'view'
  readonly label: string
  readonly description?: string
  readonly tool: string
  readonly arguments?: Readonly<Record<string, unknown>>
  readonly required_inputs?: readonly string[]
  readonly requires_confirmation?: boolean
  readonly enabled?: boolean
}

/** Serialized API shape shared by REST, MCP and UI adapters. */
export interface ApiEnvelope<T> {
  readonly request_id: string
  readonly trace_id: TraceId
  readonly workspace_id: WorkspaceId
  readonly data: T | null
  readonly warnings: readonly ApiWarning[]
  readonly next_actions: readonly NextAction[]
  readonly error: ApiError | null
}

export interface JobEnvelope {
  readonly job_id: JobId
  readonly job_type: JobType
  readonly workspace_id: WorkspaceId
  readonly actor_id: ActorId
  readonly platform?: Platform
  readonly account_id?: AccountId
  readonly task_id?: TaskId
  readonly content_version_id?: ContentVersionId
  readonly remote_snapshot_id?: string
  readonly idempotency_key: string
  readonly attempt: number
  readonly trace_id: TraceId
  readonly created_at: string
  readonly not_before: string | null
  readonly quota_class: QuotaClass
}

export type JobType =
  | 'sync.platform'
  | 'generation.content'
  | 'publish.product.update'
  | 'reconcile.publish'
  | 'delivery.export'

export type QuotaClass = 'merchant_interactive' | 'merchant_background' | 'platform_reconcile'

export function success<T>(input: Omit<ApiEnvelope<T>, 'data' | 'error'> & { data: T }): ApiEnvelope<T> {
  return { ...input, error: null }
}

export function failure<T = never>(input: Omit<ApiEnvelope<T>, 'data' | 'error'> & { error: ApiError }): ApiEnvelope<T> {
  return { ...input, data: null }
}
