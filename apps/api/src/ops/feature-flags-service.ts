import {
  FeatureFlagValidationError,
  validateFeatureFlagMutation,
  type FeatureFlagEmergencyRequest,
  type FeatureFlagEvaluationContext,
  type FeatureFlagListRequest,
  type FeatureFlagMutationRequest,
} from '../../../../packages/contracts/src/ops/feature-flags.js'
import type { FeatureFlagsRepository } from '../../../../packages/persistence/src/feature-flags-repository.js'

export type FeatureFlagOpsRole = 'platform_admin' | 'ops_admin' | 'support' | 'finance' | 'reviewer' | 'member'
export interface FeatureFlagActor {
  id: string
  roles: readonly FeatureFlagOpsRole[]
  workspaceIds?: readonly string[]
}

export class FeatureFlagAuthorizationError extends Error {
  readonly code = 'FORBIDDEN'
  constructor() { super('feature flag operation is forbidden'); this.name = 'FeatureFlagAuthorizationError' }
}

const READ_ROLES: readonly FeatureFlagOpsRole[] = ['platform_admin', 'ops_admin', 'support', 'reviewer']
const WRITE_ROLES: readonly FeatureFlagOpsRole[] = ['platform_admin', 'ops_admin']
const EMERGENCY_ROLES: readonly FeatureFlagOpsRole[] = ['platform_admin']
const hasAny = (actor: FeatureFlagActor, allowed: readonly FeatureFlagOpsRole[]) => actor.roles.some(role => allowed.includes(role))
const requireRole = (actor: FeatureFlagActor, roles: readonly FeatureFlagOpsRole[]) => { if (!actor.id.trim() || !hasAny(actor, roles)) throw new FeatureFlagAuthorizationError() }

export class FeatureFlagsService {
  constructor(private readonly repository: FeatureFlagsRepository) {}

  async list(actor: FeatureFlagActor, input: FeatureFlagListRequest = {}) {
    requireRole(actor, READ_ROLES)
    return this.repository.list(input)
  }

  async save(actor: FeatureFlagActor, raw: FeatureFlagMutationRequest) {
    requireRole(actor, WRITE_ROLES)
    const input = validateFeatureFlagMutation(raw)
    return this.repository.save({ ...input, enabled: input.enabled ?? false, targets: (input.targets ?? []).map(({ id: _untrustedId, ...target }) => target), actorId: actor.id })
  }

  async setEmergency(actor: FeatureFlagActor, input: FeatureFlagEmergencyRequest) {
    requireRole(actor, EMERGENCY_ROLES)
    if (!input.id.trim()) throw new FeatureFlagValidationError('FEATURE_FLAG_ID_REQUIRED')
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new FeatureFlagValidationError('FEATURE_FLAG_REVISION_INVALID')
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new FeatureFlagValidationError('FEATURE_FLAG_IDEMPOTENCY_KEY_INVALID')
    if (input.reason.trim().length < 3 || input.reason.length > 500) throw new FeatureFlagValidationError('FEATURE_FLAG_REASON_INVALID')
    return this.repository.setEmergency({ ...input, actorId: actor.id })
  }

  async events(actor: FeatureFlagActor, flagId: string, limit?: number) {
    requireRole(actor, READ_ROLES)
    if (!flagId.trim()) throw new FeatureFlagValidationError('FEATURE_FLAG_ID_REQUIRED')
    return this.repository.listEvents(flagId, limit)
  }

  async evaluate(actor: FeatureFlagActor, input: FeatureFlagEvaluationContext) {
    if (!actor.id.trim()) throw new FeatureFlagAuthorizationError()
    const isPlatformOperator = hasAny(actor, READ_ROLES)
    if (input.identityId && input.identityId !== actor.id && !isPlatformOperator) throw new FeatureFlagAuthorizationError()
    if (input.workspaceId && !isPlatformOperator && !actor.workspaceIds?.includes(input.workspaceId)) throw new FeatureFlagAuthorizationError()
    if (!input.flagKey.trim() || !input.environment.trim()) throw new FeatureFlagValidationError('FEATURE_FLAG_EVALUATION_CONTEXT_INVALID')
    return this.repository.evaluate(input)
  }
}
