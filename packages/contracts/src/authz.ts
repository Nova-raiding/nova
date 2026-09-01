import { exposeNonProductionMethods, MCP_METHODS, MCP_NON_PRODUCTION_METHODS, type McpMethod } from './mcp.js'

export const AUTHZ_POLICY_VERSION = '2026-08-31.v2' as const

export const CAPABILITIES = [
  'authorization.session.read',
  'authorization.role.read',
  'authorization.role.manage',
  'authorization.grant.read',
  'authorization.grant.manage',
  'merchant.onboarding.execute',
  'workspace.summary.read',
  'workspace.settings.update',
  'workspace.status.update',
  'workspace.delete.execute',
  'workspace.member.read',
  'workspace.member.manage',
  'workspace.directory.read',
  'identity.read',
  'identity.update',
  'identity.session.revoke',
  'support.ticket.read',
  'support.ticket.update',
  'support.sla.update',
  'support.sla.approve',
  'support.customer.export',
  'incident.read',
  'incident.update',
  'incident.administer',
  'feature_flag.read',
  'feature_flag.update',
  'feature_flag.administer',
  'audit.read',
  'audit.export',
  'billing.self.read',
  'billing.workspace.read',
  'billing.workspace.update',
  'billing.platform.read',
  'billing.reconcile.execute',
  'billing.refund.execute',
  'billing.export',
  'commercial.read',
  'commercial.update',
  'commercial.export',
  'platform.summary.read',
  'platform.settings.read',
  'platform.settings.update',
  'platform.media_spec.read',
  'platform.media_spec.update',
  'platform.media_spec.approve',
  'model.status.read',
  'model.cost.read',
  'model.policy.update',
  'store.connection.read',
  'store.connection.update',
  'customer.content.read',
  'customer.content.update',
  'customer.publish.execute',
  'rule.read',
  'rule.update',
  'rule.publish.approve',
  'automation.read',
  'automation.update',
  'marketing.summary.read',
  'marketing.alert.update',
  'marketing.queue.read',
  'marketing.queue.update',
  'storage.reconciliation.read',
  'canonical.backfill.read',
  'canonical.backfill.update',
] as const

export type CapabilityId = typeof CAPABILITIES[number]
export type OpsWorkbench = 'platform' | 'workspace'
export type AuthorizationScopeType = 'self' | 'workspace' | 'brand' | 'account' | 'platform'
export type AuthorizationDataClass = 'platform_summary' | 'customer_metadata' | 'customer_content' | 'finance' | 'secret_metadata'
export type AuthorizationEffect = 'read' | 'write'
export type AuthorizationAudit = 'deny_only' | 'allow_and_deny' | 'mutation'
export type AuthorizationObligation = 'reason' | 'revision' | 'idempotency' | 'confirmation' | 'mfa' | 'approval'
export type AuthorizationDecisionMode = 'shadow' | 'enforce'
export type AuthorizationDecisionReason = 'AUTHZ_ALLOWED' | 'AUTHZ_CAPABILITY_MISSING' | 'AUTHZ_SCOPE_MISMATCH' | 'AUTHZ_WORKBENCH_MISMATCH' | 'AUTHZ_EXPLICIT_DENY' | 'AUTHZ_OBLIGATION_REQUIRED'
export type PermissionAtomSource = 'platform_assignment' | 'workspace_membership' | 'resource_grant' | 'temporary_grant' | 'gateway_assertion' | 'explicit_deny'

export interface PermissionAtom {
  capability: CapabilityId
  effect: 'allow' | 'deny'
  scope: { type: AuthorizationScopeType; ids: readonly string[] }
  source: PermissionAtomSource
  sourceId: string
  obligations: readonly AuthorizationObligation[]
  effectLimit?: AuthorizationEffect
  expiresAt?: string
  revokedAt?: string
  revision?: string
}

export interface MethodPolicy {
  method: McpMethod
  capability: CapabilityId
  workbench: OpsWorkbench
  scope: AuthorizationScopeType
  dataClass: AuthorizationDataClass
  effect: AuthorizationEffect
  audit: AuthorizationAudit
  obligations: readonly AuthorizationObligation[]
}

export interface AuthorizationDecision {
  decision_id: string
  policy_version: typeof AUTHZ_POLICY_VERSION
  method: McpMethod
  capability: CapabilityId
  workbench: OpsWorkbench
  scope: { required: AuthorizationScopeType; resource_id?: string; resolved: readonly { type: AuthorizationScopeType; ids: readonly string[] }[] }
  mode: AuthorizationDecisionMode
  enforced: boolean
  authorized: boolean
  allowed: boolean
  result: 'allow' | 'deny' | 'shadow_allow' | 'shadow_deny'
  reason_code: AuthorizationDecisionReason
  explicit_deny: boolean
  obligations: { required: readonly AuthorizationObligation[]; satisfied: readonly AuthorizationObligation[]; missing: readonly AuthorizationObligation[] }
}

export function evaluateAuthorizationDecision(input: {
  decisionId: string
  policy: MethodPolicy
  capabilities: readonly CapabilityId[]
  scopes: readonly { type: AuthorizationScopeType; ids: readonly string[] }[]
  explicitDenies?: readonly CapabilityId[]
  satisfiedObligations?: readonly AuthorizationObligation[]
  resourceScope?: { type: AuthorizationScopeType; id?: string }
  workbench: OpsWorkbench
  mode: AuthorizationDecisionMode
}): AuthorizationDecision {
  const explicitDeny = input.explicitDenies?.includes(input.policy.capability) === true
  const capabilityMatched = input.capabilities.includes(input.policy.capability)
  const resourceId = input.resourceScope?.id
  const workbenchMatched = input.policy.scope === 'self'
    || input.workbench === 'platform' && input.policy.scope === 'platform'
    || input.workbench === 'workspace' && input.policy.scope !== 'platform'
  const scopeMatched = input.resourceScope?.type === input.policy.scope && input.scopes.some(scope => scope.type === input.policy.scope && (
    scope.type === 'platform' && scope.ids.includes('*')
      || resourceId !== undefined && (scope.ids.includes(resourceId) || scope.ids.includes('*'))
  ))
  const required = [...new Set(input.policy.obligations)]
  const satisfied = [...new Set(input.satisfiedObligations ?? [])].filter(obligation => required.includes(obligation))
  const missing = required.filter(obligation => !satisfied.includes(obligation))
  const reasonCode: AuthorizationDecisionReason = explicitDeny ? 'AUTHZ_EXPLICIT_DENY'
    : !workbenchMatched ? 'AUTHZ_WORKBENCH_MISMATCH'
      : !capabilityMatched ? 'AUTHZ_CAPABILITY_MISSING'
      : !scopeMatched ? 'AUTHZ_SCOPE_MISMATCH'
        : missing.length ? 'AUTHZ_OBLIGATION_REQUIRED'
          : 'AUTHZ_ALLOWED'
  const authorized = reasonCode === 'AUTHZ_ALLOWED'
  // Principal-level explicit denies are hard safety boundaries. Shadow mode
  // may observe ordinary migration gaps, but it must never override a deny
  // attached to the authenticated principal.
  const enforced = input.mode === 'enforce' || explicitDeny || !workbenchMatched
  return Object.freeze({
    decision_id: input.decisionId,
    policy_version: AUTHZ_POLICY_VERSION,
    method: input.policy.method,
    capability: input.policy.capability,
    workbench: input.workbench,
    scope: { required: input.policy.scope, ...(resourceId ? { resource_id: resourceId } : {}), resolved: input.scopes.map(scope => ({ type: scope.type, ids: [...scope.ids] })) },
    mode: input.mode,
    enforced,
    authorized,
    allowed: authorized || !enforced,
    result: authorized ? (enforced ? 'allow' : 'shadow_allow') : enforced ? 'deny' : 'shadow_deny',
    reason_code: reasonCode,
    explicit_deny: explicitDeny,
    obligations: { required, satisfied, missing },
  })
}

export function evaluatePermissionAtoms(input: {
  decisionId: string
  policy: MethodPolicy
  atoms: readonly PermissionAtom[]
  satisfiedObligations?: readonly AuthorizationObligation[]
  resourceScope?: { type: AuthorizationScopeType; id?: string }
  workbench: OpsWorkbench
  mode: AuthorizationDecisionMode
  now?: string
}): AuthorizationDecision {
  const now = input.now === undefined ? Date.now() : Date.parse(input.now)
  const usable = Number.isFinite(now) ? input.atoms.filter(atom => {
    if (atom.revokedAt !== undefined) return false
    if (atom.expiresAt !== undefined) {
      const expiresAt = Date.parse(atom.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return false
    }
    if (atom.scope.ids.length === 0 || atom.scope.ids.some(id => id.length === 0 || /[\u0000-\u001f\u007f]/.test(id))) return false
    // Resource grants must identify exact resources. Only platform-level
    // assignments may use the aggregate wildcard.
    if ((atom.source === 'resource_grant' || atom.source === 'temporary_grant') && atom.scope.ids.includes('*')) return false
    return true
  }) : []
  const relevant = usable.filter(atom => atom.capability === input.policy.capability && (atom.effect !== 'allow' || input.policy.effect === 'read' || atom.effectLimit !== 'read'))
  return evaluateAuthorizationDecision({
    decisionId: input.decisionId,
    policy: input.policy,
    capabilities: relevant.filter(atom => atom.effect === 'allow').map(atom => atom.capability),
    scopes: relevant.filter(atom => atom.effect === 'allow').map(atom => atom.scope),
    explicitDenies: relevant.some(atom => atom.effect === 'deny') ? [input.policy.capability] : [],
    satisfiedObligations: input.satisfiedObligations,
    resourceScope: input.resourceScope,
    workbench: input.workbench,
    mode: input.mode,
  })
}

export const CANONICAL_ROLES = [
  'platform_admin', 'ops_admin', 'support_agent', 'finance_ops', 'security_admin', 'auditor',
  'rules_admin', 'model_admin', 'release_admin', 'workspace_owner', 'workspace_admin', 'operator',
  'workspace_support', 'reviewer', 'finance', 'viewer', 'knowledge_editor', 'knowledge_reader',
  'competitor_reviewer',
] as const
export type CanonicalRole = typeof CANONICAL_ROLES[number]

const gatewayRoleAliases: Readonly<Record<string, CanonicalRole>> = {
  platform_ops: 'ops_admin',
  platform_admin: 'platform_admin',
  ops_admin: 'ops_admin',
  support: 'support_agent',
  platform_support: 'support_agent',
  finance: 'finance_ops',
  platform_finance: 'finance_ops',
  security_admin: 'security_admin',
  auditor: 'auditor',
  rules_admin: 'rules_admin',
  platform_rules_admin: 'rules_admin',
  model_admin: 'model_admin',
  platform_model_admin: 'model_admin',
  release_admin: 'release_admin',
  platform_release_admin: 'release_admin',
  workspace_owner: 'workspace_owner',
  merchant_admin: 'workspace_admin',
  workspace_admin: 'workspace_admin',
  operator: 'operator',
  merchant_operator: 'operator',
  reviewer: 'reviewer',
  finance_ops: 'finance_ops',
  knowledge_editor: 'knowledge_editor',
  knowledge_reader: 'knowledge_reader',
  competitor_reviewer: 'competitor_reviewer',
}

const memberRoleAliases: Readonly<Record<string, CanonicalRole>> = {
  workspace_owner: 'workspace_owner',
  merchant_admin: 'workspace_admin',
  workspace_admin: 'workspace_admin',
  operator: 'operator',
  merchant_operator: 'operator',
  support: 'workspace_support',
  finance: 'finance',
}

export function canonicalizeRole(role: string, source: 'gateway' | 'membership' = 'gateway'): CanonicalRole | undefined {
  return (source === 'membership' ? memberRoleAliases : gatewayRoleAliases)[role]
}

export function resolveCanonicalRoles(input: { gatewayRoles?: readonly string[]; memberRole?: string }): CanonicalRole[] {
  const roles = new Set<CanonicalRole>()
  for (const role of input.gatewayRoles ?? []) {
    const canonical = canonicalizeRole(role, 'gateway')
    if (canonical) roles.add(canonical)
  }
  if (input.memberRole) {
    const canonical = canonicalizeRole(input.memberRole, 'membership')
    if (canonical) roles.add(canonical)
  }
  return [...roles].sort()
}

const tenantRead: readonly CapabilityId[] = [
  'workspace.summary.read', 'workspace.member.read', 'billing.self.read', 'billing.workspace.read',
  'store.connection.read', 'customer.content.read', 'rule.read', 'automation.read', 'audit.read', 'platform.media_spec.read', 'model.status.read',
]
const tenantOperate: readonly CapabilityId[] = [
  ...tenantRead, 'workspace.settings.update', 'store.connection.update', 'customer.content.update',
  'customer.publish.execute', 'automation.update', 'marketing.queue.read', 'marketing.queue.update', 'billing.workspace.update', 'merchant.onboarding.execute',
]
const platformRead: readonly CapabilityId[] = [
  'platform.summary.read', 'workspace.directory.read', 'marketing.summary.read', 'model.status.read',
  'model.cost.read', 'storage.reconciliation.read', 'audit.read', 'commercial.read', 'feature_flag.read',
  'incident.read', 'support.ticket.read', 'platform.settings.read', 'platform.media_spec.read', 'automation.read',
]

export const ROLE_CAPABILITIES: Readonly<Record<CanonicalRole, readonly CapabilityId[]>> = {
  platform_admin: [...platformRead, 'authorization.role.read', 'authorization.role.manage', 'authorization.grant.read', 'authorization.grant.manage', 'identity.read', 'identity.update', 'identity.session.revoke', 'workspace.status.update', 'workspace.delete.execute', 'feature_flag.update', 'feature_flag.administer', 'audit.export'],
  // P0 compatibility: legacy platform_ops resolves here, so existing identity/member/delete
  // enforcement remains intact until durable platform-role assignments replace that alias.
  ops_admin: [...platformRead, 'authorization.role.read', 'authorization.grant.read', 'authorization.grant.manage', 'identity.read', 'identity.update', 'identity.session.revoke', 'workspace.delete.execute', 'workspace.member.read', 'workspace.member.manage', 'support.ticket.update', 'support.sla.update', 'support.sla.approve', 'support.customer.export', 'incident.update', 'incident.administer', 'feature_flag.update', 'commercial.update', 'commercial.export', 'platform.settings.update', 'platform.media_spec.update', 'platform.media_spec.approve', 'billing.platform.read', 'billing.reconcile.execute', 'billing.export', 'canonical.backfill.read', 'canonical.backfill.update', 'marketing.alert.update', 'store.connection.update'],
  support_agent: ['platform.summary.read', 'workspace.directory.read', 'support.ticket.read', 'support.ticket.update', 'support.sla.update', 'support.customer.export', 'incident.read', 'incident.update', 'audit.read', 'feature_flag.read'],
  finance_ops: ['platform.summary.read', 'workspace.directory.read', 'billing.platform.read', 'billing.reconcile.execute', 'billing.refund.execute', 'billing.export', 'model.cost.read', 'commercial.read', 'audit.read'],
  security_admin: ['authorization.role.read', 'authorization.role.manage', 'authorization.grant.read', 'authorization.grant.manage', 'identity.read', 'identity.update', 'identity.session.revoke', 'audit.read', 'audit.export', 'feature_flag.read'],
  auditor: [...platformRead, 'audit.export'],
  rules_admin: ['rule.read', 'rule.update', 'rule.publish.approve', 'platform.media_spec.read', 'platform.media_spec.update', 'platform.media_spec.approve', 'audit.read', 'identity.read', 'billing.export'],
  model_admin: ['platform.summary.read', 'model.status.read', 'model.cost.read', 'model.policy.update', 'audit.read'],
  release_admin: ['platform.summary.read', 'feature_flag.read', 'feature_flag.update', 'feature_flag.administer', 'incident.read', 'incident.update', 'audit.read'],
  workspace_owner: [...tenantOperate, 'workspace.member.manage', 'workspace.status.update', 'workspace.delete.execute', 'billing.workspace.update', 'billing.refund.execute', 'billing.export', 'commercial.update'],
  workspace_admin: [...tenantOperate, 'workspace.member.manage', 'workspace.delete.execute', 'billing.workspace.update', 'billing.refund.execute', 'billing.export', 'commercial.update'],
  operator: [...tenantOperate, 'billing.export'],
  workspace_support: [...tenantRead, 'support.ticket.read', 'support.ticket.update', 'support.sla.update', 'incident.read', 'marketing.queue.read', 'billing.export'],
  reviewer: [...tenantRead, 'rule.update', 'rule.publish.approve'],
  finance: ['workspace.summary.read', 'billing.self.read', 'billing.workspace.read', 'billing.workspace.update', 'billing.refund.execute', 'billing.export', 'commercial.read', 'audit.read'],
  viewer: tenantRead,
  knowledge_editor: [...tenantRead, 'customer.content.update', 'rule.update'],
  knowledge_reader: tenantRead,
  competitor_reviewer: [...tenantRead, 'customer.content.update', 'rule.publish.approve'],
}

export function capabilitiesForRoles(roles: readonly CanonicalRole[]): CapabilityId[] {
  const capabilities = new Set<CapabilityId>(roles.length ? ['authorization.session.read'] : [])
  for (const role of roles) for (const capability of ROLE_CAPABILITIES[role]) capabilities.add(capability)
  return [...capabilities].sort()
}

type PolicyDefaults = Omit<MethodPolicy, 'method'>
type PolicyGroup = PolicyDefaults & { methods: readonly McpMethod[] }
const read = (capability: CapabilityId, scope: AuthorizationScopeType, dataClass: AuthorizationDataClass, methods: readonly McpMethod[], audit: AuthorizationAudit = 'deny_only', obligations: readonly AuthorizationObligation[] = []): PolicyGroup => ({ methods, capability, scope, workbench: scope === 'platform' ? 'platform' : 'workspace', dataClass, effect: 'read', audit, obligations })
const write = (capability: CapabilityId, scope: AuthorizationScopeType, dataClass: AuthorizationDataClass, methods: readonly McpMethod[], audit: AuthorizationAudit = 'mutation', obligations: readonly AuthorizationObligation[] = []): PolicyGroup => ({ methods, capability, scope, workbench: scope === 'platform' ? 'platform' : 'workspace', dataClass, effect: 'write', audit, obligations })

// Every current method is named in exactly one group. Prefix or wildcard fallbacks are intentionally forbidden.
const POLICY_GROUPS: readonly PolicyGroup[] = [
  write('merchant.onboarding.execute', 'workspace', 'customer_metadata', ['merchant.start', 'merchant.first_value', 'workspace.bootstrap', 'workspace.interactive.confirm']),
  read('workspace.summary.read', 'workspace', 'customer_metadata', ['workspace.health', 'workspace.metrics', 'workspace.commercial.get', 'workspace.usage.get']),
  write('workspace.settings.update', 'workspace', 'customer_metadata', ['workspace.commercial.update']),
  write('workspace.status.update', 'workspace', 'customer_metadata', ['workspace.deactivate', 'workspace.activate']),
  read('workspace.delete.execute', 'workspace', 'customer_metadata', ['ops.data.delete.list']),
  write('workspace.delete.execute', 'workspace', 'customer_metadata', ['workspace.data.delete.request'], 'mutation', ['reason', 'idempotency']),
  write('workspace.delete.execute', 'workspace', 'customer_metadata', ['ops.data.delete.cancel', 'ops.data.delete.approve'], 'mutation', ['reason']),
  read('workspace.directory.read', 'platform', 'platform_summary', ['ops.workspaces.list', 'ops.stores.list', 'ops.brand-units.summary', 'ops.tasks.summary', 'ops.growth.funnel']),
  read('authorization.session.read', 'self', 'secret_metadata', ['ops.session']),
  read('authorization.role.read', 'platform', 'secret_metadata', ['ops.authorization.matrix.get']),
  read('authorization.role.read', 'platform', 'secret_metadata', ['ops.authorization.roles.list']),
  write('authorization.role.manage', 'platform', 'secret_metadata', ['ops.authorization.role.assign', 'ops.authorization.role.revoke'], 'mutation', ['reason', 'revision']),
  read('authorization.grant.read', 'platform', 'secret_metadata', ['ops.authorization.grants.list']),
  write('authorization.grant.manage', 'platform', 'secret_metadata', ['ops.authorization.grant.issue', 'ops.authorization.grant.revoke'], 'allow_and_deny', ['reason', 'revision', 'approval']),
  read('workspace.member.read', 'workspace', 'customer_metadata', ['ops.members.list']),
  write('workspace.member.manage', 'workspace', 'customer_metadata', ['ops.member.upsert', 'ops.member.suspend'], 'mutation', ['reason']),
  read('identity.read', 'platform', 'secret_metadata', ['ops.users.list', 'ops.user.detail']),
  write('identity.update', 'platform', 'secret_metadata', ['ops.user.suspend', 'ops.user.activate', 'ops.user.risk.transition']),
  write('identity.session.revoke', 'platform', 'secret_metadata', ['ops.user.session.revoke']),
  read('audit.read', 'workspace', 'secret_metadata', ['ops.audit.list', 'ops.audit.detail']),
  read('audit.read', 'platform', 'secret_metadata', ['ops.audit.platform.list']),
  read('audit.export', 'workspace', 'secret_metadata', ['ops.audit.export']),
  read('support.ticket.read', 'workspace', 'customer_metadata', ['ops.support.tickets.list', 'ops.support.ticket.get', 'ops.support.sla.report']),
  write('support.ticket.update', 'workspace', 'customer_metadata', ['ops.support.ticket.create', 'ops.support.ticket.assign', 'ops.support.ticket.transition', 'ops.support.ticket.comment']),
  write('support.sla.update', 'workspace', 'customer_metadata', ['ops.support.sla.correction.create'], 'mutation', ['reason', 'idempotency']),
  write('support.sla.approve', 'workspace', 'customer_metadata', ['ops.support.sla.correction.decide'], 'mutation', ['reason', 'idempotency', 'approval']),
  read('support.customer.export', 'workspace', 'customer_content', ['ops.support.crm.export'], 'allow_and_deny'),
  read('incident.read', 'workspace', 'customer_metadata', ['ops.incidents.list', 'ops.incident.get', 'ops.incident.timeline']),
  write('incident.update', 'workspace', 'customer_metadata', ['ops.incident.create', 'ops.incident.transition', 'ops.incident.comment']),
  write('incident.administer', 'workspace', 'customer_metadata', ['ops.incident.commander.assign', 'ops.incident.scope.update']),
  read('feature_flag.read', 'platform', 'platform_summary', ['ops.feature-flags.list', 'ops.feature-flag.events', 'ops.feature-flag.evaluate']),
  write('feature_flag.update', 'platform', 'platform_summary', ['ops.feature-flag.upsert'], 'mutation', ['reason', 'idempotency']),
  write('feature_flag.administer', 'platform', 'platform_summary', ['ops.feature-flag.emergency.set'], 'allow_and_deny', ['reason', 'idempotency', 'mfa']),
  read('billing.platform.read', 'platform', 'finance', ['ops.finance.search', 'ops.finance.detail', 'ops.model-usage.summary']),
  read('billing.export', 'platform', 'finance', ['ops.finance.export', 'ops.users.export']),
  read('commercial.read', 'platform', 'finance', ['ops.commercial.offers.list', 'ops.commercial.addons.list', 'ops.commercial.coupons.list', 'ops.commercial.rollouts.list', 'ops.commercial.model-markup.get']),
  write('commercial.update', 'platform', 'finance', ['ops.commercial.offer.upsert', 'ops.commercial.addon.upsert', 'ops.commercial.coupon.upsert', 'ops.commercial.rollout.upsert', 'ops.commercial.model-markup.update']),
  read('commercial.export', 'platform', 'finance', ['ops.commercial.export']),
  read('marketing.summary.read', 'platform', 'platform_summary', ['ops.marketing.summary', 'ops.alerts.list']),
  write('marketing.alert.update', 'platform', 'platform_summary', ['ops.alert.ack']),
  read('marketing.queue.read', 'workspace', 'customer_metadata', ['ops.marketing.queue', 'ops.marketing.image.archive.audit', 'ops.marketing.image.billing.audit']),
  write('marketing.queue.update', 'workspace', 'customer_content', ['ops.marketing.queue.assign', 'ops.marketing.image.reconcile', 'ops.marketing.visual.review', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create']),
  write('marketing.queue.update', 'workspace', 'customer_content', ['ops.marketing.asset_scan.retry'], 'allow_and_deny', ['reason', 'revision', 'idempotency']),
  read('audit.export', 'workspace', 'customer_content', ['ops.marketing.image.evidence.export'], 'allow_and_deny'),
  read('storage.reconciliation.read', 'platform', 'platform_summary', ['ops.storage.reconciliation.list']),
  read('canonical.backfill.read', 'platform', 'customer_metadata', ['ops.canonical.backfill.get', 'ops.canonical.backfill.conflicts.list']),
  write('canonical.backfill.update', 'platform', 'customer_metadata', ['ops.canonical.backfill.create', 'ops.canonical.backfill.run', 'ops.canonical.backfill.pause', 'ops.canonical.backfill.resume', 'ops.canonical.backfill.conflict.claim', 'ops.canonical.backfill.conflict.resolve'], 'allow_and_deny'),
  read('rule.read', 'platform', 'customer_metadata', ['rule.audit']),
  read('rule.read', 'workspace', 'customer_metadata', ['ops.rules.workspace.audit']),
  read('billing.self.read', 'self', 'finance', ['subscription.get', 'subscription.orders.list', 'billing.status', 'billing.recharge.get', 'billing.recharge.list', 'billing.transactions']),
  write('billing.workspace.update', 'workspace', 'finance', ['subscription.order.create', 'subscription.change', 'billing.usage.consume', 'billing.recharge.create']),
  write('billing.refund.execute', 'workspace', 'finance', ['billing.usage.refund'], 'allow_and_deny', ['reason', 'idempotency']),
  write('billing.refund.execute', 'workspace', 'finance', ['billing.refund'], 'allow_and_deny', ['reason']),
  read('billing.workspace.read', 'workspace', 'finance', ['billing.reconciliation', 'billing.model-usage.statement']),
  write('billing.reconcile.execute', 'workspace', 'finance', ['billing.reconciliation.run', 'billing.model-usage.reconciliation.run', 'billing.model-usage.resolve']),
  read('billing.export', 'workspace', 'finance', ['billing.export']),
  read('platform.settings.read', 'platform', 'platform_summary', ['platform.settings.get']),
  write('platform.settings.update', 'platform', 'platform_summary', ['platform.settings.update']),
  read('platform.media_spec.read', 'platform', 'platform_summary', ['platform.media.spec.list', 'platform.media.spec.get']),
  read('platform.media_spec.read', 'workspace', 'customer_content', ['platform.mapping.preflight']),
  write('platform.media_spec.update', 'platform', 'platform_summary', ['platform.media.spec.create', 'platform.media.spec.update', 'platform.media.spec.expire']),
  write('platform.media_spec.approve', 'platform', 'platform_summary', ['platform.media.spec.approve'], 'allow_and_deny'),
  // The endpoint returns only redacted readiness/cost metadata and is used by
  // the merchant workbench to explain generation blockers. It must remain
  // readable in workspace scope; platform settings and provider credentials
  // stay platform-only.
  read('model.status.read', 'workspace', 'platform_summary', ['platform.model.status']),
  read('store.connection.read', 'workspace', 'customer_metadata', ['platform.store.list']),
  write('store.connection.update', 'workspace', 'customer_metadata', ['platform.connect', 'platform.revoke']),
  write('store.connection.update', 'account', 'customer_metadata', ['platform.store.alias.set']),
  read('customer.content.read', 'workspace', 'customer_content', ['brand-unit.list', 'brand-unit.listing.list', 'canonical.product.consistency', 'campaign.batch.list', 'campaign.batch.get', 'catalog.search', 'catalog.categories', 'catalog.image.get', 'rule.list', 'rule.sync.status', 'rule.history', 'asset.list', 'brand.get', 'catalog.sync.get', 'deliverable.list', 'task.history', 'feedback.list', 'creative.directions', 'creative.brief', 'creative.preview', 'generation.get', 'publish.batch.get', 'publish.get', 'knowledge.rule.list', 'knowledge.asset.list', 'knowledge.learning.list', 'knowledge.competitor.list', 'multimodal.video.get']),
  read('customer.content.read', 'brand', 'customer_content', ['task.timeline', 'content.versions', 'content.diff']),
  write('customer.content.update', 'workspace', 'customer_content', ['brand-unit.create', 'campaign.batch.create', 'campaign.batch.generate', 'campaign.batch.pause', 'campaign.batch.resume', 'campaign.batch.retry_failed', 'catalog.title.optimize', 'catalog.title.accept', 'catalog.import', 'catalog.import.batch', 'catalog.sku.update', 'catalog.product.update', 'catalog.facts.confirm', 'catalog.product.disable', 'catalog.product.enable', 'catalog.image.generate', 'catalog.image.select', 'catalog.image.review', 'sync.retry_failed', 'asset.parse', 'asset.facts.confirm', 'asset.preference.update', 'brand.extract', 'brand.upsert', 'brand.tone.preview', 'asset.upload', 'asset.upload.batch', 'asset.scan', 'asset.generation.confirm', 'asset.rights.update', 'catalog.sync', 'catalog.sync.start', 'task.create', 'task.understand', 'task.request.create', 'task.sku.split', 'task.group.create', 'task.clone', 'creative.directions.update', 'content.codex.prepare', 'content.codex.commit', 'content.visual.select', 'content.restore', 'ops.marketing.generation.retry', 'knowledge.rule.create', 'knowledge.asset.create', 'knowledge.asset.update', 'knowledge.feedback.record', 'knowledge.learning.confirm', 'knowledge.learning.dismiss', 'knowledge.competitor.create', 'knowledge.competitor.reference', 'multimodal.image.edit', 'multimodal.generate', 'multimodal.video.request']),
  write('customer.content.update', 'account', 'customer_content', ['brand-unit.bind-store', 'brand-unit.listing.create']),
  write('customer.content.update', 'brand', 'customer_content', ['brand-unit.product.create', 'brand-unit.access.grant', 'task.answer', 'task.resume', 'task.select_direction', 'task.plan.confirm', 'content.generate', 'content.review', 'content.review.decide', 'content.modify']),
  write('customer.publish.execute', 'workspace', 'customer_content', ['content.export', 'content.approve', 'publish.prepare', 'publish.batch.prepare', 'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed', 'delivery.bundle.verify'], 'allow_and_deny'),
  write('customer.publish.execute', 'workspace', 'customer_content', ['publish.confirm'], 'allow_and_deny', ['confirmation', 'idempotency']),
  write('customer.publish.execute', 'workspace', 'customer_content', ['publish.batch.confirm'], 'allow_and_deny', ['confirmation']),
  read('automation.read', 'workspace', 'customer_metadata', ['automation.policy.get', 'automation.policy.list', 'automation.scan']),
  write('automation.update', 'workspace', 'customer_metadata', ['automation.policy.update', 'automation.tick', 'automation.pause']),
  write('rule.publish.approve', 'platform', 'customer_content', ['rule.publish'], 'mutation', ['reason']),
  write('rule.update', 'platform', 'customer_metadata', ['rule.status']),
  write('customer.content.update', 'workspace', 'customer_content', ['feedback.submit']),
  write('customer.content.update', 'workspace', 'customer_content', ['catalog.image.retry']),
]

function buildPolicyRegistry(groups: readonly PolicyGroup[]): Readonly<Record<McpMethod, MethodPolicy>> {
  const policies = new Map<McpMethod, MethodPolicy>()
  for (const group of groups) {
    const { methods, ...defaults } = group
    for (const method of methods) {
      if (policies.has(method)) throw new Error(`AUTHZ_POLICY_DUPLICATE_METHOD:${method}`)
      policies.set(method, { method, ...defaults })
    }
  }
  const declared = new Set<McpMethod>([...MCP_METHODS, ...(exposeNonProductionMethods ? MCP_NON_PRODUCTION_METHODS : [])])
  // Keep the coverage check on the same effective declaration set used by
  // the runtime. Compatibility/non-production methods are still contractual
  // when exposed, so omitting one must fail closed during module startup.
  const missing = [...declared].filter(method => !policies.has(method))
  const extra = [...policies.keys()].filter(method => !declared.has(method))
  if (missing.length || extra.length) throw new Error(`AUTHZ_POLICY_COVERAGE_INVALID:missing=${missing.join(',')};extra=${extra.join(',')}`)
  return Object.freeze(Object.fromEntries(policies) as Record<McpMethod, MethodPolicy>)
}

export const MCP_METHOD_POLICIES = buildPolicyRegistry(POLICY_GROUPS)

export function getMcpMethodPolicy(method: string): MethodPolicy | undefined {
  return MCP_METHOD_POLICIES[method as McpMethod]
}

/**
 * Runtime authorization callers must use an exact registered method policy.
 * Unknown methods are not implicitly readable or writable: fail closed with
 * a stable error that can be surfaced as a configuration/deployment fault.
 */
export function requireMcpMethodPolicy(method: string): MethodPolicy {
  const policy = getMcpMethodPolicy(method)
  if (!policy) throw new Error(`AUTHZ_POLICY_NOT_REGISTERED:${method}`)
  return policy
}

export function assertMcpMethodPolicyCoverage(): { declared: number; registered: number; policyVersion: string } {
  const registered = Object.keys(MCP_METHOD_POLICIES).length
  const declaredMethods = new Set<McpMethod>([...MCP_METHODS, ...(exposeNonProductionMethods ? MCP_NON_PRODUCTION_METHODS : [])])
  const declared = declaredMethods.size
  const missing = [...declaredMethods].filter(method => !Object.prototype.hasOwnProperty.call(MCP_METHOD_POLICIES, method))
  const extra = Object.keys(MCP_METHOD_POLICIES).filter(method => !declaredMethods.has(method as McpMethod))
  if (missing.length || extra.length || registered !== declared) {
    throw new Error(`AUTHZ_POLICY_COVERAGE_INVALID:declared=${declared};registered=${registered};missing=${missing.join(',')};extra=${extra.join(',')}`)
  }
  return { declared, registered, policyVersion: AUTHZ_POLICY_VERSION }
}
