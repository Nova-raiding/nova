import { describe, expect, it } from 'vitest'
import { registeredMcpAuthorizationDecision, resolveAuthorizationResourceScope, workspaceAccountPermissionAtoms } from './server.js'
import { AUTHZ_POLICY_VERSION, MCP_METHODS, getMcpMethodPolicy, type MethodPolicy } from '../../../packages/contracts/src/index.js'

describe('registered MCP authorization coverage', () => {
  it('projects a workspace role to an exact account only when the account belongs to that workspace', () => {
    const policy = getMcpMethodPolicy('platform.store.alias.set')!
    const workspaceAtom = {
      capability: policy.capability,
      effect: 'allow' as const,
      scope: { type: 'workspace' as const, ids: ['ws_scope'] },
      source: 'workspace_membership' as const,
      sourceId: 'membership_1',
      obligations: [] as const,
    }

    const allowed = workspaceAccountPermissionAtoms(policy, 'ws_scope', 'account_a', ['account_a', 'account_b'], [workspaceAtom])
    expect(allowed).toEqual(expect.arrayContaining([
      workspaceAtom,
      expect.objectContaining({ source: 'resource_grant', sourceId: 'workspace-account:ws_scope:account_a', scope: { type: 'account', ids: ['account_a'] } }),
    ]))
    expect(workspaceAccountPermissionAtoms(policy, 'ws_scope', 'account_foreign', ['account_a'], [workspaceAtom])).toEqual([workspaceAtom])
  })

  it('never derives an account grant from a temporary workspace grant', () => {
    const policy = getMcpMethodPolicy('platform.store.alias.set')!
    const temporaryWorkspaceAtom = {
      capability: policy.capability,
      effect: 'allow' as const,
      scope: { type: 'workspace' as const, ids: ['ws_scope'] },
      source: 'temporary_grant' as const,
      sourceId: 'grant_1',
      obligations: [] as const,
    }
    expect(workspaceAccountPermissionAtoms(policy, 'ws_scope', 'account_a', ['account_a'], [temporaryWorkspaceAtom])).toEqual([temporaryWorkspaceAtom])
  })

  it('produces one unique strict authorization decision for every live MCP method', () => {
    const decisions = MCP_METHODS.map((method, index) => {
      const policy = getMcpMethodPolicy(method)
      expect(policy, `${method} must have an authorization policy`).toBeDefined()
      return registeredMcpAuthorizationDecision({
        decisionId: `coverage_${index}_${method}`,
        method,
        atoms: [],
        resourceScope: { type: policy!.scope, id: policy!.scope === 'platform' ? '*' : 'coverage-resource' },
        workbench: policy!.workbench,
        mode: 'enforce',
        now: '2026-09-01T00:00:00.000Z',
      })
    })

    expect(decisions).toHaveLength(MCP_METHODS.length)
    expect(new Set(decisions.map(decision => decision.decision_id)).size).toBe(MCP_METHODS.length)
    expect(decisions.map(decision => decision.method)).toEqual(MCP_METHODS)
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        policy_version: AUTHZ_POLICY_VERSION,
        mode: 'enforce',
        enforced: true,
        authorized: false,
        allowed: false,
        result: 'deny',
        reason_code: 'AUTHZ_CAPABILITY_MISSING',
      })
    }
  })

  it('keeps workspace.bootstrap inside the same evaluator contract', () => {
    const decision = registeredMcpAuthorizationDecision({
      decisionId: 'coverage_bootstrap',
      method: 'workspace.bootstrap',
      atoms: [],
      resourceScope: { type: 'workspace', id: 'bootstrap-pending' },
      workbench: 'workspace',
      mode: 'enforce',
    })

    expect(decision).toMatchObject({
      method: 'workspace.bootstrap',
      policy_version: AUTHZ_POLICY_VERSION,
      mode: 'enforce',
      result: 'deny',
      reason_code: 'AUTHZ_CAPABILITY_MISSING',
    })
  })

  it.each([
    ['platform', {}, undefined, { type: 'platform', id: '*' }],
    ['workspace', {}, undefined, { type: 'workspace', id: 'ws_exact' }],
    ['self', {}, { actorId: 'actor_exact' }, { type: 'self', id: 'actor_exact' }],
    ['brand', { brand_id: ' brand_exact ' }, undefined, { type: 'brand', id: 'brand_exact' }],
    ['account', { account_id: ' account_exact ' }, undefined, { type: 'account', id: 'account_exact' }],
  ] as const)('resolves an exact %s scope without accepting an untrimmed identifier', (scope, params, principal, expected) => {
    const policy = { ...getMcpMethodPolicy('ops.session')!, scope } as MethodPolicy
    expect(resolveAuthorizationResourceScope(policy, ' ws_exact ', params, principal)).toEqual(expected)
  })

  it.each(['workspace', 'self', 'brand', 'account'] as const)('leaves a missing %s identifier unresolved so evaluation fails closed', scope => {
    const policy = { ...getMcpMethodPolicy('ops.session')!, scope } as MethodPolicy
    const resourceScope = resolveAuthorizationResourceScope(policy, '   ', { brand_id: ' ', account_id: '' })
    expect(resourceScope).toEqual({ type: scope, id: undefined })
  })
})
