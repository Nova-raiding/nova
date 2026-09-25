import { DomainError } from '../../../packages/application/src/service.js'
import { AUTHZ_POLICY_VERSION, ERROR_CODES, type OpsWorkbench } from '../../../packages/contracts/src/index.js'
import type { MembersRepository } from '../../../packages/persistence/src/index.js'
import type { RequestPrincipal, effectiveAuthorizationProjection } from './server.js'

type AuthorizationProjection = ReturnType<typeof effectiveAuthorizationProjection>

export async function listWorkspaceInvitations(input: { workspaceId: string; subjects: ReadonlySet<string>; members: MembersRepository }) {
  const invitations = (await input.members.list(input.workspaceId))
    .filter(member => input.subjects.has(member.externalSubject) && member.status === 'invited')
    .map(member => ({ workspace_id: member.workspaceId, member_id: member.id, display_name: member.displayName, role: member.role, status: member.status, revision: member.revision, invited_by: member.invitedBy, created_at: member.createdAt }))
  return { invitations, unread_count: invitations.length }
}

export async function acceptWorkspaceInvitation(input: { workspaceId: string; actorId: string; subjects: ReadonlySet<string>; params: Record<string, unknown>; members: MembersRepository; expectedRevision: (params: Record<string, unknown>) => number | undefined }) {
  const member = (await input.members.list(input.workspaceId)).find(item => input.subjects.has(item.externalSubject) && item.status === 'invited')
  if (!member) throw new DomainError('INVITATION_NOT_FOUND', '没有找到发给当前账号的待接受邀请', 404)
  const expectedRevision = input.expectedRevision(input.params)
  if (expectedRevision === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '接受邀请必须提供 expected_revision', 400)
  if (expectedRevision !== member.revision) throw new DomainError('MEMBER_REVISION_CONFLICT', '邀请状态已变化，请重新查看邀请', 409)
  const accepted = await input.members.changeStatusWithAudit({ workspaceId: input.workspaceId, externalSubject: input.actorId, targetStatus: 'active', expectedRevision, actorId: input.actorId, action: 'workspace.invitation.accept', reason: typeof input.params.reason === 'string' && input.params.reason.trim() ? input.params.reason.trim() : '用户接受工作区邀请' })
  return { accepted: true, member: accepted.member }
}

export async function listOpsMembers(input: { workspaceId: string; params: Record<string, unknown>; members: MembersRepository; platformOperator: boolean; authorization: AuthorizationProjection; actorId: string }) {
  const { params, workspaceId } = input
  const hasPageParams = Object.prototype.hasOwnProperty.call(params, 'offset') || Object.prototype.hasOwnProperty.call(params, 'limit')
  const requestedLimit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 20
  const requestedOffset = typeof params.offset === 'string' && /^\d+$/u.test(params.offset) ? Number(params.offset) : 0
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 100 的整数', 400)
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 1_000_000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'offset 必须是 0 到 1000000 的整数', 400)
  const memberPage = hasPageParams && input.members.listPage
    ? await input.members.listPage(workspaceId, { offset: requestedOffset, limit: requestedLimit })
    : undefined
  const members = memberPage?.items ?? await input.members.list(workspaceId)
  const canManage = input.authorization.capabilities.includes('workspace.member.manage')
  const canAssignOwner = input.authorization.capabilities.includes('workspace.status.update')
  const activeOwnerCount = memberPage?.activeOwnerCount ?? members.filter(item => item.role === 'workspace_owner' && item.status === 'active').length
  const projected = members.map(member => {
    const protectedTarget = !input.platformOperator && (member.role === 'platform_ops' || (member.role === 'workspace_owner' && !canAssignOwner))
    const canChangeTarget = canManage && !protectedTarget
    const canDeactivateTarget = canChangeTarget && member.externalSubject !== input.actorId && !(member.role === 'workspace_owner' && member.status === 'active' && activeOwnerCount <= 1)
    return { ...member, governance: { protectedTarget, canChangeTarget, canDeactivateTarget, ...(protectedTarget ? { reasonCode: member.role === 'platform_ops' ? 'PLATFORM_ROLE_CHANGE_REQUIRES_PLATFORM_WORKBENCH' : 'WORKSPACE_OWNER_CHANGE_REQUIRES_OWNER_OR_PLATFORM' } : canDeactivateTarget ? {} : { reasonCode: member.externalSubject === input.actorId ? 'SELF_SUSPENSION_DENIED' : member.role === 'workspace_owner' && member.status === 'active' && activeOwnerCount <= 1 ? 'LAST_WORKSPACE_OWNER_REQUIRED' : undefined }) } }
  })
  return hasPageParams && memberPage ? { ...memberPage, items: projected } : projected
}

export async function getOpsSession(input: { workspaceId: string; principal: RequestPrincipal | undefined; actorId: string; authorization: AuthorizationProjection; members: MembersRepository; strictAuth: boolean }) {
  const { workspaceId, principal, actorId, authorization } = input
  const assignableRoles = authorization.capabilities.includes('workspace.member.manage')
    ? [
        ...(['merchant_admin', 'operator', 'support', 'finance'] as const),
        ...(authorization.capabilities.includes('workspace.status.update') ? ['workspace_owner' as const] : []),
        ...(principal?.workbench === 'platform' ? ['platform_ops' as const] : []),
      ]
    : []
  const authorizationRevision = principal?.authorizationRevision ?? 0
  const contextVersion = `${AUTHZ_POLICY_VERSION}:${authorizationRevision}`
  const available = new Set<OpsWorkbench>(principal?.availableWorkbenches ?? [principal?.workbench ?? 'workspace'])
  if (principal?.workbench === 'workspace' && principal.memberStatus === 'active') available.add('workspace')
  if (principal?.workbench === 'platform' && workspaceId) {
    const member = (await input.members.list(workspaceId)).find(item => item.externalSubject === actorId && item.status === 'active')
    if (member) available.add('workspace')
  }
  return { schema_version: 2, actor_id: actorId, account_login: principal?.displayAccountLogin ?? principal?.accountLogin ?? null, workspace_id: principal?.workbench === 'platform' ? null : workspaceId, workbench: principal?.workbench ?? 'workspace', available_workbenches: [...available].sort(), context_id: principal?.workbench === 'platform' ? 'platform:global' : `workspace:${workspaceId}`, context_version: contextVersion, authorization_revision: authorizationRevision, context: { id: principal?.workbench === 'platform' ? 'platform:global' : `workspace:${workspaceId}`, workbench: principal?.workbench ?? 'workspace', workspace_id: principal?.workbench === 'platform' ? null : workspaceId, access_mode: principal?.memberStatus === 'active' || principal?.workbench === 'platform' ? 'direct' : principal?.activeAuthorizationGrants?.length ? 'temporary_support' : 'direct', authorization_revision: authorizationRevision }, roles: authorization.roles, canonical_roles: authorization.canonicalRoles, capabilities: authorization.capabilities, assignable_roles: assignableRoles, denied_capabilities: principal?.explicitDeniedCapabilities ?? [], scopes: authorization.scopes, effective_permissions: authorization.atoms.map(atom => ({ capability: atom.capability, effect: atom.effect, scope: atom.scope, source: atom.source, source_id: atom.sourceId, obligations: atom.obligations, ...(atom.effectLimit ? { effect_limit: atom.effectLimit } : {}), ...(atom.expiresAt ? { expires_at: atom.expiresAt } : {}), ...(atom.revision ? { revision: atom.revision } : {}) })), temporary_grants: (principal?.activeAuthorizationGrants ?? []).map(grant => ({ id: grant.id, access_mode: grant.accessMode, workspace_id: grant.workspaceId, capabilities: grant.capabilities, resource_scope: grant.resourceScope, expires_at: grant.expiresAt, max_uses: grant.maxUses, use_count: grant.useCount, revision: grant.revision, authorization_revision: grant.authorizationRevision })), policy_version: AUTHZ_POLICY_VERSION, workspace_granted: principal?.workspaces.includes('*') || (workspaceId ? principal?.workspaces.includes(workspaceId) : false) || !input.strictAuth, identity_id: principal?.identityId ?? null, session_id: principal?.sessionId ?? null, identity_status: principal?.identityStatus ?? null, risk_decision: principal?.riskDecision ?? null, mfa_verified: principal?.mfaVerified ?? false, session_expires_at: principal?.sessionExpiresAt ?? null }
}
