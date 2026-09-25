import { AUTHZ_POLICY_VERSION, getMcpMethodPolicy, type AuthorizationDecision, type PermissionAtom } from '../../../packages/contracts/src/index.js'
import type { BrandAccessRole } from '../../../packages/persistence/src/index.js'

export function resolveAuthorizationResourceScope(policy: ReturnType<typeof getMcpMethodPolicy>, workspaceId: string, params: Record<string, unknown>, principal?: { actorId: string }) {
  if (!policy) return undefined
  if (policy.scope === 'platform') return { type: 'platform' as const, id: '*' }
  const exactId = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  if (policy.scope === 'workspace') return { type: 'workspace' as const, id: exactId(workspaceId) }
  if (policy.scope === 'self') return { type: 'self' as const, id: exactId(principal?.actorId) }
  if (policy.scope === 'brand') return { type: 'brand' as const, id: exactId(params.brand_id) }
  return { type: 'account' as const, id: exactId(params.account_id) }
}

export function workspaceCapabilitySourceForBrandScope(policy: NonNullable<ReturnType<typeof getMcpMethodPolicy>>, workspaceId: string, atoms: readonly PermissionAtom[]) {
  return atoms.find(atom => atom.capability === policy.capability
    && atom.effect === 'allow'
    && atom.scope.type === 'workspace'
    && atom.scope.ids.includes(workspaceId)
    && atom.source !== 'temporary_grant')
}

export function workspaceAccountPermissionAtoms(policy: NonNullable<ReturnType<typeof getMcpMethodPolicy>>, workspaceId: string, accountId: string, workspaceAccountIds: readonly string[], atoms: readonly PermissionAtom[]) {
  if (!workspaceAccountIds.includes(accountId)) return atoms
  const workspaceSource = atoms.find(atom => atom.capability === policy.capability && atom.effect === 'allow' && atom.scope.type === 'workspace' && atom.scope.ids.includes(workspaceId) && atom.source !== 'temporary_grant')
  if (!workspaceSource) return atoms
  return [...atoms, { ...workspaceSource, scope: { type: 'account' as const, ids: [accountId] }, source: 'resource_grant' as const, sourceId: `workspace-account:${workspaceId}:${accountId}` }]
}

export function minimumBrandRoleForPolicy(policy: NonNullable<ReturnType<typeof getMcpMethodPolicy>>): BrandAccessRole {
  if (policy.capability === 'customer.publish.execute') return 'publisher'
  return policy.effect === 'write' ? 'editor' : 'viewer'
}

export function authorizationDecisionAuditEvidence(decision: AuthorizationDecision, correlation: { requestId: string; traceId: string }) {
  return {
    decision_id: decision.decision_id,
    request_id: correlation.requestId,
    trace_id: correlation.traceId,
    policy_version: decision.policy_version,
    workbench: decision.workbench,
    capability: decision.capability,
    scope: decision.scope.required,
    ...(decision.scope.resource_id ? { resource_id: decision.scope.resource_id } : {}),
    resolved_scopes: decision.scope.resolved.map(scope => ({ type: scope.type, ids: [...scope.ids] })),
    result: decision.result,
    reason_code: decision.reason_code,
    explicit_deny: decision.explicit_deny,
    obligations: {
      required: [...decision.obligations.required],
      satisfied: [...decision.obligations.satisfied],
      missing: [...decision.obligations.missing],
    },
  }
}

export function authorizationDecisionRequiresAudit(decision: AuthorizationDecision) {
  return decision.enforced && (!decision.authorized || getMcpMethodPolicy(decision.method)?.audit === 'allow_and_deny')
}

const authorizationAuditIdentity = /^[^\u0000-\u001f\u007f]+$/u

export function authorizationDecisionAuditContextIsValid(decision: AuthorizationDecision, workspaceId: string, actorId: string | undefined) {
  if (!authorizationDecisionRequiresAudit(decision)) return true
  return typeof workspaceId === 'string'
    && workspaceId.trim() === workspaceId
    && workspaceId.length > 0
    && authorizationAuditIdentity.test(workspaceId)
    && typeof actorId === 'string'
    && actorId.trim() === actorId
    && actorId.length > 0
    && authorizationAuditIdentity.test(actorId)
}

export function authorizationDenialDetails(decision: AuthorizationDecision) {
  return {
    decision_id: decision.decision_id,
    capability: decision.capability,
    reason_code: decision.reason_code,
    required_scope: decision.scope.required,
    workbench: decision.workbench,
    explicit_deny: decision.explicit_deny,
    obligations_missing: [...decision.obligations.missing],
    policy_version: decision.policy_version,
  }
}

export function authorizationGrantFailureDetails(decision: AuthorizationDecision, grantId?: string) {
  return {
    decision_id: decision.decision_id,
    capability: decision.capability,
    required_scope: decision.scope.required,
    workbench: decision.workbench,
    policy_version: decision.policy_version,
    ...(grantId ? { grant_id: grantId } : {}),
  }
}

export function authorizationPolicyUnavailableDetails(input: {
  transport: 'mcp' | 'http'
  method?: string
  operation?: string
}) {
  return {
    policy_version: AUTHZ_POLICY_VERSION,
    transport: input.transport,
    ...(input.method ? { method: input.method } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
  }
}
