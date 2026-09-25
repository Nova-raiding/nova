import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { AUTHZ_POLICY_VERSION, CANONICAL_ROLES, CAPABILITIES, MCP_METHODS, MCP_METHOD_POLICIES, ERROR_CODES, type CanonicalRole, type CapabilityId } from '../../../packages/contracts/src/index.js'
import { PLATFORM_ASSIGNED_ROLES, type AuthorizationRepository, type PlatformAssignedRole } from '../../../packages/persistence/src/index.js'

type Dependencies = {
  authorizationRepository: () => AuthorizationRepository | undefined
  canonicalRoleMethodAccess: (role: CanonicalRole, policy: (typeof MCP_METHOD_POLICIES)[keyof typeof MCP_METHOD_POLICIES]) => 'hidden' | 'read' | 'govern' | 'operate'
  requestActor: (req: IncomingMessage) => string
  verifiedApprovalActor: (params: Record<string, unknown>, req: IncomingMessage, workspaceId: string) => string | undefined
  requiresStrictAuth: () => boolean
  required: (params: Record<string, unknown>, key: string) => string
}

export const MCP_OPS_AUTHORIZATION_METHODS = new Set([
  'ops.authorization.matrix.get', 'ops.authorization.roles.list',
  'ops.authorization.role.assign', 'ops.authorization.role.revoke',
  'ops.authorization.grants.list', 'ops.authorization.grant.issue',
  'ops.authorization.grant.revoke',
])

/** Returns the MCP value while the caller retains transport-specific response handling. */
export async function handleMcpOpsAuthorizationMethod(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, dependencies: Dependencies): Promise<unknown> {
  const { authorizationRepository, canonicalRoleMethodAccess, requestActor, verifiedApprovalActor, requiresStrictAuth, required } = dependencies
  if (method === 'ops.authorization.matrix.get') {
      const roles = [...CANONICAL_ROLES]
      const assignableRoles = PLATFORM_ASSIGNED_ROLES.filter(role => role !== 'platform_owner')
      const items = MCP_METHODS.map(method => {
        const policy = MCP_METHOD_POLICIES[method]
        return {
          method,
          capability: policy.capability,
          workbench: policy.workbench,
          scope: policy.scope,
          data_class: policy.dataClass,
          effect: policy.effect,
          audit: policy.audit,
          obligations: [...policy.obligations],
          role_access: Object.fromEntries(roles.map(role => [role, canonicalRoleMethodAccess(role, policy)])),
        }
      })
      return ({ schema_version: 1, policy_version: AUTHZ_POLICY_VERSION, generated_from: 'MCP_METHOD_POLICIES', method_count: items.length, role_count: roles.length, roles, assignable_roles: assignableRoles, items })
    }
  if (method === 'ops.authorization.roles.list') {
      const repository = authorizationRepository()
      if (!repository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '持久授权仓储未配置', 503)
      const subjectIdentityId = required(params, 'subject_identity_id')
      return ({ subject_identity_id: subjectIdentityId, authorization_revision: await repository.getAuthorizationRevision(subjectIdentityId), assignments: await repository.listActivePlatformRoles(subjectIdentityId) })
    }
  if (method === 'ops.authorization.role.assign') {
      const repository = authorizationRepository()
      if (!repository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '持久授权仓储未配置', 503)
      const role = required(params, 'role')
      if (!PLATFORM_ASSIGNED_ROLES.includes(role as PlatformAssignedRole) || role === 'platform_owner') throw new DomainError('AUTHZ_PLATFORM_ROLE_UNSUPPORTED', '该平台角色不能通过日常运营入口分配', 400)
      return (await repository.assignPlatformRole({ subjectIdentityId: required(params, 'subject_identity_id'), role: role as PlatformAssignedRole, assignedBy: requestActor(req), reason: required(params, 'reason'), expectedAuthorizationRevision: Number(required(params, 'expected_authorization_revision')), ...(typeof params.expires_at === 'string' && params.expires_at.trim() ? { expiresAt: params.expires_at.trim() } : {}) }))
    }
  if (method === 'ops.authorization.role.revoke') {
      const repository = authorizationRepository()
      if (!repository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '持久授权仓储未配置', 503)
      return (await repository.revokePlatformRole({ id: required(params, 'assignment_id'), subjectIdentityId: required(params, 'subject_identity_id'), actorId: requestActor(req), reason: required(params, 'reason'), expectedRevision: Number(required(params, 'expected_revision')), expectedAuthorizationRevision: Number(required(params, 'expected_authorization_revision')) }))
    }
  if (method === 'ops.authorization.grants.list') {
      const repository = authorizationRepository()
      if (!repository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '持久授权仓储未配置', 503)
      const subjectIdentityId = required(params, 'subject_identity_id')
      const targetWorkspaceId = required(params, 'target_workspace_id')
      return ({ subject_identity_id: subjectIdentityId, workspace_id: targetWorkspaceId, authorization_revision: await repository.getAuthorizationRevision(subjectIdentityId), grants: await repository.listActiveGrants(subjectIdentityId, targetWorkspaceId) })
    }
  if (method === 'ops.authorization.grant.issue') {
      const repository = authorizationRepository()
      if (!repository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '持久授权仓储未配置', 503)
      let capabilities: string[]
      let resourceScope: Record<string, unknown>
      try {
        const parsedCapabilities: unknown = JSON.parse(required(params, 'capabilities_json'))
        const parsedScope: unknown = JSON.parse(required(params, 'resource_scope_json'))
        if (!Array.isArray(parsedCapabilities) || parsedCapabilities.some(value => typeof value !== 'string' || !CAPABILITIES.includes(value as CapabilityId)) || !parsedScope || typeof parsedScope !== 'object' || Array.isArray(parsedScope)) throw new Error('invalid grant payload')
        capabilities = parsedCapabilities as string[]
        resourceScope = parsedScope as Record<string, unknown>
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'JIT capability 或 resource scope JSON 无效', 400) }
      const targetWorkspaceId = required(params, 'target_workspace_id')
      if (!Array.isArray(resourceScope.workspace_ids) || resourceScope.workspace_ids.length !== 1 || resourceScope.workspace_ids[0] !== targetWorkspaceId || Object.keys(resourceScope).some(key => key.endsWith('_ids') && key !== 'workspace_ids')) throw new DomainError('AUTHORIZATION_GRANT_INVALID', 'JIT 必须精确绑定一个目标工作区', 400)
      const grantKind = required(params, 'grant_kind')
      const accessMode = required(params, 'access_mode')
      if ((grantKind !== 'temporary' && grantKind !== 'support') || (accessMode !== 'read' && accessMode !== 'write')) throw new DomainError('AUTHORIZATION_GRANT_INVALID', 'JIT 类型或读写模式无效', 400)
      // `approved_by` is not a request field to store: it is the maker-checker
      // evidence that an independent approver existed and was entitled to this
      // target workspace, and it becomes an immutable row in `ops_access_grants`
      // plus the `ops_access_grant_events` audit stream. Writing the caller's
      // claim here is what let any operator reach this method and persist
      // someone else's name as the record of an approval, so the value written
      // is the one `verifiedApprovalActor` resolves from the server-issued
      // `x-authorization-approval-token` grant — the same evidence the
      // `approval` obligation is decided from. Under enforced authentication the
      // credential is mandatory at the sink, exactly as `parseApprovalGrant`
      // demands `x-rule-approval-token` under `requiresStrictAuth()`: this is a
      // refusal to record unverified evidence, not a second enforcement line, so
      // it also holds for a shadow-mode deployment whose policy merely observes
      // the missing obligation. When authentication is not enforced there is no
      // authenticated identity to record at all — `issuedBy` below is likewise
      // `requestActor`, i.e. the caller's `x-actor-id` header or the `merchant`
      // fallback — and the claimed approver is retained there as
      // `parseApprovalGrant` retains it.
      const verifiedApprover = verifiedApprovalActor(params, req, targetWorkspaceId)
      if (!verifiedApprover && requiresStrictAuth()) throw new DomainError('AUTHORIZATION_APPROVAL_REQUIRED', '严格认证环境签发 JIT 授权必须携带有效的 X-Authorization-Approval-Token', 409)
      const approvedBy = verifiedApprover ?? required(params, 'approved_by')
      // The token grant proves WHO approved, not WHEN: it carries only the actor
      // id and the workspaces it may approve. The approval time therefore stays
      // the approval act's own recorded time, but only as a claim the server can
      // bound — it must parse and it may not postdate the server's observation of
      // the credential. A claim that fails either bound is replaced by that
      // observed instant instead of being persisted as an unverified string; the
      // repository and `CHECK (approved_at <= issued_at)` re-validate it against
      // the issuance clock afterwards.
      const observedAt = new Date().toISOString()
      const claimedAt = required(params, 'approved_at')
      const claimedInstant = Date.parse(claimedAt)
      const approvedAt = Number.isFinite(claimedInstant) && claimedInstant <= Date.parse(observedAt) ? claimedAt : observedAt
      return (await repository.issueGrant({ grantKind, accessMode, subjectIdentityId: required(params, 'subject_identity_id'), workspaceId: targetWorkspaceId, capabilities, resourceScope, reason: required(params, 'reason'), ticketRef: required(params, 'ticket_ref'), issuedBy: requestActor(req), approvedBy, approvedAt, expectedAuthorizationRevision: Number(required(params, 'expected_authorization_revision')), expiresAt: required(params, 'expires_at'), maxUses: Number(required(params, 'max_uses')) }))
    }
  if (method === 'ops.authorization.grant.revoke') {
      const repository = authorizationRepository()
      if (!repository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '持久授权仓储未配置', 503)
      return (await repository.revokeGrant({ id: required(params, 'grant_id'), subjectIdentityId: required(params, 'subject_identity_id'), actorId: requestActor(req), reason: required(params, 'reason'), expectedRevision: Number(required(params, 'expected_revision')), expectedAuthorizationRevision: Number(required(params, 'expected_authorization_revision')) }))
    }
  throw new Error(`Unsupported authorization MCP method: ${method}`)
}
