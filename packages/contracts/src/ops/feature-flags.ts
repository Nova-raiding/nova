export const FEATURE_FLAG_VALUE_TYPES = ['boolean', 'string', 'number', 'json'] as const
export const FEATURE_FLAG_TARGET_TYPES = ['identity', 'workspace', 'percentage'] as const
export const FEATURE_FLAG_ENVIRONMENTS = ['development', 'staging', 'production'] as const
export const FEATURE_FLAG_MAX_VALUE_BYTES = 16 * 1024

export type FeatureFlagValueType = typeof FEATURE_FLAG_VALUE_TYPES[number]
export type FeatureFlagTargetType = typeof FEATURE_FLAG_TARGET_TYPES[number]
export type FeatureFlagEnvironment = typeof FEATURE_FLAG_ENVIRONMENTS[number] | (string & {})
export type FeatureFlagJson = Record<string, unknown> | unknown[]
export type FeatureFlagValue = boolean | string | number | FeatureFlagJson

export interface TypedFeatureFlagValue {
  type: FeatureFlagValueType
  value: FeatureFlagValue
}

export interface FeatureFlagTarget {
  id?: string
  type: FeatureFlagTargetType
  /** identity/workspace id, or basis points in the inclusive range 0..10000 */
  value: string
  enabled: boolean
  override?: TypedFeatureFlagValue
}

export interface FeatureFlag {
  id: string
  key: string
  environment: FeatureFlagEnvironment
  description: string
  defaultValue: TypedFeatureFlagValue
  enabled: boolean
  emergencyDisabled: boolean
  targets: FeatureFlagTarget[]
  validFrom?: string
  validTo?: string
  revision: number
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export interface FeatureFlagEvent {
  id: string
  flagId: string
  eventType: 'created' | 'updated' | 'emergency_disabled' | 'emergency_restored'
  actorId: string
  reason: string
  idempotencyKey: string
  before?: FeatureFlag
  after: FeatureFlag
  createdAt: string
}

export interface FeatureFlagListRequest {
  environment?: string
  query?: string
  cursor?: string
  limit?: number
}

export interface FeatureFlagPage {
  items: FeatureFlag[]
  nextCursor?: string
}

export interface FeatureFlagMutationRequest {
  id?: string
  key: string
  environment: string
  description: string
  defaultValue: TypedFeatureFlagValue
  enabled?: boolean
  targets?: FeatureFlagTarget[]
  validFrom?: string
  validTo?: string
  expectedRevision?: number
  idempotencyKey: string
  reason: string
}

export interface FeatureFlagEmergencyRequest {
  id: string
  disabled: boolean
  expectedRevision: number
  idempotencyKey: string
  reason: string
}

export interface FeatureFlagEvaluationContext {
  flagKey: string
  environment: string
  identityId?: string
  workspaceId?: string
  /** Stable subject used for percentage bucketing; identity then workspace is preferred. */
  bucketSubject?: string
  at?: string
}

export interface FeatureFlagEvaluation {
  flagKey: string
  environment: string
  enabled: boolean
  value?: FeatureFlagValue
  matchedBy: 'missing' | 'emergency' | 'disabled' | 'window' | 'identity' | 'workspace' | 'percentage' | 'default'
  revision?: number
}

export class FeatureFlagValidationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message)
    this.name = 'FeatureFlagValidationError'
  }
}

const serializedBytes = (value: unknown) => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength } catch { throw new FeatureFlagValidationError('FEATURE_FLAG_VALUE_NOT_JSON') }
}
const isPlainJson = (value: unknown, seen = new Set<object>()): value is FeatureFlagJson => {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || seen.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  seen.add(value)
  const children = Array.isArray(value) ? value : Object.values(value)
  const valid = children.every(child => child === null || typeof child === 'string' || typeof child === 'boolean' || (typeof child === 'number' && Number.isFinite(child)) || (typeof child === 'object' && isPlainJson(child, seen)))
  seen.delete(value)
  return valid
}

export function validateTypedFeatureFlagValue(input: TypedFeatureFlagValue): TypedFeatureFlagValue {
  const valid = input.type === 'boolean' ? typeof input.value === 'boolean'
    : input.type === 'string' ? typeof input.value === 'string'
      : input.type === 'number' ? typeof input.value === 'number' && Number.isFinite(input.value)
        : input.type === 'json' ? isPlainJson(input.value)
          : false
  if (!valid) throw new FeatureFlagValidationError('FEATURE_FLAG_VALUE_TYPE_MISMATCH')
  if (serializedBytes(input.value) > FEATURE_FLAG_MAX_VALUE_BYTES) throw new FeatureFlagValidationError('FEATURE_FLAG_VALUE_TOO_LARGE')
  return structuredClone(input)
}

export function validateFeatureFlagTarget(target: FeatureFlagTarget, expectedType: FeatureFlagValueType): FeatureFlagTarget {
  if (!FEATURE_FLAG_TARGET_TYPES.includes(target.type)) throw new FeatureFlagValidationError('FEATURE_FLAG_TARGET_TYPE_INVALID')
  if (!target.value.trim() || target.value.length > 255) throw new FeatureFlagValidationError('FEATURE_FLAG_TARGET_VALUE_INVALID')
  if (target.type === 'percentage' && (!/^\d+$/.test(target.value) || Number(target.value) < 0 || Number(target.value) > 10000)) {
    throw new FeatureFlagValidationError('FEATURE_FLAG_PERCENTAGE_INVALID')
  }
  if (target.override) {
    validateTypedFeatureFlagValue(target.override)
    if (target.override.type !== expectedType) throw new FeatureFlagValidationError('FEATURE_FLAG_OVERRIDE_TYPE_MISMATCH')
  }
  return structuredClone(target)
}

export function validateFeatureFlagMutation(input: FeatureFlagMutationRequest): FeatureFlagMutationRequest {
  if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(input.key)) throw new FeatureFlagValidationError('FEATURE_FLAG_KEY_INVALID')
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(input.environment)) throw new FeatureFlagValidationError('FEATURE_FLAG_ENVIRONMENT_INVALID')
  if (input.description.trim().length < 1 || input.description.length > 500) throw new FeatureFlagValidationError('FEATURE_FLAG_DESCRIPTION_INVALID')
  if (input.reason.trim().length < 3 || input.reason.length > 500) throw new FeatureFlagValidationError('FEATURE_FLAG_REASON_INVALID')
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new FeatureFlagValidationError('FEATURE_FLAG_IDEMPOTENCY_KEY_INVALID')
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new FeatureFlagValidationError('FEATURE_FLAG_REVISION_INVALID')
  validateTypedFeatureFlagValue(input.defaultValue)
  const targetKeys = new Set<string>()
  for (const target of input.targets ?? []) {
    validateFeatureFlagTarget(target, input.defaultValue.type)
    const key = `${target.type}:${target.value}`
    if (targetKeys.has(key)) throw new FeatureFlagValidationError('FEATURE_FLAG_TARGET_DUPLICATE')
    targetKeys.add(key)
  }
  const from = input.validFrom ? Date.parse(input.validFrom) : undefined
  const to = input.validTo ? Date.parse(input.validTo) : undefined
  if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to)) || (from !== undefined && to !== undefined && to <= from)) {
    throw new FeatureFlagValidationError('FEATURE_FLAG_VALIDITY_INVALID')
  }
  return structuredClone({ ...input, enabled: input.enabled ?? false, targets: input.targets ?? [] })
}
