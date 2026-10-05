import { describe, expect, it } from 'vitest'
import { getMcpMethodPolicy, evaluateAuthorizationDecision, ROLE_CAPABILITIES } from './authz.js'
import { validateMcpRequest } from './mcp.js'
import { COMMERCIAL_OPERATION_REGISTRY } from './commercial-operation-registry.js'
import { resolveCommercialOperation } from './commercial-access.js'

const request = (method: string, params: Record<string, string>) => ({ jsonrpc: '2.0', id: 'platform-support', method, params })

describe('explicit platform support target workspace contracts', () => {
  it('requires an explicit target and rejects fake tenant identity selectors', () => {
    const get = { target_workspace_id: 'tenant-1', ticket_id: 'ticket-1' }
    expect(validateMcpRequest(request('ops.support.platform.ticket.get', get)).valid).toBe(true)
    expect(validateMcpRequest(request('ops.support.platform.ticket.get', { ticket_id: 'ticket-1' })).valid).toBe(false)
    const forbiddenSelectors: readonly Record<string, string>[] = [{ workspace_id: 'tenant-1' }, { actor_id: 'spoofed' }, { role: 'platform_admin' }]
    for (const extra of forbiddenSelectors) {
      expect(validateMcpRequest(request('ops.support.platform.ticket.get', { ...get, ...extra })).valid).toBe(false)
    }
    expect(validateMcpRequest(request('ops.support.platform.tickets.list', { target_workspace_id: 'tenant-1', limit: '101' })).valid).toBe(false)
  })

  it('separates platform support capabilities while preserving the workspace policies', () => {
    for (const method of ['ops.support.platform.tickets.list', 'ops.support.platform.ticket.get']) expect(getMcpMethodPolicy(method)).toMatchObject({ scope: 'platform', workbench: 'platform', capability: 'support.ticket.read', effect: 'read' })
    expect(getMcpMethodPolicy('ops.support.platform.ticket.comment')).toMatchObject({ scope: 'platform', workbench: 'platform', capability: 'support.ticket.update', effect: 'write', obligations: ['revision', 'idempotency'] })
    expect(getMcpMethodPolicy('ops.support.ticket.get')).toMatchObject({ scope: 'workspace', workbench: 'workspace' })
    expect(getMcpMethodPolicy('ops.support.ticket.comment')).toMatchObject({ scope: 'workspace', workbench: 'workspace' })
  })

  it('allows the exact platform policy while hard-denying a tenant workbench even in shadow mode', () => {
    const policy = getMcpMethodPolicy('ops.support.platform.ticket.comment')!
    const input = { decisionId: 'support-decision', policy, capabilities: ['support.ticket.update'] as const,
      satisfiedObligations: ['revision', 'idempotency'] as const, scopes: [{ type: 'platform' as const, ids: ['*'] }],
      resourceScope: { type: 'platform' as const, id: '*' }, workbench: 'platform' as const, mode: 'enforce' as const }
    expect(evaluateAuthorizationDecision(input)).toMatchObject({ authorized: true })
    expect(evaluateAuthorizationDecision({ ...input, workbench: 'workspace', mode: 'shadow' })).toMatchObject({ authorized: false, enforced: true, reason_code: 'AUTHZ_WORKBENCH_MISMATCH' })
  })

  it('grants platform administrators support replies without granting tenant roles the platform workbench', () => {
    expect(ROLE_CAPABILITIES.platform_admin).toContain('support.ticket.update')
    const policy = getMcpMethodPolicy('ops.support.platform.ticket.comment')!
    for (const role of ['workspace_owner', 'workspace_admin', 'operator'] as const) {
      expect(evaluateAuthorizationDecision({ decisionId: `support-${role}`, policy, capabilities: ROLE_CAPABILITIES[role],
        scopes: [{ type: 'workspace', ids: ['tenant-1'] }], resourceScope: { type: 'platform', id: '*' },
        satisfiedObligations: ['revision','idempotency'], workbench: 'workspace', mode: 'enforce' })).toMatchObject({ authorized: false, enforced: true, reason_code: 'AUTHZ_WORKBENCH_MISMATCH' })
    }
  })

  it('registers platform replies as Ops control rather than free merchant recovery', () => {
    const method = 'ops.support.platform.ticket.comment'
    expect(resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'MCP', operation: method })).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'OPS_CONTROL', classification: null, authorization_policy_ref: method } })
    const comment = { target_workspace_id: 'tenant-1', ticket_id: 'ticket-1', body: '运营回复', visibility: 'customer', expected_revision: '1', idempotency_key: 'reply-0001' }
    expect(validateMcpRequest(request(method, comment)).valid).toBe(true)
    expect(validateMcpRequest(request(method, { ...comment, visibility: 'public' })).valid).toBe(false)
    expect(validateMcpRequest(request(method, { ...comment, expected_revision: '0' })).valid).toBe(false)
  })
})
