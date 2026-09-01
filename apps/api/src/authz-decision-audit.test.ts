import { describe, expect, it } from 'vitest'
import { authorizationDecisionAuditContextIsValid, authorizationDecisionRequiresAudit, authorizationDecisionAuditEvidence } from './server.js'
import type { AuthorizationDecision } from '../../../packages/contracts/src/authz.js'

describe('authorization decision audit evidence', () => {
  it('fails closed when an enforced decision cannot be attributed to a workspace actor', () => {
    const decision: AuthorizationDecision = {
      decision_id: 'decision_audit_context', policy_version: '2026-08-31.v2', method: 'ops.member.upsert',
      capability: 'workspace.member.manage', workbench: 'workspace',
      scope: { required: 'workspace', resolved: [] }, mode: 'enforce', enforced: true,
      authorized: false, allowed: false, result: 'deny', reason_code: 'AUTHZ_CAPABILITY_MISSING', explicit_deny: false,
      obligations: { required: [], satisfied: [], missing: [] },
    }

    expect(authorizationDecisionRequiresAudit(decision)).toBe(true)
    expect(authorizationDecisionAuditContextIsValid(decision, '', 'actor_a')).toBe(false)
    expect(authorizationDecisionAuditContextIsValid(decision, 'ws_a', undefined)).toBe(false)
    expect(authorizationDecisionAuditContextIsValid(decision, 'ws_a', 'actor_a')).toBe(true)
  })

  it('does not require durable audit context for an unenforced shadow decision', () => {
    const decision = { enforced: false, authorized: true, method: 'ops.member.upsert' } as AuthorizationDecision
    expect(authorizationDecisionRequiresAudit(decision)).toBe(false)
    expect(authorizationDecisionAuditContextIsValid(decision, '', undefined)).toBe(true)
  })

  it('persists reconstructible scope and obligation evidence without changing the decision', () => {
    const decision: AuthorizationDecision = {
      decision_id: 'decision_audit_1', policy_version: '2026-08-31.v2', method: 'ops.member.upsert',
      capability: 'workspace.member.manage', workbench: 'workspace',
      scope: { required: 'workspace', resource_id: 'ws_a', resolved: [{ type: 'workspace', ids: ['ws_a'] }, { type: 'brand', ids: ['brand_a'] }] },
      mode: 'enforce', enforced: true, authorized: false, allowed: false, result: 'deny',
      reason_code: 'AUTHZ_OBLIGATION_REQUIRED', explicit_deny: false,
      obligations: { required: ['reason', 'revision'], satisfied: ['revision'], missing: ['reason'] },
    }

    expect(authorizationDecisionAuditEvidence(decision, { requestId: 'req_a', traceId: 'trace_a' })).toEqual({
      decision_id: 'decision_audit_1', request_id: 'req_a', trace_id: 'trace_a', policy_version: '2026-08-31.v2',
      workbench: 'workspace', capability: 'workspace.member.manage', scope: 'workspace', resource_id: 'ws_a',
      resolved_scopes: [{ type: 'workspace', ids: ['ws_a'] }, { type: 'brand', ids: ['brand_a'] }],
      result: 'deny', reason_code: 'AUTHZ_OBLIGATION_REQUIRED', explicit_deny: false,
      obligations: { required: ['reason', 'revision'], satisfied: ['revision'], missing: ['reason'] },
    })
    expect(decision).toMatchObject({ authorized: false, allowed: false, reason_code: 'AUTHZ_OBLIGATION_REQUIRED' })
  })

  it('copies arrays so audit serialization cannot mutate the authorization decision', () => {
    const scopes = [{ type: 'workspace' as const, ids: ['ws_a'] }]
    const decision: AuthorizationDecision = {
      decision_id: 'decision_audit_2', policy_version: '2026-08-31.v2', method: 'ops.member.upsert' as const,
      capability: 'workspace.member.manage' as const, workbench: 'workspace' as const,
      scope: { required: 'workspace' as const, resolved: scopes }, mode: 'enforce' as const, enforced: true,
      authorized: true, allowed: true, result: 'allow' as const, reason_code: 'AUTHZ_ALLOWED' as const, explicit_deny: false,
      obligations: { required: [] as const, satisfied: [] as const, missing: [] as const },
    }
    const evidence = authorizationDecisionAuditEvidence(decision, { requestId: 'req_b', traceId: 'trace_b' })
    evidence.resolved_scopes[0]!.ids.push('mutated')
    expect(decision.scope.resolved[0]!.ids).toEqual(['ws_a'])
  })
})
