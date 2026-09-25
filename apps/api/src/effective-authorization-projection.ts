import { DomainError } from '../../../packages/application/src/service.js'
import { CAPABILITIES, MCP_METHODS, canonicalizeRole, capabilitiesForRoles, getMcpMethodPolicy, type CanonicalRole, type CapabilityId, type PermissionAtom } from '../../../packages/contracts/src/index.js'
import type { RequestPrincipal } from './server.js'

interface AuthorizationProjectionDependencies {
  authorizedRoles: (principal: RequestPrincipal | undefined) => string[]
  canonicalAuthorizationRoles: (principal: RequestPrincipal | undefined, rawRoles: readonly string[]) => CanonicalRole[]
  workspaceAccountIds: (workspaceId: string) => string[]
}

export function effectiveAuthorizationProjectionWithDependencies(principal: RequestPrincipal | undefined, workspaceId: string, deps: AuthorizationProjectionDependencies) {
  const roles = deps.authorizedRoles(principal)
  const canonicalRoles = deps.canonicalAuthorizationRoles(principal, roles)
  const atoms: PermissionAtom[] = []
  if (principal?.actorId) atoms.push({ capability: 'authorization.session.read', effect: 'allow', scope: { type: 'self', ids: [principal.actorId] }, source: 'gateway_assertion', sourceId: `authenticated:${principal.identityId ?? principal.actorId}`, obligations: [], ...(principal.authorizationRevision !== undefined ? { revision: String(principal.authorizationRevision) } : {}) })
  for (const role of canonicalRoles) {
    const assignment = principal?.platformRoleAssignments?.find(item => item.role === role)
    const fromMembership = principal?.workbench === 'workspace' && principal.memberRole && canonicalizeRole(principal.memberRole, 'membership') === role
    const source = assignment ? 'platform_assignment' as const : fromMembership ? 'workspace_membership' as const : 'gateway_assertion' as const
    const sourceId = assignment?.id ?? (fromMembership ? `membership:${workspaceId}:${principal?.actorId ?? 'unknown'}` : `gateway:${role}`)
    for (const capability of capabilitiesForRoles([role])) {
      const capabilityPolicies = MCP_METHODS
        .map(method => getMcpMethodPolicy(method))
        .filter((policy): policy is NonNullable<ReturnType<typeof getMcpMethodPolicy>> => policy?.capability === capability)
      const scopes = [...new Set(capabilityPolicies.filter(policy => (
        policy.scope === 'self'
        || principal?.workbench === 'platform' && policy.scope === 'platform'
        || principal?.workbench === 'workspace' && policy.scope !== 'platform'
      )).map(policy => policy.scope))]
      // A platform role may need a capability for global navigation/projection even
      // when every executable MCP method for that capability is workspace-scoped.
      // Binding that atom to the platform scope keeps the UI truthful without
      // authorizing a workspace method: exact-scope evaluation still rejects it.
      if (scopes.length === 0 && principal?.workbench === 'platform') scopes.push(capability === 'authorization.session.read' ? 'self' : 'platform')
      else if (scopes.length === 0 && capabilityPolicies.length === 0) scopes.push(capability === 'authorization.session.read' ? 'self' : 'workspace')
      for (const scope of scopes) {
        const ids = scope === 'self' ? (principal?.actorId ? [principal.actorId] : [])
          : scope === 'platform' ? ['*']
            : scope === 'workspace' && workspaceId ? [workspaceId]
              : scope === 'account' ? deps.workspaceAccountIds(workspaceId)
              : []
        if (ids.length) atoms.push({ capability, effect: 'allow', scope: { type: scope, ids }, source, sourceId, obligations: [], ...(assignment?.expiresAt ? { expiresAt: assignment.expiresAt } : {}), ...(assignment ? { revision: String(assignment.authorizationRevision) } : {}) })
      }
    }
  }
  for (const grant of principal?.activeAuthorizationGrants ?? []) {
    const scopeEntries = Object.entries(grant.resourceScope).filter(([key]) => key.endsWith('_ids'))
    const [scopeKey, rawIds] = scopeEntries[0] ?? []
    const rawType = typeof scopeKey === 'string' ? scopeKey.slice(0, -4) : undefined
    if (scopeEntries.length !== 1 || (rawType !== 'workspace' && rawType !== 'brand' && rawType !== 'account') || !Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some(id => typeof id !== 'string' || !id.trim() || id === '*') || (rawType === 'workspace' && (rawIds.length !== 1 || rawIds[0] !== workspaceId))) {
      throw new DomainError('AUTHORIZATION_GRANT_INVALID', '持久授权 grant 的 resource_scope 无法安全解析，已拒绝使用', 503, { grant_id: grant.id })
    }
    for (const value of grant.capabilities) {
      if (!CAPABILITIES.includes(value as CapabilityId)) throw new DomainError('AUTHORIZATION_GRANT_INVALID', '持久授权 grant 包含未知 capability，已拒绝使用', 503, { grant_id: grant.id })
      atoms.push({ capability: value as CapabilityId, effect: 'allow', scope: { type: rawType, ids: rawIds as string[] }, source: 'temporary_grant', sourceId: grant.id, obligations: [], effectLimit: grant.accessMode, expiresAt: grant.expiresAt, revision: String(grant.authorizationRevision) })
    }
  }
  for (const capability of principal?.explicitDeniedCapabilities ?? []) {
    const deniedScopes = [...new Set(MCP_METHODS
      .map(method => getMcpMethodPolicy(method))
      .filter((policy): policy is NonNullable<ReturnType<typeof getMcpMethodPolicy>> => policy?.capability === capability)
      .filter(policy => policy.scope === 'self'
        || principal?.workbench === 'platform' && policy.scope === 'platform'
        || principal?.workbench === 'workspace' && policy.scope !== 'platform')
      .map(policy => policy.scope))]
    for (const scope of deniedScopes) {
      const ids = scope === 'self' ? (principal?.actorId ? [principal.actorId] : [])
        : scope === 'platform' ? ['*']
          : scope === 'workspace' && workspaceId ? [workspaceId]
            : scope === 'account' ? deps.workspaceAccountIds(workspaceId)
              : []
      if (ids.length) atoms.push({ capability, effect: 'deny', scope: { type: scope, ids }, source: 'explicit_deny', sourceId: `identity:${principal?.identityId ?? principal?.actorId ?? 'unknown'}`, obligations: [] })
    }
  }
  const deniedCapabilities = new Set(atoms.filter(atom => atom.effect === 'deny').map(atom => atom.capability))
  const allowedAtoms = atoms.filter(atom => atom.effect === 'allow' && !deniedCapabilities.has(atom.capability))
  const capabilities = [...new Set(allowedAtoms.map(atom => atom.capability))].sort()
  const scopes = [...new Map(allowedAtoms.map(atom => [`${atom.scope.type}:${atom.scope.ids.join(',')}`, atom.scope])).values()]
  return { roles, canonicalRoles, capabilities, scopes, atoms }
}
