import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { MCP_METHOD_POLICIES } from '../../../packages/contracts/src/index.js'
import { handleMcpOpsAuthorizationMethod, MCP_OPS_AUTHORIZATION_METHODS } from './mcp-ops-authorization-handlers.js'

type Dependencies = Parameters<typeof handleMcpOpsAuthorizationMethod>[4]

const request = { headers: { 'x-actor-id': 'hyp@sn.com', 'x-account-login': 'hyp@sn.com' } } as unknown as IncomingMessage

function dependencies(context?: ReturnType<Dependencies['authorizationContext']>) {
  const authorizationRepository = vi.fn()
  const deps: Dependencies = {
    authorizationRepository,
    authorizationContext: () => context,
    canonicalRoleMethodAccess: () => 'hidden',
    verifiedApprovalActor: () => undefined,
    requiresStrictAuth: () => true,
    required: (params, key) => String(params[key] ?? ''),
  }
  return { deps, authorizationRepository }
}

function allowedContext(login = 'hyp@sn.com'): NonNullable<ReturnType<Dependencies['authorizationContext']>> {
  return {
    actorId: 'verified-actor-id', identityId: 'verified-identity-id', accountLogin: login, workbench: 'platform',
    canonicalRoles: ['platform_admin'],
    capabilities: [...new Set([...MCP_OPS_AUTHORIZATION_METHODS].map(method => MCP_METHOD_POLICIES[method as keyof typeof MCP_METHOD_POLICIES].capability))],
  }
}

describe('ops authorization MCP super administrator gate', () => {
  it.each([...MCP_OPS_AUTHORIZATION_METHODS])('rejects %s before accessing its repository when the verified login is not designated', async method => {
    const { deps, authorizationRepository } = dependencies(allowedContext('unlisted-platform-admin@example.test'))
    await expect(handleMcpOpsAuthorizationMethod(method, {}, request, 'ws_test', deps)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(authorizationRepository).not.toHaveBeenCalled()
  })

  it('does not accept forged request headers without a verified principal', async () => {
    const { deps } = dependencies(undefined)
    await expect(handleMcpOpsAuthorizationMethod('ops.authorization.matrix.get', {}, request, 'ws_test', deps)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it.each([
    { actorId: undefined }, { identityId: undefined }, { accountLogin: undefined }, { workbench: 'workspace' },
    { canonicalRoles: ['security_admin'] }, { capabilities: [] },
  ])('fails closed when required verified context is missing or insufficient: %o', async change => {
    const { deps } = dependencies({ ...allowedContext(), ...change })
    await expect(handleMcpOpsAuthorizationMethod('ops.authorization.matrix.get', {}, request, 'ws_test', deps)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it.each(['hyp@sn.com', 'hxd@sn.com', 'devide@sn.com'])('allows designated account %s when role and method capability are verified', async login => {
    const { deps } = dependencies(allowedContext(login))
    const result = await handleMcpOpsAuthorizationMethod('ops.authorization.matrix.get', {}, request, 'ws_test', deps)
    expect(result).toMatchObject({ schema_version: 1, generated_from: 'MCP_METHOD_POLICIES' })
  })

  it('records a role mutation under the verified actor rather than a forged request header', async () => {
    const { deps } = dependencies(allowedContext())
    const assignPlatformRole = vi.fn().mockResolvedValue({ id: 'assignment-id' })
    deps.authorizationRepository = () => ({ assignPlatformRole }) as unknown as ReturnType<Dependencies['authorizationRepository']>
    await handleMcpOpsAuthorizationMethod('ops.authorization.role.assign', {
      subject_identity_id: 'target-identity-id', role: 'support_agent',
      reason: 'Authorised role assignment', expected_authorization_revision: '0',
    }, request, 'ws_test', deps)
    expect(assignPlatformRole).toHaveBeenCalledWith(expect.objectContaining({ assignedBy: 'verified-actor-id' }))
  })
})
