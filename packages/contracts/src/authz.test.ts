import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from './mcp.js'
import {
  AUTHZ_POLICY_VERSION,
  CANONICAL_ROLES,
  MCP_METHOD_POLICIES,
  assertMcpMethodPolicyCoverage,
  capabilitiesForRoles,
  canonicalizeRole,
  evaluateAuthorizationDecision,
  evaluatePermissionAtoms,
  getMcpMethodPolicy,
  requireMcpMethodPolicy,
  resolveCanonicalRoles,
} from './authz.js'

describe('authorization policy registry', () => {
  it('covers every declared MCP method exactly once without a wildcard fallback', () => {
    expect(assertMcpMethodPolicyCoverage()).toEqual({ declared: MCP_METHODS.length, registered: MCP_METHODS.length, policyVersion: AUTHZ_POLICY_VERSION })
    expect(MCP_METHODS.length).toBeGreaterThanOrEqual(231)
    expect(Object.keys(MCP_METHOD_POLICIES).sort()).toEqual([...MCP_METHODS].sort())
    expect(getMcpMethodPolicy('unknown.future.method')).toBeUndefined()
  })

  it('provides an exact policy lookup that denies unknown methods by default', () => {
    expect(requireMcpMethodPolicy('asset.scan')).toMatchObject({ method: 'asset.scan', effect: 'write' })
    expect(() => requireMcpMethodPolicy('unknown.future.method')).toThrow('AUTHZ_POLICY_NOT_REGISTERED:unknown.future.method')
  })

  it('keeps ambiguous allow_and_deny obligation gaps explicit and reviewable', () => {
    const missing = Object.values(MCP_METHOD_POLICIES).filter(policy => policy.audit === 'allow_and_deny' && policy.obligations.length === 0)
    expect(missing.every(policy => policy.audit === 'allow_and_deny' && policy.obligations.length === 0)).toBe(true)
    expect(new Set(missing.map(policy => policy.method))).toEqual(new Set([
      'ops.support.crm.export', 'ops.marketing.image.evidence.export',
      'ops.canonical.backfill.create', 'ops.canonical.backfill.run',
      'ops.canonical.backfill.pause', 'ops.canonical.backfill.resume',
      'ops.canonical.backfill.conflict.claim', 'ops.canonical.backfill.conflict.resolve',
      'platform.media.spec.approve', 'content.export', 'content.approve',
      'publish.prepare', 'publish.batch.prepare', 'publish.batch.pause',
      'publish.batch.resume', 'publish.batch.retry_failed', 'delivery.bundle.verify',
    ]))
  })

  it('classifies ops console methods with explicit capability, scope, data and audit metadata', () => {
    const opsMethods = MCP_METHODS.filter(method => method.startsWith('ops.'))
    expect(opsMethods.length).toBeGreaterThan(0)
    for (const method of opsMethods) {
      expect(getMcpMethodPolicy(method)).toMatchObject({ method })
      expect(getMcpMethodPolicy(method)?.capability).toBeTruthy()
      expect(getMcpMethodPolicy(method)?.scope).toBeTruthy()
      expect(getMcpMethodPolicy(method)?.dataClass).toBeTruthy()
      expect(getMcpMethodPolicy(method)?.audit).toBeTruthy()
    }
    expect(getMcpMethodPolicy('ops.feature-flag.emergency.set')).toMatchObject({ capability: 'feature_flag.administer', effect: 'write', audit: 'allow_and_deny', obligations: ['reason', 'idempotency', 'mfa'] })
    expect(getMcpMethodPolicy('ops.marketing.queue')).toMatchObject({ capability: 'marketing.queue.read', dataClass: 'customer_metadata' })
    expect(getMcpMethodPolicy('ops.marketing.asset_scan.retry')).toMatchObject({ capability: 'marketing.queue.update', scope: 'workspace', dataClass: 'customer_content', effect: 'write', audit: 'allow_and_deny', obligations: ['reason', 'revision', 'idempotency'] })
    expect(getMcpMethodPolicy('billing.refund')).toMatchObject({ capability: 'billing.refund.execute', effect: 'write' })
    expect(getMcpMethodPolicy('platform.store.alias.set')).toMatchObject({ capability: 'store.connection.update', scope: 'account', effect: 'write' })
    expect(getMcpMethodPolicy('brand-unit.bind-store')).toMatchObject({ capability: 'customer.content.update', scope: 'account', effect: 'write' })
    expect(getMcpMethodPolicy('brand-unit.listing.create')).toMatchObject({ capability: 'customer.content.update', scope: 'account', effect: 'write' })
    expect(getMcpMethodPolicy('brand-unit.product.create')).toMatchObject({ capability: 'customer.content.update', scope: 'brand', effect: 'write' })
    expect(getMcpMethodPolicy('ops.alert.ack')).toMatchObject({ capability: 'marketing.alert.update', effect: 'write' })
    expect(getMcpMethodPolicy('rule.status')).toMatchObject({ capability: 'rule.update', effect: 'write' })
    expect(getMcpMethodPolicy('task.resume')).toMatchObject({ capability: 'customer.content.update', effect: 'write' })
    expect(getMcpMethodPolicy('task.clone')).toMatchObject({ capability: 'customer.content.update', effect: 'write' })
    expect(getMcpMethodPolicy('platform.mapping.preflight')).toMatchObject({ capability: 'platform.media_spec.read', scope: 'workspace', effect: 'read' })
    expect(getMcpMethodPolicy('platform.media.spec.get')).toMatchObject({ capability: 'platform.media_spec.read', scope: 'platform', effect: 'read' })
    expect(getMcpMethodPolicy('ops.canonical.backfill.conflicts.list')).toMatchObject({ capability: 'canonical.backfill.read', scope: 'platform', dataClass: 'customer_metadata', effect: 'read' })
    expect(getMcpMethodPolicy('ops.canonical.backfill.conflict.claim')).toMatchObject({ capability: 'canonical.backfill.update', scope: 'platform', dataClass: 'customer_metadata', effect: 'write', audit: 'allow_and_deny' })
    expect(getMcpMethodPolicy('ops.canonical.backfill.conflict.resolve')).toMatchObject({ capability: 'canonical.backfill.update', scope: 'platform', dataClass: 'customer_metadata', effect: 'write', audit: 'allow_and_deny' })
  })

  it('normalizes legacy roles at one boundary without elevating ops_admin to platform_admin', () => {
    expect(canonicalizeRole('platform_ops')).toBe('ops_admin')
    expect(canonicalizeRole('merchant_admin', 'membership')).toBe('workspace_admin')
    expect(resolveCanonicalRoles({ gatewayRoles: ['platform_ops', 'rules_admin'], memberRole: 'merchant_admin' })).toEqual(['ops_admin', 'rules_admin', 'workspace_admin'])
    expect(capabilitiesForRoles(['ops_admin'])).toContain('feature_flag.update')
    expect(capabilitiesForRoles(['ops_admin'])).not.toContain('feature_flag.administer')
    expect(resolveCanonicalRoles({ gatewayRoles: ['platform_ops'] })).not.toContain('platform_admin')
    expect(capabilitiesForRoles(['rules_admin'])).toContain('rule.publish.approve')
    for (const role of CANONICAL_ROLES) {
      expect(capabilitiesForRoles([role]), `${role} must be able to load its own authorization session`).toContain('authorization.session.read')
    }
  })

  it.each([
    ['member allow', 'ops.member.upsert', ['workspace.member.manage'], [{ type: 'workspace', ids: ['ws_1'] }], { type: 'workspace', id: 'ws_1' }, ['reason'], true, 'AUTHZ_ALLOWED'],
    ['member capability deny', 'ops.member.upsert', [], [{ type: 'workspace', ids: ['ws_1'] }], { type: 'workspace', id: 'ws_1' }, ['reason'], false, 'AUTHZ_CAPABILITY_MISSING'],
    ['member exact resource deny', 'ops.member.upsert', ['workspace.member.manage'], [{ type: 'workspace', ids: ['ws_1'] }], { type: 'workspace', id: 'ws_2' }, ['reason'], false, 'AUTHZ_SCOPE_MISMATCH'],
    ['feature flag allow', 'ops.feature-flag.upsert', ['feature_flag.update'], [{ type: 'platform', ids: ['*'] }], { type: 'platform', id: '*' }, ['reason', 'idempotency'], true, 'AUTHZ_ALLOWED'],
    ['feature flag explicit deny', 'ops.feature-flag.upsert', ['feature_flag.update'], [{ type: 'platform', ids: ['*'] }], { type: 'platform', id: '*' }, ['reason', 'idempotency'], false, 'AUTHZ_EXPLICIT_DENY'],
    ['feature flag obligation deny', 'ops.feature-flag.upsert', ['feature_flag.update'], [{ type: 'platform', ids: ['*'] }], { type: 'platform', id: '*' }, ['reason'], false, 'AUTHZ_OBLIGATION_REQUIRED'],
    ['feature flag scope deny', 'ops.feature-flag.upsert', ['feature_flag.update'], [{ type: 'workspace', ids: ['ws_1'] }], { type: 'platform', id: '*' }, ['reason', 'idempotency'], false, 'AUTHZ_SCOPE_MISMATCH'],
  ] as const)('evaluates complete allow, deny and scope semantics for %s', (_label, method, capabilities, scopes, resourceScope, satisfied, authorized, reason) => {
    const policy = getMcpMethodPolicy(method)!
    const decision = evaluateAuthorizationDecision({
      decisionId: `decision-${method}`,
      policy,
      capabilities: [...capabilities],
      scopes: scopes.map(scope => ({ ...scope, type: scope.type as 'platform' | 'workspace' })),
      explicitDenies: _label.includes('explicit deny') ? [policy.capability] : [],
      satisfiedObligations: [...satisfied],
      resourceScope,
      workbench: policy.scope === 'platform' ? 'platform' : 'workspace',
      mode: 'enforce',
    })
    expect(decision).toMatchObject({ authorized, allowed: authorized, reason_code: reason, policy_version: AUTHZ_POLICY_VERSION, enforced: true })
    expect(decision.decision_id).toBe(`decision-${method}`)
  })

  it('reports a shadow denial without breaking an unmigrated handler', () => {
    const policy = getMcpMethodPolicy('catalog.search')!
    expect(evaluateAuthorizationDecision({ decisionId: 'decision-shadow', policy, capabilities: [], scopes: [], resourceScope: { type: 'workspace', id: 'ws_1' }, workbench: 'workspace', mode: 'shadow' })).toMatchObject({ authorized: false, allowed: true, enforced: false, result: 'shadow_deny', reason_code: 'AUTHZ_CAPABILITY_MISSING' })
  })

  it('enforces an explicit principal deny even while the capability domain is in shadow mode', () => {
    const policy = getMcpMethodPolicy('catalog.search')!
    expect(evaluateAuthorizationDecision({
      decisionId: 'decision-explicit-shadow-deny',
      policy,
      capabilities: [policy.capability],
      explicitDenies: [policy.capability],
      scopes: [{ type: 'workspace', ids: ['ws_1'] }],
      resourceScope: { type: 'workspace', id: 'ws_1' },
      workbench: 'workspace',
      mode: 'shadow',
    })).toMatchObject({ authorized: false, allowed: false, enforced: true, result: 'deny', reason_code: 'AUTHZ_EXPLICIT_DENY', explicit_deny: true })
  })

  it('hard-denies both directions of a workbench mismatch even in shadow mode', () => {
    const platformPolicy = getMcpMethodPolicy('ops.users.list')!
    const workspacePolicy = getMcpMethodPolicy('catalog.search')!
    expect(evaluateAuthorizationDecision({ decisionId: 'workspace-to-platform', policy: platformPolicy, capabilities: [platformPolicy.capability], scopes: [{ type: 'platform', ids: ['*'] }], resourceScope: { type: 'platform', id: '*' }, workbench: 'workspace', mode: 'shadow' })).toMatchObject({ allowed: false, enforced: true, result: 'deny', reason_code: 'AUTHZ_WORKBENCH_MISMATCH' })
    expect(evaluateAuthorizationDecision({ decisionId: 'platform-to-workspace', policy: workspacePolicy, capabilities: [workspacePolicy.capability], scopes: [{ type: 'workspace', ids: ['ws_1'] }], resourceScope: { type: 'workspace', id: 'ws_1' }, workbench: 'platform', mode: 'shadow' })).toMatchObject({ allowed: false, enforced: true, result: 'deny', reason_code: 'AUTHZ_WORKBENCH_MISMATCH' })
  })

  it('keeps capability and scope in one permission atom and enforces read-only grant limits', () => {
    const readPolicy = getMcpMethodPolicy('catalog.search')!
    expect(evaluatePermissionAtoms({
      decisionId: 'atom-no-cartesian-product', policy: readPolicy, workbench: 'workspace', mode: 'enforce',
      atoms: [
        { capability: 'customer.content.read', effect: 'allow', scope: { type: 'platform', ids: ['*'] }, source: 'platform_assignment', sourceId: 'pa_1', obligations: [] },
        { capability: 'customer.content.update', effect: 'allow', scope: { type: 'workspace', ids: ['ws_1'] }, source: 'workspace_membership', sourceId: 'wm_1', obligations: [] },
      ],
      resourceScope: { type: 'workspace', id: 'ws_1' },
    })).toMatchObject({ authorized: false, reason_code: 'AUTHZ_SCOPE_MISMATCH' })

    const writePolicy = getMcpMethodPolicy('catalog.product.update')!
    expect(evaluatePermissionAtoms({
      decisionId: 'atom-read-limit', policy: writePolicy, workbench: 'workspace', mode: 'enforce',
      atoms: [{ capability: 'customer.content.update', effect: 'allow', scope: { type: 'workspace', ids: ['ws_1'] }, source: 'temporary_grant', sourceId: 'grant_1', obligations: [], effectLimit: 'read' }],
      resourceScope: { type: 'workspace', id: 'ws_1' },
    })).toMatchObject({ authorized: false, reason_code: 'AUTHZ_CAPABILITY_MISSING' })
  })

  it('fails closed for revoked, expired, malformed, and wildcard grant atoms', () => {
    const policy = getMcpMethodPolicy('catalog.product.update')!
    const evaluate = (atom: Parameters<typeof evaluatePermissionAtoms>[0]['atoms'][number]) => evaluatePermissionAtoms({
      decisionId: 'grant-fail-closed', policy, workbench: 'workspace', mode: 'enforce', now: '2026-09-01T00:00:00.000Z',
      atoms: [atom], resourceScope: { type: 'workspace', id: 'ws_1' },
    })
    const base = { capability: policy.capability, effect: 'allow' as const, scope: { type: 'workspace' as const, ids: ['ws_1'] }, source: 'temporary_grant' as const, sourceId: 'grant_1', obligations: [] as const }
    for (const atom of [
      { ...base, expiresAt: '2026-08-31T23:59:59.000Z' },
      { ...base, expiresAt: 'not-a-date' },
      { ...base, revokedAt: '2026-08-31T23:00:00.000Z' },
      { ...base, scope: { type: 'workspace' as const, ids: ['*'] } },
      { ...base, scope: { type: 'workspace' as const, ids: [] } },
    ]) {
      expect(evaluate(atom)).toMatchObject({ authorized: false, allowed: false, reason_code: 'AUTHZ_CAPABILITY_MISSING' })
    }
  })

  it('allows an unexpired exact-scope grant and rejects a different resource', () => {
    const policy = getMcpMethodPolicy('catalog.product.update')!
    const atom = { capability: policy.capability, effect: 'allow' as const, scope: { type: 'workspace' as const, ids: ['ws_1'] }, source: 'temporary_grant' as const, sourceId: 'grant_exact', obligations: [] as const, expiresAt: '2026-09-01T00:01:00.000Z' }
    expect(evaluatePermissionAtoms({ decisionId: 'grant-exact-allow', policy, workbench: 'workspace', mode: 'enforce', now: '2026-09-01T00:00:00.000Z', atoms: [atom], resourceScope: { type: 'workspace', id: 'ws_1' } })).toMatchObject({ authorized: true, result: 'allow' })
    expect(evaluatePermissionAtoms({ decisionId: 'grant-exact-deny', policy, workbench: 'workspace', mode: 'enforce', now: '2026-09-01T00:00:00.000Z', atoms: [atom], resourceScope: { type: 'workspace', id: 'ws_2' } })).toMatchObject({ authorized: false, allowed: false, reason_code: 'AUTHZ_SCOPE_MISMATCH' })
  })
})
