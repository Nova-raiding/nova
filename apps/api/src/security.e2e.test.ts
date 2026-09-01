import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { assertImageSelectionTicketPersistence, assertVideoArtifactUrl, configuredOAuthRedirectUri, deriveWorkerContinuationAuthorizationSnapshot, mcpAuthorizationCoverageReport, mcpAuthorizationEnforcedMethods, mcpAuthorizationRuntimeConfig, oauthStates, operationAudits, productionAuthorizationReadiness, recheckWorkerAuthorizationSnapshot, server, service, setAuthorizationRepositoryForTests, trustedDashScopeImageArtifactHost, validateOperationAuditContext, workspaceMembers } from './server.js'
import { hashPkceVerifier, OAuthStateStore, redactSecrets } from '../../../packages/security/src/oauth.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { MCP_METHODS } from '../../../packages/contracts/src/mcp.js'
import { AUTHZ_POLICY_VERSION, CANONICAL_ROLES } from '../../../packages/contracts/src/authz.js'
import { createWorkerRequestProof, type WorkerRequestRole } from '../../../packages/security/src/worker-request-proof.js'

type Envelope<T = Record<string, any>> = { workspace_id: string; data: T | null; error: { code: string; details?: Record<string, unknown> } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json(response: Response) { return { response, body: await response.json() as Envelope } }

function workerProofHeaders(input: { role: WorkerRequestRole; secret: string; method: string; path: string; workspaceId: string; body?: string }) {
  return createWorkerRequestProof({ secret: input.secret, role: input.role, method: input.method, requestTarget: input.path, workspaceId: input.workspaceId, body: input.body }).headers
}

function workerDecisionContent(productId: string) {
  const factSourceId = `product:${productId}:v1`
  return {
    title: 'worker', detail: 'worker', sellingPoints: ['fact'],
    modules: [{
      key: 'selling_points', title: '核心卖点', purpose: '回答购买理由', body: 'fact',
      factSourceIds: [factSourceId], contentKind: 'fact',
      decisionContract: {
        buyerQuestion: '为什么值得购买？', pageTask: '说明已确认卖点',
        claim: { text: 'fact', factSourceIds: [factSourceId], platforms: ['taobao'], limitations: ['仅适用于当前商品快照'] },
        evidence: { type: 'parameter', sourceIds: [factSourceId], status: 'verified' },
        visualContract: { requiredElements: ['商品与卖点'], protectedElements: ['商品外观'], prohibitedImplications: ['不得扩大未确认效果'], accessibilityText: 'fact' },
        priority: 1, optional: false,
      },
    }],
  }
}

function signedOidcBootstrap(input: { issuer: string; subject: string; nonce: string; displayName: string; externalSubject?: string }) {
  const path = '/mcp'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const authTime = String(Number(timestamp) - 10)
  const sessionExpiresAt = String(Number(timestamp) + 3600)
  const sessionId = `session-${input.nonce}`
  const body = JSON.stringify({ jsonrpc: '2.0', id: input.nonce, method: 'workspace.bootstrap', params: { display_name: input.displayName, ...(input.externalSubject ? { external_subject: input.externalSubject } : {}) } })
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  const canonical = ['POST', path, '', 'workspace', input.issuer, input.subject, sessionId, '', '', authTime, sessionExpiresAt, timestamp, bodyDigest, input.nonce].join('\n')
  const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
  return { body, headers: { 'content-type': 'application/json', 'x-workspace-bootstrap': 'true', 'x-oidc-workbench': 'workspace', 'x-oidc-issuer': input.issuer, 'x-oidc-sub': input.subject, 'x-oidc-sid': sessionId, 'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': sessionExpiresAt, 'x-oidc-timestamp': timestamp, 'x-oidc-body-sha256': bodyDigest, 'x-oidc-nonce': input.nonce, 'x-oidc-signature': signature } }
}

async function configureBearerMembers(entries: Array<{ token: string; workspaceId: string; actorId?: string; role?: 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'; grantWorkspaces?: string[]; gatewayRoles?: string[]; deniedCapabilities?: string[]; workbenches?: Array<'platform' | 'workspace'> }>) {
  const grants: Record<string, { workspaces: string[]; actor_id: string; roles?: string[]; denied_capabilities?: string[]; workbenches: Array<'platform' | 'workspace'> }> = {}
  for (const entry of entries) {
    const actorId = entry.actorId ?? `${entry.token}-actor`
    const role = entry.role ?? 'workspace_owner'
    grants[entry.token] = { workspaces: entry.grantWorkspaces ?? [entry.workspaceId], actor_id: actorId, workbenches: entry.workbenches ?? (role === 'platform_ops' ? ['platform'] : ['workspace']), ...(entry.gatewayRoles ? { roles: entry.gatewayRoles } : {}), ...(entry.deniedCapabilities ? { denied_capabilities: entry.deniedCapabilities } : {}) }
    await workspaceMembers.upsert({ workspaceId: entry.workspaceId, externalSubject: actorId, displayName: actorId, role, status: 'active', invitedBy: 'security-test' })
  }
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
}

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('security and access-control acceptance gates', () => {
  it('rejects malformed audit identity context before the sink is called', () => {
    expect(() => validateOperationAuditContext({
      workspaceId: 'ws_security_audit',
      actorId: 'actor\nforged',
      action: 'authz.decision',
      resourceType: 'mcp_method',
      resourceId: 'catalog.search',
    })).toThrowError(expect.objectContaining({ code: 'AUTHZ_AUDIT_CONTEXT_INVALID' }))
  })
  it('requires full enforcement and durable role authority in production while retaining staged non-production policy tests', () => {
    expect(productionAuthorizationReadiness({ NODE_ENV: 'production', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true' })).toMatchObject({ ready: true, reasons: [], coverage: { mode: 'enforce', enforcement_ratio: 1, shadow_method_count: 0, shadow_domains: [] } })
    expect(productionAuthorizationReadiness({ NODE_ENV: 'production', MCP_AUTHZ_MODE: 'shadow', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true' })).toMatchObject({ ready: false, reasons: ['mcp_authz_mode_not_enforce'] })
    expect(() => mcpAuthorizationRuntimeConfig({}, true, false)).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_RUNTIME_NOT_READY', status: 503 }))
    expect(() => mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'staged', MCP_AUTHZ_ENFORCE_DOMAINS: 'support', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true' }, true, false)).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_RUNTIME_NOT_READY', status: 503 }))
    const production = mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true' }, true, false)
    expect(production.mode).toBe('enforce')

    expect(() => mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'allow-all' }, false, false)).toThrow('MCP_AUTHZ_MODE 仅支持 shadow、staged 或 enforce')
    expect(() => mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'staged' }, false, false)).toThrow('staged 模式必须显式声明至少一个 capability 域')
    expect(() => mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'staged', MCP_AUTHZ_ENFORCE_DOMAINS: 'unknown' }, false, false)).toThrow('未知 capability 域')
    const staged = mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'staged', MCP_AUTHZ_ENFORCE_DOMAINS: 'support,incident' }, false, false)
    expect(staged.mode).toBe('staged')
    expect([...staged.enforceDomains]).toEqual(['support', 'incident'])
    const shadowReport = mcpAuthorizationCoverageReport({ MCP_AUTHZ_MODE: 'shadow' }, false, false)
    expect(shadowReport.enforced_method_count).toBeGreaterThan(0)
    expect(shadowReport.enforced_method_count).toBeLessThan(MCP_METHODS.length)
    expect(shadowReport.enforcement_ratio).toBeGreaterThan(0)
    expect(shadowReport.enforcement_ratio).toBeLessThan(1)
    expect(shadowReport.shadow_method_count).toBe(MCP_METHODS.length - shadowReport.enforced_method_count)
    expect(mcpAuthorizationEnforcedMethods({ MCP_AUTHZ_MODE: 'shadow' }, false, false)).toContain('catalog.image.select')
    // Destructive workspace deletion must never execute under a shadow-only
    // policy rollout: a recorded shadow deny is not a safety boundary.
    expect(mcpAuthorizationEnforcedMethods({ MCP_AUTHZ_MODE: 'shadow' }, false, false)).toContain('workspace.data.delete.request')
    const enforceReport = mcpAuthorizationCoverageReport({ MCP_AUTHZ_MODE: 'enforce' }, false, false)
    expect(enforceReport).toMatchObject({ method_total: MCP_METHODS.length, enforced_method_count: MCP_METHODS.length, shadow_method_count: 0, enforcement_ratio: 1, shadow_domains: [] })
    expect(enforceReport.enforced_domains).toHaveLength(enforceReport.domain_total)
    expect(() => mcpAuthorizationRuntimeConfig({ MCP_AUTHZ_MODE: 'enforce', MCP_AUTHZ_ENFORCE_DOMAINS: 'support' }, false, false)).toThrow('enforce 模式已经覆盖全部 capability 域')
    const stagedMethods = mcpAuthorizationEnforcedMethods({ MCP_AUTHZ_MODE: 'staged', MCP_AUTHZ_ENFORCE_DOMAINS: 'support,incident' }, false, false)
    expect(stagedMethods.length).toBeGreaterThan(shadowReport.enforced_method_count)
    expect(stagedMethods).toEqual(expect.arrayContaining(['ops.support.tickets.list', 'ops.support.ticket.comment', 'ops.incidents.list', 'ops.incident.transition']))
  })
  it('fails closed when production image selection tickets are not backed by Postgres', () => {
    expect(() => assertImageSelectionTicketPersistence({ mode: 'memory', configured: true, production: true, testRuntime: false })).toThrowError(expect.objectContaining({ code: 'IMAGE_SELECTION_TICKET_PERSISTENCE_REQUIRED' }))
    expect(() => assertImageSelectionTicketPersistence({ mode: 'postgres', configured: false, production: true, testRuntime: false })).toThrowError(expect.objectContaining({ code: 'IMAGE_SELECTION_TICKET_PERSISTENCE_REQUIRED' }))
    expect(() => assertImageSelectionTicketPersistence({ mode: 'postgres', configured: true, production: true, testRuntime: false })).not.toThrow()
  })
  it('accepts only the documented narrow DashScope OSS image artifact host shape', () => {
    expect(trustedDashScopeImageArtifactHost('https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/result.png?signature=redacted')).toBe('dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com')
    expect(trustedDashScopeImageArtifactHost('https://dashscope-a717.oss-accelerate.aliyuncs.com/result.png')).toBe('dashscope-a717.oss-accelerate.aliyuncs.com')
    expect(trustedDashScopeImageArtifactHost('https://evil.aliyuncs.com/result.png')).toBeUndefined()
    expect(trustedDashScopeImageArtifactHost('https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com.evil.example/result.png')).toBeUndefined()
    expect(trustedDashScopeImageArtifactHost('http://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/result.png')).toBe('dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com')
  })

  it('pins production video artifacts to the reviewed host allowlist', async () => {
    vi.stubEnv('VIDEO_ARTIFACT_ALLOWED_HOSTS', 'cdn.example.com')
    vi.stubEnv('NODE_ENV', 'test')
    await expect(assertVideoArtifactUrl('https://cdn.example.com/video.mp4')).resolves.toBeUndefined()
    vi.stubEnv('NODE_ENV', 'production')
    await expect(assertVideoArtifactUrl('https://evil.example.com/video.mp4')).rejects.toThrow('HOST_NOT_ALLOWLISTED')
    vi.stubEnv('VIDEO_ARTIFACT_ALLOWED_HOSTS', '')
    await expect(assertVideoArtifactUrl('https://cdn.example.com/video.mp4')).rejects.toThrow('生产环境必须配置视频 artifact 域名白名单')
  })
  it('fails closed in staging instead of trusting caller supplied identity headers', async () => {
    const workspaceId = `ws_staging_auth_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('API_AUTH_TOKENS', '{}')
    const base = await start()
    const call = (headers: Record<string, string>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    }).then(response => response.json() as Promise<Envelope>)
    expect((await call({ 'x-actor-id': 'forged-admin', 'x-role': 'platform_ops' })).error?.code).toBe('UNAUTHENTICATED')

    await configureBearerMembers([{ token: 'staging-token', workspaceId, actorId: 'staging-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] }])
    expect((await call({ authorization: 'Bearer staging-token' })).error).toBeNull()
  })

  it('projects server-computed capabilities and denies a legacy platform_ops emergency mutation', async () => {
    const workspaceId = `ws_authz_projection_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'authz-ops-token', workspaceId, actorId: 'authz-ops', role: 'platform_ops', gatewayRoles: ['platform_ops', 'rules_admin'], deniedCapabilities: ['identity.update'] }])
    const base = await start()
    const call = (method: string, params: Record<string, unknown> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer authz-ops-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const session = await call('ops.session')
    expect(session.error).toBeNull()
    expect(session.data?.result).toMatchObject({
      schema_version: 2,
      workbench: 'platform',
      available_workbenches: ['platform', 'workspace'],
      context_id: 'platform:global',
      roles: ['platform_ops', 'rules_admin'],
      canonical_roles: ['ops_admin', 'rules_admin'],
      policy_version: '2026-08-31.v2',
      denied_capabilities: ['identity.update'],
      scopes: expect.arrayContaining([
        { type: 'self', ids: ['authz-ops'] },
        { type: 'platform', ids: ['*'] },
      ]),
      capabilities: expect.arrayContaining(['feature_flag.update', 'rule.publish.approve']),
    })
    expect(session.data?.result.capabilities).not.toContain('feature_flag.administer')
    expect(session.data?.result.capabilities).not.toContain('identity.update')
    expect(session.data?.result.scopes).not.toEqual(expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]))
    const domainReadCapabilities = {
      overview: ['platform.summary.read', 'workspace.summary.read'],
      users: ['identity.read'],
      support: ['support.ticket.read', 'support.ticket.update'],
      incidents: ['incident.read', 'incident.update', 'incident.administer'],
      tasks: ['marketing.summary.read', 'marketing.queue.read', 'customer.content.read'],
      stores: ['platform.settings.read', 'store.connection.read'],
      rules: ['rule.read', 'platform.media_spec.read'],
      models: ['model.status.read', 'model.cost.read', 'model.policy.update'],
      'feature-flags': ['feature_flag.read', 'feature_flag.update', 'feature_flag.administer'],
      storage: ['storage.reconciliation.read', 'workspace.summary.read'],
      finance: ['billing.self.read', 'billing.workspace.read', 'billing.platform.read', 'commercial.read', 'model.cost.read'],
      audit: ['audit.read', 'audit.export'],
    } as const
    for (const [domain, required] of Object.entries(domainReadCapabilities)) {
      expect(required.some(capability => session.data?.result.capabilities.includes(capability)), `ops.session must project a canonical read capability for ${domain}`).toBe(true)
    }

    const denied = await call('ops.feature-flag.emergency.set', {
      id: 'flag-authz', disabled: 'true', expected_revision: '1', idempotency_key: 'authz-emergency-1', reason: '验证紧急开关服务端拒绝',
    })
    expect(denied.error).toMatchObject({ code: 'FORBIDDEN', details: { capability: 'feature_flag.administer', policy_version: '2026-08-31.v2' } })
    expect(await operationAudits.list(workspaceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'authz-ops', action: 'authz.decision', resourceType: 'mcp_method', resourceId: 'ops.feature-flag.emergency.set', after: expect.objectContaining({ decision_id: denied.error?.details?.decision_id, request_id: expect.any(String), trace_id: expect.any(String), result: 'deny', reason_code: 'AUTHZ_CAPABILITY_MISSING' }) }),
    ]))
  })

  it('fails closed when an enforced authorization decision cannot be persisted to the audit sink', async () => {
    const workspaceId = `ws_authz_audit_failure_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'authz-audit-failure-token', workspaceId, actorId: 'authz-audit-failure-actor', role: 'platform_ops', gatewayRoles: ['platform_ops'] }])
    const append = vi.spyOn(operationAudits, 'append').mockRejectedValueOnce(new Error('AUTHZ_AUDIT_SINK_UNAVAILABLE'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const base = await start()
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer authz-audit-failure-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'authz-audit-failure', method: 'ops.feature-flag.emergency.set', params: { id: 'flag-audit-failure', disabled: 'true', expected_revision: '1', idempotency_key: 'authz-audit-failure-1', reason: '验证授权审计不可用时拒绝请求' } }),
      })
      const body = await response.json() as Envelope
      expect(response.status).toBe(503)
      expect(body.error).toMatchObject({
        code: 'AUTHZ_AUDIT_UNAVAILABLE',
        details: { decision_id: expect.any(String), policy_version: '2026-08-31.v2' },
      })
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actorId: 'authz-audit-failure-actor', action: 'authz.decision', resourceType: 'mcp_method', resourceId: 'ops.feature-flag.emergency.set', after: expect.objectContaining({ result: 'deny', reason_code: 'AUTHZ_CAPABILITY_MISSING' }) }))
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('AUTHZ_AUDIT_UNAVAILABLE'), expect.objectContaining({ message: 'AUTHZ_AUDIT_SINK_UNAVAILABLE' }))
    } finally {
      append.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('binds a dual-role bearer identity to one explicitly allowed workbench without role or scope bleed', async () => {
    const workspaceId = `ws_dual_workbench_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'dual-workbench-token', workspaceId, actorId: 'dual-workbench-actor', role: 'merchant_admin', gatewayRoles: ['platform_ops', 'merchant_admin'], workbenches: ['platform', 'workspace'] }])
    const base = await start()
    const call = (workbench: 'platform' | 'workspace', method: string) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer dual-workbench-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': workbench },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${workbench}-${method}`, method, params: { workspace_id: workspaceId } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const platform = (await call('platform', 'ops.session')).data?.result
    expect(platform).toMatchObject({ schema_version: 2, workbench: 'platform', available_workbenches: ['platform', 'workspace'], roles: ['platform_ops'], canonical_roles: ['ops_admin'], assignable_roles: ['merchant_admin', 'operator', 'support', 'finance', 'platform_ops'], scopes: expect.arrayContaining([{ type: 'platform', ids: ['*'] }]) })
    expect(platform.scopes).not.toEqual(expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]))
    const workspace = (await call('workspace', 'ops.session')).data?.result
    expect(workspace).toMatchObject({ schema_version: 2, workbench: 'workspace', available_workbenches: ['platform', 'workspace'], roles: ['merchant_admin'], canonical_roles: ['workspace_admin'], assignable_roles: ['merchant_admin', 'operator', 'support', 'finance'], scopes: expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]) })
    expect(workspace.scopes).not.toEqual(expect.arrayContaining([{ type: 'platform', ids: ['*'] }]))

    expect((await call('workspace', 'ops.users.list')).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    expect((await call('platform', 'catalog.search')).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
  })

  it('allows a platform ops.session without tenant membership and rejects bearer workbench escalation outside its grant', async () => {
    const workspaceId = `ws_platform_session_route_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'platform-session-token': { workspaces: [], actor_id: 'platform-session-actor', roles: ['platform_ops'], workbenches: ['platform'] },
      'workspace-only-token': { workspaces: [workspaceId], actor_id: 'workspace-only-actor', roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const call = (token: string, workbench: 'platform' | 'workspace', method = 'ops.session') => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(token === 'platform-session-token' ? {} : { 'x-workspace-id': workspaceId }), 'x-ops-workbench': workbench },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${token}-${workbench}-${method}`, method, params: {} }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await call('platform-session-token', 'platform')).data?.result).toMatchObject({ workbench: 'platform', available_workbenches: ['platform'], roles: ['platform_ops'], context_id: 'platform:global' })
    expect((await call('platform-session-token', 'platform', 'catalog.search')).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    expect((await call('workspace-only-token', 'platform')).error?.code).toBe('AUTHZ_WORKBENCH_FORBIDDEN')
    expect((await call('platform-session-token', 'workspace')).error?.code).toBe('AUTHZ_WORKBENCH_FORBIDDEN')
  })

  it('loads and revokes durable platform role assignments on every request', async () => {
    const workspaceId = `ws_durable_platform_role_${Date.now()}`
    const repository = new MemoryAuthorizationRepository()
    setAuthorizationRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'true')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([{ token: 'durable-platform-token', workspaceId, actorId: 'durable-platform-actor', role: 'platform_ops', gatewayRoles: ['platform_ops'], grantWorkspaces: [], workbenches: ['platform'] }])
    const base = await start()
    const call = (method: string) => fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer durable-platform-token', 'content-type': 'application/json', 'x-ops-workbench': 'platform' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: {} }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const initial = (await call('ops.session')).data?.result
    expect(initial).toMatchObject({ roles: [], capabilities: ['authorization.session.read'], authorization_revision: 0, workspace_id: null })
    const assignment = await repository.assignPlatformRole({ subjectIdentityId: initial.identity_id, role: 'ops_admin', assignedBy: 'security-admin', reason: 'grant platform operations', expectedAuthorizationRevision: 0 })
    expect((await call('ops.feature-flags.list')).error).toBeNull()
    const active = (await call('ops.session')).data?.result
    expect(active).toMatchObject({ roles: ['ops_admin'], canonical_roles: ['ops_admin'], authorization_revision: 1 })
    expect(active.effective_permissions).toEqual(expect.arrayContaining([expect.objectContaining({ capability: 'feature_flag.read', source: 'platform_assignment', source_id: assignment.id, revision: '1' })]))
    const matrix = (await call('ops.authorization.matrix.get')).data?.result
    expect(matrix).toMatchObject({ schema_version: 1, policy_version: AUTHZ_POLICY_VERSION, generated_from: 'MCP_METHOD_POLICIES', method_count: MCP_METHODS.length, role_count: expect.any(Number) })
    expect(matrix.items).toHaveLength(MCP_METHODS.length)
    expect(matrix.roles).toEqual(CANONICAL_ROLES)
    expect(matrix.role_count).toBe(CANONICAL_ROLES.length)
    for (const item of matrix.items) {
      expect(Object.keys(item.role_access)).toEqual(CANONICAL_ROLES)
      expect(Object.values(item.role_access).every(access => ['hidden', 'read', 'operate', 'govern'].includes(access as string))).toBe(true)
    }
    expect(matrix.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'ops.session', capability: 'authorization.session.read', role_access: expect.objectContaining({ platform_admin: 'read', viewer: 'read' }) }),
      expect.objectContaining({ method: 'ops.users.list', capability: 'identity.read', workbench: 'platform', effect: 'read', role_access: expect.objectContaining({ platform_admin: 'read', viewer: 'hidden' }) }),
      expect.objectContaining({ method: 'content.generate', capability: 'customer.content.update', workbench: 'workspace', effect: 'write', role_access: expect.objectContaining({ operator: 'operate', viewer: 'hidden' }) }),
    ]))

    await repository.revokePlatformRole({ id: assignment.id, subjectIdentityId: initial.identity_id, actorId: 'security-admin', reason: 'remove platform operations', expectedRevision: 1, expectedAuthorizationRevision: 1 })
    expect((await call('ops.feature-flags.list')).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_CAPABILITY_MISSING' } })
    expect((await call('ops.session')).data?.result).toMatchObject({ roles: [], authorization_revision: 2 })
  })

  it('manages durable platform roles and exact-workspace JIT grants through registered MCP methods', async () => {
    const workspaceId = `ws_authz_admin_${Date.now()}`
    const repository = new MemoryAuthorizationRepository(() => new Date('2026-08-31T04:00:00.000Z'))
    setAuthorizationRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'true')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([{ token: 'authz-admin-token', workspaceId, actorId: 'authz-admin-actor', role: 'platform_ops', gatewayRoles: ['platform_admin'], grantWorkspaces: [], workbenches: ['platform'] }])
    const base = await start()
    const session = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer authz-admin-token', 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.session', params: {} }) }).then(response => response.json() as Promise<Envelope<{ result: { identity_id: string } }>>)
    const adminIdentityId = session.data!.result.identity_id
    await repository.assignPlatformRole({ subjectIdentityId: adminIdentityId, role: 'platform_admin', assignedBy: 'seed', reason: '安全测试管理员', expectedAuthorizationRevision: 0 })
    const call = (method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer authz-admin-token', 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }) }).then(response => response.json() as Promise<Envelope<{ result: any }>>)
    const target = 'identity-managed-target'
    const assigned = await call('ops.authorization.role.assign', { subject_identity_id: target, role: 'support_agent', expected_authorization_revision: '0', reason: '客服值班角色' })
    expect(assigned.error).toBeNull()
    expect(assigned.data?.result).toMatchObject({ subjectIdentityId: target, role: 'support_agent', authorizationRevision: 1 })
    const grant = await call('ops.authorization.grant.issue', { subject_identity_id: target, target_workspace_id: workspaceId, grant_kind: 'support', access_mode: 'read', capabilities_json: '["support.ticket.read"]', resource_scope_json: JSON.stringify({ type: 'workspace', ids: [workspaceId] }), ticket_ref: 'INC-20260831-1', approved_by: 'security-approver', approved_at: '2026-08-31T03:59:00.000Z', expires_at: '2026-08-31T04:10:00.000Z', max_uses: '2', expected_authorization_revision: '1', reason: '处理指定客服工单' })
    expect(grant.error).toBeNull()
    expect(grant.data?.result).toMatchObject({ subjectIdentityId: target, workspaceId, authorizationRevision: 2 })
    const wrongScope = await call('ops.authorization.grant.issue', { subject_identity_id: target, target_workspace_id: workspaceId, grant_kind: 'support', access_mode: 'read', capabilities_json: '["support.ticket.read"]', resource_scope_json: JSON.stringify({ type: 'workspace', ids: ['ws_other'] }), ticket_ref: 'INC-20260831-2', approved_by: 'security-approver', approved_at: '2026-08-31T03:59:00.000Z', expires_at: '2026-08-31T04:10:00.000Z', max_uses: '1', expected_authorization_revision: '2', reason: '越界授权负测' })
    expect(wrongScope.error?.code).toBe('AUTHORIZATION_GRANT_INVALID')
  })

  it('enters a workspace through an exact durable JIT grant and denies the next request after max-use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-31T04:00:00.000Z'))
    const workspaceId = `ws_durable_jit_${Date.now()}`
    const repository = new MemoryAuthorizationRepository(() => new Date('2026-08-31T04:00:00.000Z'))
    setAuthorizationRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'durable-jit-token': { workspaces: [workspaceId], actor_id: 'durable-jit-actor', roles: ['platform_ops'], workbenches: ['platform', 'workspace'] },
    }))
    const base = await start()
    const call = (workbench: 'platform' | 'workspace', method: string) => fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer durable-jit-token', 'content-type': 'application/json', 'x-ops-workbench': workbench, ...(workbench === 'workspace' ? { 'x-workspace-id': workspaceId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${workbench}-${method}`, method, params: {} }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const platformSession = (await call('platform', 'ops.session')).data?.result
    const grant = await repository.issueGrant({ grantKind: 'support', accessMode: 'read', subjectIdentityId: platformSession.identity_id, workspaceId, capabilities: ['support.ticket.read'], resourceScope: { type: 'workspace', ids: [workspaceId] }, reason: 'investigate merchant support case', ticketRef: `SUP-${Date.now()}`, issuedBy: 'support-lead', approvedBy: 'security-approver', approvedAt: '2026-08-31T03:59:00.000Z', expectedAuthorizationRevision: 0, expiresAt: '2026-08-31T04:15:00.000Z', maxUses: 1 })
    const workspaceSession = (await call('workspace', 'ops.session')).data?.result
    expect(workspaceSession).toMatchObject({ canonical_roles: [], authorization_revision: 1, context: { access_mode: 'temporary_support', workspace_id: workspaceId } })
    expect(workspaceSession.effective_permissions).toEqual(expect.arrayContaining([expect.objectContaining({ capability: 'support.ticket.read', source: 'temporary_grant', source_id: grant.id, effect_limit: 'read' })]))

    expect((await call('workspace', 'ops.support.tickets.list')).error).toBeNull()
    expect((await call('workspace', 'ops.support.tickets.list')).error?.code).toBe('WORKSPACE_MEMBERSHIP_REQUIRED')
  })

  it('keeps an active member on direct role access without consuming an unrelated grant', async () => {
    const workspaceId = `ws_member_direct_grant_${Date.now()}`
    const actorId = `member-direct-actor-${Date.now()}`
    const repository = new MemoryAuthorizationRepository(() => new Date('2026-08-31T04:00:00.000Z'))
    setAuthorizationRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([{ token: 'member-direct-token', workspaceId, actorId, role: 'operator', gatewayRoles: ['operator'] }])
    const base = await start()
    const call = (method: string) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer member-direct-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: {} }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const identityId = (await call('ops.session')).data?.result.identity_id
    const grant = await repository.issueGrant({ grantKind: 'support', accessMode: 'read', subjectIdentityId: identityId, workspaceId, capabilities: ['support.ticket.read'], resourceScope: { type: 'workspace', ids: [workspaceId] }, reason: 'unrelated support investigation', ticketRef: `DIRECT-${Date.now()}`, issuedBy: 'support-lead', approvedBy: 'security-approver', approvedAt: '2026-08-31T03:59:00.000Z', expectedAuthorizationRevision: 0, expiresAt: '2026-08-31T04:15:00.000Z', maxUses: 1 })

    expect((await call('ops.marketing.queue')).error).toBeNull()
    const session = (await call('ops.session')).data?.result
    expect(session).toMatchObject({ roles: ['operator'], canonical_roles: ['operator'], context: { access_mode: 'direct', workspace_id: workspaceId } })
    expect(await repository.getGrant(grant.id, identityId)).toMatchObject({ useCount: 0, revision: 1, authorizationRevision: 1 })
  })

  it('rejects a suspended member before an exact grant can be consumed', async () => {
    const workspaceId = `ws_suspended_exact_grant_${Date.now()}`
    const actorId = `suspended-exact-actor-${Date.now()}`
    const repository = new MemoryAuthorizationRepository(() => new Date('2026-08-31T04:00:00.000Z'))
    setAuthorizationRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([{ token: 'suspended-exact-token', workspaceId, actorId, role: 'operator', gatewayRoles: ['operator'] }])
    const base = await start()
    const call = (method: string) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer suspended-exact-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: {} }),
    }).then(async response => ({ status: response.status, body: await response.json() as Envelope<{ result: any }> }))

    const identityId = (await call('ops.session')).body.data?.result.identity_id
    const grant = await repository.issueGrant({ grantKind: 'support', accessMode: 'read', subjectIdentityId: identityId, workspaceId, capabilities: ['marketing.queue.read'], resourceScope: { type: 'workspace', ids: [workspaceId] }, reason: 'exact queue investigation', ticketRef: `SUSPENDED-${Date.now()}`, issuedBy: 'support-lead', approvedBy: 'security-approver', approvedAt: '2026-08-31T03:59:00.000Z', expectedAuthorizationRevision: 0, expiresAt: '2026-08-31T04:15:00.000Z', maxUses: 1 })
    await workspaceMembers.suspend({ workspaceId, externalSubject: actorId, actorId: 'security-admin', reason: 'security suspension' })

    const denied = await call('ops.marketing.queue')
    expect(denied.status).toBe(403)
    expect(denied.body.error?.code).toBe('MEMBER_SUSPENDED')
    expect(await repository.getGrant(grant.id, identityId)).toMatchObject({ useCount: 0, revision: 1, authorizationRevision: 1 })
  })

  it('admits a non-member through the exact marketing queue grant and rejects after max-use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-31T04:00:00.000Z'))
    const workspaceId = `ws_queue_exact_grant_${Date.now()}`
    const repository = new MemoryAuthorizationRepository(() => new Date('2026-08-31T04:00:00.000Z'))
    setAuthorizationRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'queue-exact-token': { workspaces: [workspaceId], actor_id: `queue-exact-actor-${Date.now()}`, roles: ['platform_ops'], workbenches: ['platform', 'workspace'] },
    }))
    const base = await start()
    const call = (workbench: 'platform' | 'workspace', method: string) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer queue-exact-token', 'content-type': 'application/json', 'x-ops-workbench': workbench, ...(workbench === 'workspace' ? { 'x-workspace-id': workspaceId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${workbench}-${method}`, method, params: {} }),
    }).then(async response => ({ status: response.status, body: await response.json() as Envelope<{ result: any }> }))

    const identityId = (await call('platform', 'ops.session')).body.data?.result.identity_id
    const grant = await repository.issueGrant({ grantKind: 'support', accessMode: 'read', subjectIdentityId: identityId, workspaceId, capabilities: ['marketing.queue.read'], resourceScope: { type: 'workspace', ids: [workspaceId] }, reason: 'one queue inspection', ticketRef: `QUEUE-${Date.now()}`, issuedBy: 'support-lead', approvedBy: 'security-approver', approvedAt: '2026-08-31T03:59:00.000Z', expectedAuthorizationRevision: 0, expiresAt: '2026-08-31T04:15:00.000Z', maxUses: 1 })

    const admitted = await call('workspace', 'ops.marketing.queue')
    expect(admitted.status).toBe(200)
    expect(admitted.body.error).toBeNull()
    expect(await repository.getGrant(grant.id, identityId)).toMatchObject({ useCount: 1, revision: 2, authorizationRevision: 2 })
    const exhausted = await call('workspace', 'ops.marketing.queue')
    expect(exhausted.status).toBe(403)
    expect(exhausted.body.error?.code).toBe('WORKSPACE_MEMBERSHIP_REQUIRED')
    expect(await repository.getGrant(grant.id, identityId)).toMatchObject({ useCount: 1, revision: 2, authorizationRevision: 2 })
  })

  it('rejects an authenticated x-actor-id mismatch at the strict global identity boundary', async () => {
    const workspaceId = `ws_actor_mismatch_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([{ token: 'actor-mismatch-token', workspaceId, actorId: 'authenticated-actor', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] }])
    const base = await start()
    const headers = { authorization: 'Bearer actor-mismatch-token', 'x-workspace-id': workspaceId, 'x-actor-id': 'forged-actor' }
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    })
    const rest = await fetch(`${base}/v1/products`, { headers })

    expect(mcp.status).toBe(403)
    expect((await mcp.json() as Envelope).error?.code).toBe('FORBIDDEN')
    expect(rest.status).toBe(403)
    expect((await rest.json() as Envelope).error?.code).toBe('FORBIDDEN')
  })

  it('rechecks the exact consumed grant row before a critical worker executes', async () => {
    const workspaceId = `ws_worker_grant_${Date.now()}`
    const identityId = `identity-worker-grant-${Date.now()}`
    const issuedAt = Date.now()
    const repository = new MemoryAuthorizationRepository(() => new Date(issuedAt))
    setAuthorizationRepositoryForTests(repository)
    const grant = await repository.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: identityId, workspaceId, capabilities: ['catalog.sync.execute'], resourceScope: { type: 'workspace', ids: [workspaceId] }, reason: 'approved catalog repair', ticketRef: `WORKER-${Date.now()}`, issuedBy: 'ops-lead', approvedBy: 'security-approver', approvedAt: new Date(issuedAt - 1_000).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(issuedAt + 4 * 60_000).toISOString(), maxUses: 1 })
    const consumed = await repository.consumeGrant({ id: grant.id, subjectIdentityId: identityId, workspaceId, capability: 'catalog.sync.execute', scopeHash: grant.scopeHash, expectedRevision: grant.revision, actorId: 'support-operator', reason: 'enqueue approved catalog repair' })
    expect(consumed).toBeDefined()
    const snapshot = { schemaVersion: 1 as const, decisionId: 'authz-worker-grant', actorId: 'support-operator', identityId, workspaceId, workbench: 'workspace' as const, contextId: `workspace:${workspaceId}`, contextVersion: 'authz-v1', policyVersion: 'authz-v1', grantRevision: `grant:${grant.id}:${consumed!.revision}:${identityId}:${consumed!.authorizationRevision}`, grantIds: [] as string[], scopeHash: grant.scopeHash, capability: 'catalog.sync.execute' as const, resourceId: 'sync-job-1', resourceRevision: '1', requestId: 'req_worker_grant', traceId: 'req_worker_grant', authorized: true as const, decidedAt: new Date(issuedAt).toISOString() }

    await expect(recheckWorkerAuthorizationSnapshot(snapshot, workspaceId, 'sync-job-1')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
    await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot, grantRevision: `grant:forged:${consumed!.revision}:${identityId}:${consumed!.authorizationRevision}` }, workspaceId, 'sync-job-1')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
    await repository.revokeGrant({ id: grant.id, subjectIdentityId: identityId, actorId: 'security-approver', reason: 'withdraw worker authority', expectedRevision: consumed!.revision, expectedAuthorizationRevision: consumed!.authorizationRevision })
    await expect(recheckWorkerAuthorizationSnapshot(snapshot, workspaceId, 'sync-job-1')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
  })

  it('re-authorizes publish reconciliation against the current membership role instead of relabeling the publish snapshot', async () => {
    const workspaceId = `ws_worker_continuation_${Date.now()}`
    const identityId = `identity-worker-continuation-${Date.now()}`
    const actorId = `worker-continuation-${Date.now()}`
    setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'operator', status: 'active', invitedBy: 'security-test' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: actorId, identityId })
    const snapshot = { schemaVersion: 1 as const, decisionId: 'authz-publish-source', actorId, identityId, workspaceId, workbench: 'workspace' as const, contextId: `workspace:${workspaceId}`, contextVersion: '2026-08-31.v1', policyVersion: '2026-08-31.v1', grantRevision: `membership:${identityId}:0`, grantIds: [] as string[], scopeHash: 'a'.repeat(64), capability: 'publish.execute' as const, resourceId: 'publish-job-1', resourceRevision: '1', requestId: 'req_worker_continuation', traceId: 'req_worker_continuation', authorized: true as const, decidedAt: new Date().toISOString() }

    await expect(deriveWorkerContinuationAuthorizationSnapshot(snapshot, workspaceId, 'publish-job-1', 'publish.reconcile', { event: 'publish.reconcile_requested' })).resolves.toMatchObject({
      capability: 'publish.reconcile',
      resourceId: 'publish-job-1',
      authorized: true,
    })

    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'support', status: 'active', invitedBy: 'security-test' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: actorId, identityId })
    await expect(recheckWorkerAuthorizationSnapshot(snapshot, workspaceId, 'publish-job-1')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
  })

  it('denies a publish reconciliation continuation when the source JIT grant lacks the read capability', async () => {
    const workspaceId = `ws_worker_continuation_grant_${Date.now()}`
    const identityId = `identity-worker-continuation-grant-${Date.now()}`
    const issuedAt = Date.now()
    const repository = new MemoryAuthorizationRepository(() => new Date(issuedAt))
    setAuthorizationRepositoryForTests(repository)
    const grant = await repository.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: identityId, workspaceId, capabilities: ['customer.publish.execute'], resourceScope: { type: 'workspace', ids: [workspaceId] }, reason: 'one publish only', ticketRef: `PUBLISH-${Date.now()}`, issuedBy: 'ops-lead', approvedBy: 'security-approver', approvedAt: new Date(issuedAt - 1_000).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(issuedAt + 4 * 60_000).toISOString(), maxUses: 1 })
    const consumed = await repository.consumeGrant({ id: grant.id, subjectIdentityId: identityId, workspaceId, capability: 'customer.publish.execute', scopeHash: grant.scopeHash, expectedRevision: grant.revision, actorId: 'temporary-publisher', reason: 'enqueue one publish' })
    const snapshot = { schemaVersion: 1 as const, decisionId: 'authz-publish-grant-source', actorId: 'temporary-publisher', identityId, workspaceId, workbench: 'workspace' as const, contextId: `workspace:${workspaceId}`, contextVersion: '2026-08-31.v1', policyVersion: '2026-08-31.v1', grantRevision: `grant:${grant.id}:${consumed!.revision}:${identityId}:${consumed!.authorizationRevision}`, grantIds: [grant.id], scopeHash: grant.scopeHash, capability: 'publish.execute' as const, resourceId: 'publish-job-grant-1', resourceRevision: '1', requestId: 'req_worker_continuation_grant', traceId: 'req_worker_continuation_grant', authorized: true as const, decidedAt: new Date(issuedAt).toISOString() }

    await expect(deriveWorkerContinuationAuthorizationSnapshot(snapshot, workspaceId, 'publish-job-grant-1', 'publish.reconcile', { event: 'publish.reconcile_requested' })).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
  })

  it('denies automation policy changes by support members in staging', async () => {
    const workspaceId = `ws_staging_automation_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    await configureBearerMembers([{ token: 'staging-support-token', workspaceId, actorId: 'staging-support', role: 'support', gatewayRoles: ['support'] }])
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `support-${Date.now()}`, credentialRef: 'vault://security/staging-support' })
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer staging-support-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'automation.policy.update', params: { workspace_id: workspaceId, platform: 'taobao', account_id: account.id, enabled: 'true', reason: '越权开启自动化尝试' } }),
    }).then(value => value.json() as Promise<Envelope>)
    expect(response.error?.code).toBe('FORBIDDEN')
  })

  it('keeps platform_ops out of customer marketing data while preserving platform summaries', async () => {
    const workspaceId = `ws_platform_ops_boundary_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'platform-boundary-token', workspaceId, actorId: 'platform-boundary-actor', role: 'platform_ops', gatewayRoles: ['platform_ops'] }])
    const base = await start()
    const call = (method: string, params: Record<string, unknown> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-boundary-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope>)

    const customerDataMethods = [
      ['ops.marketing.queue', {}],
      ['ops.audit.detail', { source: 'operation', id: 'audit-unknown' }],
      ['ops.marketing.queue.assign', { item_type: 'generation', item_id: 'job_unknown', operator_id: 'operator', reason: '越权测试' }],
      ['ops.marketing.visual.review', { visual_refs_json: '["visual_unknown"]', status: 'passed', reason: '越权测试' }],
      ['ops.marketing.generation.retry', { job_id: 'job_unknown', reason: '越权测试' }],
      ['ops.marketing.publish.acknowledge', { publish_job_id: 'publish_unknown', reason: '越权测试' }],
      ['ops.marketing.revision.create', { publish_job_id: 'publish_unknown', changes_json: '{}', reason: '越权测试' }],
      ['ops.support.tickets.list', { limit: '10' }],
      ['ops.support.crm.export', { limit: '10' }],
    ] as const
    for (const [method, params] of customerDataMethods) {
      const errorCode = (await call(method, params)).error?.code
      expect(errorCode, `${method} must deny the platform workbench before customer-data handling`).toBe('FORBIDDEN')
    }
    expect((await call('ops.workspaces.list')).error).toBeNull()
    const brandSummary = await call('ops.brand-units.summary', { platform_scope: 'platform' })
    expect(brandSummary.error).toBeNull()
    expect(brandSummary.data?.result).toMatchObject({ scope: 'platform', brandCount: expect.any(Number), boundStoreCount: expect.any(Number), unboundBrandCount: expect.any(Number), canonicalProductCount: expect.any(Number), listingCount: expect.any(Number) })
    expect(JSON.stringify(brandSummary.data?.result)).not.toContain('品牌')
    expect((await call('ops.brand-units.summary')).error?.code).toBe('INVALID_REQUEST')
    expect((await call('ops.storage.reconciliation.list')).error?.code).toBe('INVALID_REQUEST')
    expect((await call('ops.storage.reconciliation.list', { platform_scope: 'platform' })).error?.code).not.toBe('INVALID_REQUEST')

    const revoked = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `platform-alert-${Date.now()}`, credentialRef: 'vault://security/platform-alert' })
    revoked.tokenState = 'revoked'
    service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `platform-automation-${Date.now()}`, credentialRef: 'vault://security/platform-automation' })
    const platformAlerts = await call('ops.alerts.list', { platform_scope: 'platform' })
    expect(platformAlerts.error).toBeNull()
    expect(platformAlerts.data?.result).toMatchObject({ aggregate: true, items: expect.any(Array) })
    expect(JSON.stringify(platformAlerts.data?.result)).not.toContain(workspaceId)
    expect(JSON.stringify(platformAlerts.data?.result)).not.toContain(revoked.id)
    expect((await call('ops.alerts.list', { platform_scope: 'platform', entity_id: revoked.id })).error?.code).toBe('OPS_CUSTOMER_ACCESS_REQUIRED')
    expect((await call('ops.alert.ack', { alert_id: 'customer-alert-guess', reason: '平台越权确认测试' })).error?.code).not.toBe('OPS_CUSTOMER_ACCESS_REQUIRED')
    const platformStores = await call('ops.stores.list', { platform_scope: 'platform' })
    expect(platformStores.error).toBeNull()
    expect(platformStores.data?.result).toMatchObject({ aggregate: true, items: expect.any(Array) })
    expect(JSON.stringify(platformStores.data?.result)).not.toContain(workspaceId)
    expect(JSON.stringify(platformStores.data?.result)).not.toContain(revoked.id)
    const automationPolicies = await call('automation.policy.list', { platform_scope: 'platform' })
    expect(automationPolicies.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    const platformDeletion = await call('ops.data.delete.list', { platform_scope: 'platform', limit: '50' })
    expect(platformDeletion.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })

    const restHeaders = { authorization: 'Bearer platform-boundary-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const accounts = await fetch(`${base}/v1/platform-accounts`, { headers: restHeaders }).then(response => response.json() as Promise<Envelope>)
    expect(accounts.error, 'REST platform workbench must fail at the shared capability boundary before customer-data handling').toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    const authorize = await fetch(`${base}/v1/platform-accounts/taobao/authorize`, { method: 'POST', headers: restHeaders, body: JSON.stringify({}) }).then(response => response.json() as Promise<Envelope>)
    expect(authorize.error, 'REST platform workbench must fail at the shared capability boundary before customer-data handling').toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    expect((await call('platform.connect', { platform: 'taobao' })).error, 'MCP platform workbench must reject a workspace policy before customer-data handling').toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
  })

  it('protects the production metrics endpoint with an explicit scrape credential', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('METRICS_AUTH_TOKEN', '')
    const base = await start()
    const response = await fetch(`${base}/metrics`)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'METRICS_AUTH_NOT_CONFIGURED' })
  })

  it('fails closed when an authenticated production identity has no active workspace membership', async () => {
    const workspaceId = `ws_member_gate_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'member-gate-token': { workspaces: [workspaceId], actor_id: 'member-gate-user' } }))
    const base = await start()
    const call = () => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer member-gate-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    })

    const denied = await call()
    expect(denied.status).toBe(403)
    expect((await denied.json() as Envelope).error?.code).toBe('WORKSPACE_MEMBERSHIP_REQUIRED')

    await workspaceMembers.upsert({ workspaceId, externalSubject: 'member-gate-user', displayName: '成员门禁测试', role: 'workspace_owner', status: 'active', invitedBy: 'bootstrap' })
    const allowed = await call()
    expect(allowed.status).toBe(200)
  })

  it('applies workspace membership and brand-profile write roles to the REST surface', async () => {
    const workspaceId = `ws_brand_http_boundary_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    await configureBearerMembers([
      { token: 'brand-http-owner-token', workspaceId, actorId: 'brand-http-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: 'brand-http-support-token', workspaceId, actorId: 'brand-http-support', role: 'support', gatewayRoles: ['support'] },
      { token: 'brand-http-ops-token', workspaceId, actorId: 'brand-http-ops', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-http-owner-token': { workspaces: [workspaceId], actor_id: 'brand-http-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
      'brand-http-support-token': { workspaces: [workspaceId], actor_id: 'brand-http-support', roles: ['support'], workbenches: ['workspace'] },
      'brand-http-ops-token': { workspaces: [workspaceId], actor_id: 'brand-http-ops', roles: ['platform_ops'], workbenches: ['platform'] },
      'brand-http-orphan-token': { workspaces: [workspaceId], actor_id: 'brand-http-orphan', workbenches: ['workspace'] },
    }))
    const base = await start()
    const call = (token: string, method: 'GET' | 'PUT', body?: Record<string, unknown>) => fetch(`${base}/v1/brand-profile`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(response => response.json() as Promise<Envelope>)

    expect((await call('brand-http-orphan-token', 'GET')).error?.code).toBe('WORKSPACE_MEMBERSHIP_REQUIRED')
    expect((await call('brand-http-support-token', 'PUT', { name: '越权品牌' })).error?.code).toBe('FORBIDDEN')
    expect((await call('brand-http-owner-token', 'PUT', { name: '工作区品牌' })).error).toBeNull()
    expect((await call('brand-http-owner-token', 'GET')).data).toMatchObject({ profile: { name: '工作区品牌' } })
    expect((await call('brand-http-ops-token', 'GET')).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    expect((await call('brand-http-ops-token', 'PUT', { name: '平台直写' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
  })

  it('rejects a workspace member whose stored role exceeds the signed identity role', async () => {
    const workspaceId = `ws_member_role_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'member-role-token': { workspaces: [workspaceId], actor_id: 'member-role-user', roles: ['operator'] } }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'member-role-user', displayName: '角色冲突测试', role: 'workspace_owner', status: 'active', invitedBy: 'bootstrap' })
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer member-role-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    })
    expect(response.status).toBe(403)
    expect((await response.json() as Envelope).error?.code).toBe('MEMBER_ROLE_MISMATCH')
  })

  it('restricts the cross-workspace user directory and suspension to platform operations', async () => {
    const workspaceId = `ws_user_governance_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'tenant-admin-token', workspaceId, actorId: 'tenant-admin', role: 'merchant_admin', gatewayRoles: ['merchant_admin'] },
      { token: 'platform-ops-token', workspaceId, actorId: 'platform-operator', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'target-user', displayName: '待停用用户', role: 'operator', status: 'active', invitedBy: 'security-test' })
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await call('tenant-admin-token', 'ops.users.list')).error?.code).toBe('FORBIDDEN')
    expect((await call('tenant-admin-token', 'ops.user.detail', { external_subject: 'target-user' })).error?.code).toBe('FORBIDDEN')
    expect((await call('tenant-admin-token', 'ops.user.suspend', { external_subject: 'target-user', reason: '越权停用尝试' })).error?.code).toBe('FORBIDDEN')
    expect((await call('tenant-admin-token', 'ops.member.upsert', { external_subject: 'target-user', role: 'platform_ops', reason: '越权授予平台角色' })).error?.code).toBe('PLATFORM_ROLE_GRANT_DENIED')
    expect((await call('tenant-admin-token', 'ops.member.upsert', { external_subject: 'target-user', role: 'workspace_owner', reason: '越权授予所有者角色' })).error?.code).toBe('WORKSPACE_OWNER_GRANT_DENIED')
    expect((await call('tenant-admin-token', 'ops.member.upsert', { external_subject: 'target-user', role: 'support', expected_revision: '1', reason: '调整租户内角色' })).data?.result).toMatchObject({ role: 'support', status: 'active' })
    const directory = await call('platform-ops-token', 'ops.users.list', { query: 'target-user' })
    expect(directory.data?.result).toMatchObject({ total: 1, items: [expect.objectContaining({ externalSubject: 'target-user', status: 'active' })] })
    expect((await call('platform-ops-token', 'ops.user.suspend', { external_subject: 'target-user', expected_revision: '2', reason: '安全测试停用' })).data?.result).toMatchObject({ status: 'suspended' })
    expect((await call('platform-ops-token', 'ops.user.suspend', { external_subject: 'platform-operator', reason: '自我停用尝试' })).error?.code).toBe('SELF_SUSPENSION_DENIED')
    expect((await call('platform-ops-token', 'ops.user.activate', { external_subject: 'target-user', expected_revision: '3', reason: '安全测试恢复' })).data?.result).toMatchObject({ status: 'active' })
    const detail = await call('platform-ops-token', 'ops.user.detail', { external_subject: 'target-user' })
    expect(detail.data?.result).toMatchObject({
      identity: { externalSubject: 'target-user', displayName: '待停用用户', membershipCount: 1, activeMembershipCount: 1 },
      memberships: [expect.objectContaining({ workspaceId, role: 'support', status: 'active' })],
    })
    expect(detail.data?.result.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'user.suspend', reason: '安全测试停用' }),
      expect.objectContaining({ action: 'user.activate', reason: '安全测试恢复' }),
    ]))
    expect((await call('platform-ops-token', 'ops.user.activate', { external_subject: 'target-user', expected_revision: '4', reason: '重复恢复尝试' })).error?.code).toBe('MEMBER_ALREADY_ACTIVE')
  })

  it('keeps global commercial catalogs platform-owned while tenant admins only manage their own rollout', async () => {
    const workspaceId = `ws_commercial_scope_${Date.now()}`
    const otherWorkspaceId = `${workspaceId}_other`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'commercial-admin-token', workspaceId, actorId: 'commercial-admin', role: 'merchant_admin', gatewayRoles: ['merchant_admin'] },
      { token: 'commercial-platform-token', workspaceId, actorId: 'commercial-platform', role: 'platform_ops', gatewayRoles: ['platform_ops'], grantWorkspaces: [workspaceId, otherWorkspaceId] },
    ])
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const suffix = Date.now().toString(36)
    const catalogWrites = [
      ['ops.commercial.offer.upsert', { code: `offer-${suffix}`, name: 'Global Offer', billing_cycle: 'monthly', price_cny: '99.00', included_stores: '1', included_tasks: '10', reason: '权限边界回归' }],
      ['ops.commercial.addon.upsert', { code: `addon-${suffix}`, name: 'Global Addon', kind: 'bulk_sync', price_cny: '19.00', units: '10', reason: '权限边界回归' }],
      ['ops.commercial.coupon.upsert', { code: `coupon-${suffix}`, discount_type: 'percent', discount_value: '10.00', max_redemptions: '100', reason: '权限边界回归' }],
    ] as const
    for (const [method, params] of catalogWrites) {
      expect((await call('commercial-admin-token', method, params)).error?.code).toBe('FORBIDDEN')
      expect((await call('commercial-platform-token', method, params)).error).toBeNull()
    }

    const ownRollout = { offer_code: `offer-${suffix}`, target_workspace_id: workspaceId, percentage: '25', enabled: 'true', reason: '租户内灰度' }
    expect((await call('commercial-admin-token', 'ops.commercial.rollout.upsert', ownRollout)).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    expect((await call('commercial-admin-token', 'ops.commercial.rollout.upsert', { ...ownRollout, target_workspace_id: otherWorkspaceId })).error?.code).toBe('FORBIDDEN')
    const { target_workspace_id: _targetWorkspaceId, ...globalRollout } = ownRollout
    expect((await call('commercial-platform-token', 'ops.commercial.rollout.upsert', globalRollout)).data?.result).not.toHaveProperty('workspaceId')
    expect((await call('commercial-platform-token', 'ops.commercial.rollout.upsert', { ...ownRollout, target_workspace_id: otherWorkspaceId })).error).toBeNull()
  })

  it('globally suspends an identity, revokes its sessions, and does not revive old sessions on activation', async () => {
    const workspaceId = `ws_identity_lifecycle_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'identity-target-token', workspaceId, actorId: 'identity-target', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'identity-target-fresh-token', workspaceId, actorId: 'identity-target', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'identity-platform-token', workspaceId, actorId: 'identity-platform-ops', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const targetSession = await call('identity-target-token', 'ops.session')
    const identityId = targetSession.data?.result.identity_id as string
    expect(identityId).toMatch(/^[a-f0-9-]{36}$/)
    const detail = await call('identity-platform-token', 'ops.user.detail', { identity_id: identityId })
    expect(detail.data?.result.sessions[0]).not.toHaveProperty('providerSessionHash')
    const revision = detail.data?.result.identity.revision as number

    const suspended = await call('identity-platform-token', 'ops.user.suspend', { scope: 'identity', identity_id: identityId, expected_revision: String(revision), idempotency_key: 'suspend-identity-1', reason: '全局安全停用测试' })
    expect(suspended.data?.result).toMatchObject({ identity: { accessStatus: 'suspended' }, revokedSessionIds: [expect.any(String)] })
    expect((await call('identity-target-token', 'ops.session')).error?.code).toBe('IDENTITY_SUSPENDED')

    const activated = await call('identity-platform-token', 'ops.user.activate', { scope: 'identity', identity_id: identityId, expected_revision: String(suspended.data?.result.identity.revision), idempotency_key: 'activate-identity-1', reason: '安全复核后恢复身份' })
    expect(activated.data?.result.identity.accessStatus).toBe('active')
    expect((await call('identity-target-token', 'ops.session')).error?.code).toBe('SESSION_REVOKED')

    const freshSession = await call('identity-target-fresh-token', 'ops.session')
    expect(freshSession.error).toBeNull()
    const refreshedDetail = await call('identity-platform-token', 'ops.user.detail', { identity_id: identityId })
    const activeSession = refreshedDetail.data?.result.sessions.find((session: { id: string }) => session.id === freshSession.data?.result.session_id)
    expect(activeSession).toMatchObject({ status: 'active', revision: 1 })
    expect((await call('identity-platform-token', 'ops.user.session.revoke', { identity_id: identityId, session_id: activeSession.id, expected_revision: String(activeSession.revision), idempotency_key: 'revoke-fresh-session-1', reason: '撤销可疑新会话' })).data?.result.session.status).toBe('revoked')
    expect((await call('identity-target-fresh-token', 'ops.session')).error?.code).toBe('SESSION_REVOKED')
  })

  it('applies role-protected identity risk transitions with step-up, optimistic concurrency, and session revocation', async () => {
    const workspaceId = `ws_identity_risk_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'risk-target-token', workspaceId, actorId: 'risk-target', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'risk-target-fresh-token', workspaceId, actorId: 'risk-target', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'risk-admin-token', workspaceId, actorId: 'risk-admin', role: 'merchant_admin', gatewayRoles: ['merchant_admin'] },
      { token: 'risk-platform-token', workspaceId, actorId: 'risk-platform', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const targetSession = await call('risk-target-token', 'ops.session')
    const identityId = targetSession.data?.result.identity_id as string
    const detail = await call('risk-platform-token', 'ops.user.detail', { identity_id: identityId })
    const initialRevision = detail.data?.result.identity.revision as number
    const transition = (token: string, input: Record<string, string>) => call(token, 'ops.user.risk.transition', {
      identity_id: identityId,
      risk_level: 'high',
      risk_decision: 'step_up',
      expected_revision: String(initialRevision),
      idempotency_key: 'risk-step-up-1',
      reason: '检测到异地登录，需要二次验证',
      evidence_json: '{"signal":"impossible_travel"}',
      ...input,
    })

    expect((await transition('risk-admin-token', {})).error?.code).toBe('FORBIDDEN')
    expect((await transition('risk-platform-token', { evidence_json: '[]' })).error?.code).toBe('INVALID_REQUEST')
    const steppedUp = await transition('risk-platform-token', {})
    expect(steppedUp.data?.result.identity).toMatchObject({ riskLevel: 'high', riskDecision: 'step_up', revision: initialRevision + 1 })
    expect((await call('risk-target-token', 'ops.session')).error?.code).toBe('IDENTITY_STEP_UP_REQUIRED')

    const stale = await transition('risk-platform-token', { risk_level: 'low', risk_decision: 'allow', idempotency_key: 'risk-allow-stale' })
    expect(stale.error?.code).toBe('IDENTITY_REVISION_CONFLICT')
    const allowed = await transition('risk-platform-token', { risk_level: 'low', risk_decision: 'allow', expected_revision: String(initialRevision + 1), idempotency_key: 'risk-allow-1', reason: '二次验证完成，解除风险限制' })
    expect(allowed.data?.result.identity).toMatchObject({ riskLevel: 'low', riskDecision: 'allow', revision: initialRevision + 2 })
    expect((await call('risk-target-token', 'ops.session')).error?.code).toBe('SESSION_REVOKED')
    expect((await call('risk-target-fresh-token', 'ops.session')).error).toBeNull()

    const blocked = await transition('risk-platform-token', { risk_level: 'critical', risk_decision: 'block', expected_revision: String(initialRevision + 2), idempotency_key: 'risk-block-1', reason: '确认凭证泄露，阻断身份并撤销会话' })
    expect(blocked.data?.result).toMatchObject({ identity: { riskLevel: 'critical', riskDecision: 'block' }, revokedSessionIds: [expect.any(String)] })
    expect((await call('risk-target-fresh-token', 'ops.session')).error?.code).toBe('IDENTITY_RISK_BLOCKED')
  })

  it('restricts the global model markup policy to platform operations', async () => {
    const workspaceId = `ws_model_markup_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'markup-owner-token', workspaceId, actorId: 'markup-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: 'markup-finance-token', workspaceId, actorId: 'markup-finance', role: 'finance', gatewayRoles: ['finance'] },
      { token: 'markup-platform-token', workspaceId, actorId: 'markup-platform', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await call('markup-owner-token', 'ops.commercial.model-markup.get')).error?.code).toBe('FORBIDDEN')
    expect((await call('markup-finance-token', 'ops.commercial.model-markup.update', { multiplier: '3.000', expected_revision: '1', reason: '越权修改' })).error?.code).toBe('FORBIDDEN')
    const current = await call('markup-platform-token', 'ops.commercial.model-markup.get')
    expect(current.error).toBeNull()
    const policy = current.data?.result as { multiplier: number; revision: number }
    const updated = await call('markup-platform-token', 'ops.commercial.model-markup.update', { multiplier: policy.multiplier.toFixed(3), expected_revision: String(policy.revision), reason: '平台运营权限回归验证' })
    expect(updated.error).toBeNull()
    expect(updated.data?.result).toMatchObject({ multiplier: policy.multiplier, revision: policy.revision + 1, updatedBy: 'markup-platform' })
  })

  it('redacts provider model costs from merchant reconciliation roles', async () => {
    const workspaceId = `ws_cost_redaction_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'merchant-cost-token', workspaceId, actorId: 'merchant-cost-user', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'finance-cost-token', workspaceId, actorId: 'finance-cost-user', role: 'finance', gatewayRoles: ['finance'] },
    ])
    const base = await start()
    const call = (token: string) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.reconciliation', params: { workspace_id: workspaceId } }),
    }).then(response => response.json() as Promise<Envelope<{ result: { model_usage: { provider_cost_cny: string | null } } }>>)

    expect((await call('merchant-cost-token')).error?.code).toBe('FORBIDDEN')
    expect((await call('finance-cost-token')).data?.result.model_usage.provider_cost_cny).toBe('0.000000')
  })

  it('allows a platform operator to govern users without a tenant membership in the routing workspace', async () => {
    const routingWorkspace = `ws_platform_route_${Date.now()}`
    const targetWorkspace = `ws_platform_target_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'platform-only-token': { workspaces: [routingWorkspace], actor_id: 'platform-only-operator', roles: ['platform_ops'], workbenches: ['platform'] } }))
    await workspaceMembers.upsert({ workspaceId: targetWorkspace, externalSubject: 'target-only-user', displayName: '目标用户', role: 'operator', status: 'active', invitedBy: 'security-test' })
    const base = await start()
    const call = (method: string, params: Record<string, string>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-only-token', 'content-type': 'application/json', 'x-workspace-id': routingWorkspace },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: targetWorkspace, ...params } }),
    }).then(value => value.json() as Promise<Envelope<{ result: any }>>)
    const response = await call('ops.users.list', { query: 'target-only-user' })
    expect(response.error).toBeNull()
    expect(response.data?.result.items).toEqual([expect.objectContaining({ externalSubject: 'target-only-user', workspaceId: targetWorkspace })])
    const workspaces = await call('ops.workspaces.list', { workspace_id: routingWorkspace })
    expect(workspaces.error).toBeNull()
    expect(workspaces.data?.result).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId: targetWorkspace, memberCount: 1 })]))
    const workspacePage = await call('ops.workspaces.list', { workspace_id: routingWorkspace, offset: '0', limit: '1', query: targetWorkspace })
    expect(workspacePage.error).toBeNull()
    expect(workspacePage.data?.result).toMatchObject({ offset: 0, limit: 1, hasMore: false, items: [expect.objectContaining({ workspaceId: targetWorkspace })] })
    expect(workspacePage.data?.result.total).toBeGreaterThanOrEqual(1)
    const detail = await call('ops.user.detail', { external_subject: 'target-only-user' })
    expect(detail.error).toBeNull()
    expect(detail.data?.result.identity).toMatchObject({ externalSubject: 'target-only-user', membershipCount: 1 })
    expect((await call('ops.user.suspend', { external_subject: 'target-only-user', expected_revision: '1', reason: '跨租户停用验证' })).data?.result).toMatchObject({ workspaceId: targetWorkspace, status: 'suspended' })
  })

  it('restricts platform account administration and billing exports to their explicit workspace roles', async () => {
    const workspaceId = `ws_sensitive_ops_${Date.now()}`
    const otherWorkspaceId = `${workspaceId}_other`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([
      { token: 'sensitive-owner-token', workspaceId, actorId: 'sensitive-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: 'sensitive-admin-token', workspaceId, actorId: 'sensitive-admin', role: 'merchant_admin', gatewayRoles: ['merchant_admin'] },
      { token: 'sensitive-operator-token', workspaceId, actorId: 'sensitive-operator', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'sensitive-support-token', workspaceId, actorId: 'sensitive-support', role: 'support', gatewayRoles: ['support'] },
      { token: 'sensitive-finance-token', workspaceId, actorId: 'sensitive-finance', role: 'finance', gatewayRoles: ['finance'] },
      { token: 'sensitive-platform-token', workspaceId, actorId: 'sensitive-platform', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
      { token: 'other-owner-token', workspaceId: otherWorkspaceId, actorId: 'other-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
    ])
    const aliasAccount = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `alias-${Date.now()}`, credentialRef: 'vault://sensitive/alias' })
    const foreignAccount = service.registerPlatformAccount({ workspaceId: otherWorkspaceId, platform: 'taobao', remoteAccountId: `foreign-${Date.now()}`, credentialRef: 'vault://sensitive/foreign' })
    const revokeAccounts = new Map([
      ['sensitive-owner-token', service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `revoke-owner-${Date.now()}`, credentialRef: 'vault://sensitive/revoke-owner' })],
      ['sensitive-admin-token', service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `revoke-admin-${Date.now()}`, credentialRef: 'vault://sensitive/revoke-admin' })],
      ['sensitive-platform-token', service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `revoke-platform-${Date.now()}`, credentialRef: 'vault://sensitive/revoke-platform' })],
    ])
    const deniedRevokeAccount = service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `revoke-denied-${Date.now()}`, credentialRef: 'vault://sensitive/revoke-denied' })
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}, routedWorkspaceId = workspaceId, bodyWorkspaceId = routedWorkspaceId) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': routedWorkspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${token}`, method, params: { workspace_id: bodyWorkspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    for (const token of ['sensitive-operator-token', 'sensitive-support-token', 'sensitive-finance-token']) {
      expect((await call(token, 'platform.store.alias.set', { platform: 'taobao', account_id: aliasAccount.id, alias: '越权别名', expected_revision: String(aliasAccount.revision) })).error?.code).toBe('FORBIDDEN')
      expect((await call(token, 'platform.revoke', { platform: 'jd', account_id: deniedRevokeAccount.id })).error?.code).toBe('FORBIDDEN')
    }
    expect(service.getPlatformAccount(workspaceId, deniedRevokeAccount.id, 'jd').tokenState).toBe('connected')

    let expectedRevision = aliasAccount.revision
    for (const [token, alias] of [['sensitive-owner-token', '所有者店铺'], ['sensitive-admin-token', '管理员店铺']] as const) {
      const renamed = await call(token, 'platform.store.alias.set', { platform: 'taobao', account_id: aliasAccount.id, alias, expected_revision: String(expectedRevision) })
      expect(renamed.error).toBeNull()
      expect(renamed.data?.result.store).toMatchObject({ accountId: aliasAccount.id, alias })
      expectedRevision += 1
    }
    expect((await call('sensitive-platform-token', 'platform.store.alias.set', { platform: 'taobao', account_id: aliasAccount.id, alias: '平台运营店铺', expected_revision: String(expectedRevision) })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })

    for (const [token, account] of revokeAccounts) {
      const revoked = await call(token, 'platform.revoke', { platform: 'jd', account_id: account.id })
      if (token === 'sensitive-platform-token') {
        expect(revoked.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
        expect(service.getPlatformAccount(workspaceId, account.id, 'jd').tokenState).toBe('connected')
      } else {
        expect(revoked.error?.code).toBe('PLATFORM_REVOKE_REMOTE_FAILED')
        expect(service.getPlatformAccount(workspaceId, account.id, 'jd').tokenState).toBe('revoked')
      }
    }

    for (const token of ['sensitive-owner-token', 'sensitive-admin-token', 'sensitive-finance-token']) {
      const exported = await call(token, 'billing.export', { format: 'json', limit: '10', scope: 'workspace' })
      expect(exported.error).toBeNull()
      expect(exported.data?.result).toMatchObject({ filename: `billing-${workspaceId}.json`, contentType: 'application/json' })
    }
    expect((await call('sensitive-platform-token', 'billing.export', { format: 'json', limit: '10', scope: 'workspace' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH' } })
    for (const token of ['sensitive-operator-token', 'sensitive-support-token']) {
      expect((await call(token, 'billing.export', { format: 'json' })).data?.result).toMatchObject({ scope: 'mine', filename: 'my-billing.json' })
    }

    expect((await call('sensitive-owner-token', 'platform.store.alias.set', { platform: 'taobao', account_id: foreignAccount.id, alias: '跨租户修改', expected_revision: String(foreignAccount.revision) })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'account' } })
    expect((await call('sensitive-owner-token', 'brand-unit.create', { brand_id: 'sensitive_store_brand', name: '店铺范围品牌' })).error).toBeNull()
    expect((await call('sensitive-owner-token', 'brand-unit.bind-store', { brand_id: 'sensitive_store_brand', platform: 'taobao', account_id: aliasAccount.id })).error).toBeNull()
    expect((await call('sensitive-owner-token', 'brand-unit.bind-store', { brand_id: 'sensitive_store_brand', platform: 'taobao', account_id: foreignAccount.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'account' } })
    expect((await call('sensitive-owner-token', 'brand-unit.product.create', { brand_id: 'sensitive_store_brand', product_id: 'sensitive_canonical_product', title: '店铺范围商品' })).error).toBeNull()
    expect((await call('sensitive-owner-token', 'brand-unit.listing.create', { brand_id: 'sensitive_store_brand', canonical_product_id: 'sensitive_canonical_product', platform: 'taobao', account_id: aliasAccount.id })).error).toBeNull()
    expect((await call('sensitive-owner-token', 'brand-unit.listing.create', { brand_id: 'sensitive_store_brand', canonical_product_id: 'sensitive_canonical_product', platform: 'taobao', account_id: foreignAccount.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'account' } })
    expect((await call('sensitive-owner-token', 'platform.revoke', { platform: 'taobao', account_id: foreignAccount.id })).error?.code).toBe('PLATFORM_ACCOUNT_NOT_FOUND')
    const unchangedForeignAccount = service.getPlatformAccount(otherWorkspaceId, foreignAccount.id, 'taobao')
    expect(unchangedForeignAccount.tokenState).toBe('connected')
    expect(unchangedForeignAccount).not.toHaveProperty('storeAlias')
    expect((await call('sensitive-owner-token', 'billing.export', { format: 'json' }, workspaceId, otherWorkspaceId)).error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect((await call('sensitive-owner-token', 'billing.export', { format: 'json' }, otherWorkspaceId, otherWorkspaceId)).error?.code).toBe('FORBIDDEN')
  })

  it('prevents removing the last active workspace owner', async () => {
    const workspaceId = `ws_last_owner_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'owner-token', workspaceId, actorId: 'sole-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] }])
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.member.upsert', params: { workspace_id: workspaceId, external_subject: 'sole-owner', role: 'operator', reason: '错误降权尝试' } }),
    }).then(value => value.json() as Promise<Envelope>)
    expect(response.error?.code).toBe('LAST_WORKSPACE_OWNER_REQUIRED')
  })

  it('filters brands by grant and enforces minimum brand roles for writes in staging', async () => {
    const workspaceId = `ws_brand_access_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    await configureBearerMembers([
      { token: 'brand-owner-token', workspaceId, actorId: 'brand-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: 'brand-editor-token', workspaceId, actorId: 'brand-editor', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'brand-publisher-token', workspaceId, actorId: 'brand-publisher', role: 'operator', gatewayRoles: ['operator'] },
    ])
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-store-${workspaceId}`, credentialRef: 'vault://brand-access' })
    const source = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'brand-access-source', title: '品权限商品', stock: 3 })
    const hiddenSource = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'brand-hidden-source', title: '不可见商品', stock: 2 })
    const publishSource = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'brand-publish-source', title: '发布权限商品', stock: 4 })
    const legacyBrandOnlySource = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'legacy-brand-only-source', title: '仅旧字段商品', stock: 1 }) as typeof source & { brandId?: string }
    legacyBrandOnlySource.brandId = 'brand_access'
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer brand-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const editorHeaders = { authorization: 'Bearer brand-editor-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const publisherHeaders = { authorization: 'Bearer brand-publisher-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const mcp = (headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await mcp(ownerHeaders, 1, 'brand-unit.create', { brand_id: 'brand_access', name: '权限品' })).error).toBeNull()
    expect((await mcp(ownerHeaders, 1.1, 'brand-unit.create', { brand_id: 'brand_hidden', name: '不可见品' })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2, 'brand-unit.bind-store', { brand_id: 'brand_access', platform: 'taobao', account_id: account.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2.05, 'catalog.facts.confirm', { product_id: source.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2.06, 'catalog.facts.confirm', { product_id: hiddenSource.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2.07, 'catalog.facts.confirm', { product_id: publishSource.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2.1, 'brand-unit.product.create', { brand_id: 'brand_access', title: '初始品牌商品', source_product_id: source.id })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2.11, 'brand-unit.product.create', { brand_id: 'brand_hidden', title: '不可见商品', source_product_id: hiddenSource.id })).error).toBeNull()
    const publishCanonical = await mcp(ownerHeaders, 2.12, 'brand-unit.product.create', { brand_id: 'brand_access', title: '发布权限商品', source_product_id: publishSource.id })
    expect(publishCanonical.error).toBeNull()
    expect((await mcp(ownerHeaders, 2.13, 'brand-unit.listing.create', { brand_id: 'brand_access', canonical_product_id: publishCanonical.data?.result.id, platform: 'taobao', account_id: account.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 3, 'brand-unit.list', {})).data?.result).toMatchObject({ count: 0 })
    expect((await mcp(editorHeaders, 3.1, 'workspace.health', {})).data?.result.capabilityCards.brandNavigation).toMatchObject({ presentation: 'tree', hierarchy: ['brand', 'platform', 'store'], items: [] })
    expect((await mcp(editorHeaders, 4, 'brand-unit.list', { brand_id: 'brand_access' })).error?.code).toBe('BRAND_ACCESS_REQUIRED')

    const ownUpload = await mcp(editorHeaders, 4.1, 'asset.upload', { name: 'editor-own.txt', mime_type: 'text/plain', content_base64: Buffer.from(`restricted-upload-${workspaceId}`).toString('base64') })
    expect(ownUpload.error).toBeNull()
    const ownAssetId = ownUpload.data?.result.id as string
    expect((await mcp(editorHeaders, 4.2, 'asset.list', {})).data?.result.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: ownAssetId })]))
    expect((await mcp(editorHeaders, 4.3, 'asset.preference.update', { asset_id: ownAssetId, verdict: 'unrated' })).error).toBeNull()

    expect((await mcp(ownerHeaders, 5, 'brand-unit.access.grant', { brand_id: 'brand_access', external_subject: 'brand-editor', role: 'viewer' })).error).toBeNull()
    expect((await mcp(editorHeaders, 5.1, 'brand-unit.access.grant', { brand_id: 'brand_access', external_subject: 'brand-editor', role: 'admin' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6, 'brand-unit.list', {})).data?.result).toMatchObject({ count: 1 })
    expect((await mcp(editorHeaders, 6.1, 'workspace.health', {})).data?.result.capabilityCards.brandNavigation.items).toEqual([expect.objectContaining({ id: 'brand_access', title: '权限品', platforms: [expect.objectContaining({ platform: 'taobao', stores: [expect.objectContaining({ accountId: account.id })] })] })])
    expect((await mcp(editorHeaders, 6.2, 'creative.brief', { product_id: hiddenSource.id, asset_type: 'banner' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.3, 'creative.preview', { product_id: hiddenSource.id, asset_type: 'banner' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(ownerHeaders, 6.31, 'creative.brief', { product_id: legacyBrandOnlySource.id, asset_type: 'banner' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const imageJobsBeforeDeniedBrandCalls = service.imageGenerationJobs.size
    expect((await mcp(editorHeaders, 6.4, 'catalog.image.generate', { product_id: source.id, platform: 'taobao', direction: '保留商品本体并生成白底主图', mode: 'create', count: '1', idempotency_key: `viewer-image-${workspaceId}` })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.5, 'catalog.image.generate', { product_id: hiddenSource.id, platform: 'taobao', direction: '保留商品本体并生成白底主图', mode: 'create', count: '1', idempotency_key: `hidden-image-${workspaceId}` })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.imageGenerationJobs.size).toBe(imageJobsBeforeDeniedBrandCalls)
    const protectedProductBeforeDeniedUpdates = structuredClone(service.products.get(source.id))
    const hiddenProductBeforeDeniedUpdates = structuredClone(service.products.get(hiddenSource.id))
    expect((await mcp(editorHeaders, 6.51, 'catalog.product.update', { product_id: source.id, attributes_json: '{invalid-json' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.52, 'catalog.product.update', { product_id: hiddenSource.id, title: '不应写入的隐藏品牌标题' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const productStatusBeforeDeniedBrandCalls = structuredClone(service.products.get(hiddenSource.id))
    expect((await mcp(editorHeaders, 6.525, 'catalog.product.disable', { product_id: hiddenSource.id, reason: '不应停用隐藏品牌商品' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.526, 'catalog.product.enable', { product_id: hiddenSource.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.products.get(hiddenSource.id)).toEqual(productStatusBeforeDeniedBrandCalls)
    expect(service.products.get(source.id)).toEqual(protectedProductBeforeDeniedUpdates)
    expect(service.products.get(hiddenSource.id)).toEqual(hiddenProductBeforeDeniedUpdates)
    const imageJobsBeforeDeniedReviews = structuredClone([...service.imageGenerationJobs.entries()])
    expect((await mcp(editorHeaders, 6.53, 'catalog.image.review', { product_id: source.id, visual_refs_json: '{invalid-json' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.54, 'catalog.image.review', { product_id: hiddenSource.id, images: 'https://assets.example/hidden-review.jpg' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect([...service.imageGenerationJobs.entries()]).toEqual(imageJobsBeforeDeniedReviews)
    const generatedJob = service.enqueueImageGeneration({ workspaceId, productId: source.id, idempotencyKey: `brand-image-${workspaceId}`, count: 1 })
    const generatedJobBeforeDeniedSelection = structuredClone(generatedJob)
    const generatedVisualRef = `dvis_${'B'.repeat(24)}`
    const selectionIntentHash = createHash('sha256').update(JSON.stringify({ method: 'catalog.image.select', jobId: generatedJob.id, visualRef: generatedVisualRef, expectedRevision: generatedJob.revision })).digest('hex')
    const viewerSelection = await mcp(editorHeaders, 6.6, 'catalog.image.select', { job_id: generatedJob.id, visual_ref: generatedVisualRef, expected_revision: String(generatedJob.revision), idempotency_key: `brand-select-${workspaceId}`, reason: '品牌候选图选择', confirmation_ticket_nonce_hash: 'a'.repeat(64), confirmation_ticket_intent_hash: selectionIntentHash })
    expect(viewerSelection.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.imageGenerationJobs.get(generatedJob.id)).toEqual(generatedJobBeforeDeniedSelection)
    const hiddenGeneratedJob = service.enqueueImageGeneration({ workspaceId, productId: hiddenSource.id, idempotencyKey: `hidden-brand-image-${workspaceId}`, count: 1 })
    const hiddenGeneratedJobBeforeDeniedSelection = structuredClone(hiddenGeneratedJob)
    expect((await mcp(editorHeaders, 6.605, 'catalog.image.get', { job_id: generatedJob.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 6.606, 'catalog.image.get', { job_id: hiddenGeneratedJob.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.61, 'catalog.image.select', { job_id: hiddenGeneratedJob.id, visual_ref: `dvis_${'C'.repeat(24)}`, expected_revision: String(hiddenGeneratedJob.revision), idempotency_key: `hidden-brand-select-${workspaceId}`, reason: '不应选择隐藏品牌候选图', confirmation_ticket_nonce_hash: 'b'.repeat(64), confirmation_ticket_intent_hash: 'c'.repeat(64) })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.imageGenerationJobs.get(hiddenGeneratedJob.id)).toEqual(hiddenGeneratedJobBeforeDeniedSelection)
    const imageJobsBeforeDeniedRetries = structuredClone([...service.imageGenerationJobs.entries()])
    expect((await mcp(editorHeaders, 6.62, 'catalog.image.retry', { job_id: generatedJob.id, idempotency_key: `viewer-retry-${workspaceId}`, expected_revision: String(generatedJob.revision) })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 6.63, 'catalog.image.retry', { job_id: hiddenGeneratedJob.id, idempotency_key: `hidden-retry-${workspaceId}` })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect([...service.imageGenerationJobs.entries()]).toEqual(imageJobsBeforeDeniedRetries)
    expect((await mcp(editorHeaders, 7, 'brand-unit.product.create', { brand_id: 'brand_access', title: '无编辑权限', source_product_id: source.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const protectedTask = service.createTask({ workspaceId, productId: source.id, platform: 'taobao', accountId: account.id, brandId: 'brand_access' })
    const hiddenTask = service.createTask({ workspaceId, productId: hiddenSource.id, platform: 'taobao', accountId: account.id, brandId: 'brand_hidden' })
    protectedTask.state = 'plan_confirmed'
    hiddenTask.state = 'plan_confirmed'
    const protectedGenerationJob = service.enqueueGeneration({ workspaceId, taskId: protectedTask.id, idempotencyKey: `protected-generation-${workspaceId}` })
    const hiddenGenerationJob = service.enqueueGeneration({ workspaceId, taskId: hiddenTask.id, idempotencyKey: `hidden-generation-${workspaceId}` })
    protectedTask.state = 'ready_for_direction'
    hiddenTask.state = 'ready_for_direction'
    expect((await mcp(editorHeaders, 7.001, 'generation.get', { job_id: protectedGenerationJob.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 7.002, 'generation.get', { job_id: hiddenGenerationJob.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    protectedGenerationJob.state = 'failed'
    hiddenGenerationJob.state = 'failed'
    service.contentVersions.set('content_protected_brand', { id: 'content_protected_brand', taskId: protectedTask.id, version: 1, body: { title: '授权品牌内容', detail: '授权品牌详情', sellingPoints: [] }, factVersionIds: [], ruleVersionIds: [], state: 'draft', revision: 1 })
    service.contentVersions.set('content_hidden_brand', { id: 'content_hidden_brand', taskId: hiddenTask.id, version: 1, body: { title: '隐藏品牌内容', detail: '隐藏品牌详情', sellingPoints: [] }, factVersionIds: [], ruleVersionIds: [], state: 'draft', revision: 1 })
    const imageJobsBeforeMismatchedResources = structuredClone([...service.imageGenerationJobs.entries()])
    expect((await mcp(ownerHeaders, 7.005, 'catalog.image.generate', { product_id: source.id, task_id: protectedTask.id, content_version_id: 'content_hidden_brand', direction: '不得跨任务生成', mode: 'create', count: '1', idempotency_key: `mismatched-resource-image-${workspaceId}` })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(ownerHeaders, 7.006, 'catalog.image.generate', { product_id: hiddenSource.id, task_id: protectedTask.id, direction: '不得跨商品生成', mode: 'create', count: '1', idempotency_key: `mismatched-task-product-${workspaceId}` })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect([...service.imageGenerationJobs.entries()]).toEqual(imageJobsBeforeMismatchedResources)
    expect((await mcp(editorHeaders, 7.01, 'task.timeline', { task_id: protectedTask.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 7.02, 'task.timeline', { task_id: hiddenTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.021, 'content.versions', { task_id: protectedTask.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 7.022, 'content.versions', { task_id: hiddenTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.023, 'content.diff', { content_version_id: 'content_protected_brand' })).error).toBeNull()
    expect((await mcp(editorHeaders, 7.024, 'content.diff', { content_version_id: 'content_hidden_brand' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.025, 'content.review', { content_version_id: 'content_protected_brand' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.026, 'content.review', { content_version_id: 'content_hidden_brand' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.027, 'content.review.decide', { content_version_id: 'content_protected_brand', code: 'TEST', field: 'title', status: 'acknowledged', reason: '无编辑权限', expected_revision: '1' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.028, 'content.review.decide', { content_version_id: 'content_hidden_brand', code: 'TEST', field: 'title', status: 'acknowledged', reason: '无品牌权限', expected_revision: '1' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const contentVersionsBeforeDeniedBrandModify = service.contentVersions.size
    expect((await mcp(editorHeaders, 7.029, 'content.modify', { content_version_id: 'content_protected_brand', changes_json: '{invalid', reason: '无编辑权限' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.03, 'content.modify', { content_version_id: 'content_hidden_brand', changes_json: '{invalid', reason: '无品牌权限' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.contentVersions.size).toBe(contentVersionsBeforeDeniedBrandModify)
    const contentVersionsBeforeDeniedBrandRestore = service.contentVersions.size
    expect((await mcp(editorHeaders, 7.031, 'content.restore', { content_version_id: 'content_protected_brand', expected_version: '999' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.032, 'content.restore', { content_version_id: 'content_hidden_brand', expected_version: '999' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.contentVersions.size).toBe(contentVersionsBeforeDeniedBrandRestore)
    const contentVersionsBeforeDeniedVisualSelection = service.contentVersions.size
    expect((await mcp(editorHeaders, 7.033, 'content.visual.select', { content_version_id: 'content_protected_brand', visual_refs_json: '[]', expected_revision: '999', reason: '无编辑权限' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.034, 'content.visual.select', { content_version_id: 'content_hidden_brand', visual_refs_json: '[]', expected_revision: '999', reason: '无品牌权限' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.contentVersions.size).toBe(contentVersionsBeforeDeniedVisualSelection)
    expect((await mcp(editorHeaders, 7.03, 'task.answer', { task_id: protectedTask.id, answers_json: '{}' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.04, 'task.answer', { task_id: hiddenTask.id, answers_json: '{}' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(ownerHeaders, 7.05, 'task.answer', { task_id: hiddenTask.id, answers_json: '{}' })).error).toBeNull()
    expect((await mcp(editorHeaders, 7.06, 'task.select_direction', { task_id: protectedTask.id, direction_id: 'A' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.07, 'task.select_direction', { task_id: hiddenTask.id, direction_id: 'A' })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(ownerHeaders, 7.08, 'task.select_direction', { task_id: hiddenTask.id, direction_id: 'A' })).error).toBeNull()
    expect((await mcp(editorHeaders, 7.09, 'task.plan.confirm', { task_id: protectedTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.1, 'task.plan.confirm', { task_id: hiddenTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const generationJobsBeforeDeniedBrandCalls = service.generationJobs.size
    expect((await mcp(editorHeaders, 7.101, 'content.generate', { task_id: protectedTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.102, 'content.generate', { task_id: hiddenTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.generationJobs.size).toBe(generationJobsBeforeDeniedBrandCalls)
    const publishJobsBeforeDeniedConfirm = structuredClone([...service.publishJobs.entries()])
    const mcpPublishDenied = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...editorHeaders, 'idempotency-key': 'brand-editor-mcp-publish-denied' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7.103, method: 'publish.confirm', params: { workspace_id: workspaceId, task_id: protectedTask.id, content_version_id: 'cv-not-reached', confirmation_hash: 'hash-not-reached', remote_snapshot_hash: 'snapshot-not-reached' } }),
    }).then(response => response.json() as Promise<Envelope>)
    expect(mcpPublishDenied.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const restPublishDenied = await fetch(`${base}/v1/publish-jobs`, {
      method: 'POST',
      headers: { ...editorHeaders, 'idempotency-key': 'brand-editor-publish-denied' },
      body: JSON.stringify({ workspace_id: workspaceId, task_id: protectedTask.id, content_version_id: 'cv-not-reached', confirmation_hash: 'hash-not-reached', remote_snapshot_hash: 'snapshot-not-reached' }),
    }).then(response => response.json() as Promise<Envelope>)
    expect(restPublishDenied.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect([...service.publishJobs.entries()]).toEqual(publishJobsBeforeDeniedConfirm)
    expect(service.listPublishJobs(workspaceId)).toHaveLength(0)
    expect((await mcp(editorHeaders, 7.1, 'task.history', {})).data?.result.items).toEqual([expect.objectContaining({ id: protectedTask.id })])
    expect((await mcp(editorHeaders, 7.11, 'task.resume', { task_id: hiddenTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect((await mcp(editorHeaders, 7.2, 'task.resume', { task_id: protectedTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })

    expect((await mcp(ownerHeaders, 8, 'brand-unit.access.grant', { brand_id: 'brand_access', external_subject: 'brand-editor', role: 'editor' })).error).toBeNull()
    const publisherProbeTask = service.createTask({ workspaceId, productId: source.id, platform: 'taobao', accountId: account.id, brandId: 'brand_access' })
    service.selectDirection(publisherProbeTask.id, 'A')
    const publisherProbeDraft = service.createDraft(publisherProbeTask.id)
    const publisherProbeDraftBeforeDeniedApproval = structuredClone(publisherProbeDraft)
    expect((await mcp(editorHeaders, 8.01, 'content.approve', { task_id: publisherProbeTask.id, content_version_id: publisherProbeDraft.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.contentVersions.get(publisherProbeDraft.id)).toEqual(publisherProbeDraftBeforeDeniedApproval)
    const publisherProbeTaskBeforeDeniedPrepare = structuredClone(publisherProbeTask)
    const publishJobsBeforeDeniedPrepare = structuredClone([...service.publishJobs.entries()])
    expect((await mcp(editorHeaders, 8.02, 'publish.prepare', { task_id: publisherProbeTask.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.tasks.get(publisherProbeTask.id)).toEqual(publisherProbeTaskBeforeDeniedPrepare)
    const deniedHttpPrepare = await fetch(`${base}/v1/tasks/${publisherProbeTask.id}/publish-preview`, { method: 'POST', headers: editorHeaders, body: '{}' }).then(response => response.json() as Promise<Envelope>)
    expect(deniedHttpPrepare.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    expect(service.tasks.get(publisherProbeTask.id)).toEqual(publisherProbeTaskBeforeDeniedPrepare)
    expect([...service.publishJobs.entries()]).toEqual(publishJobsBeforeDeniedPrepare)
    expect((await mcp(editorHeaders, 8.1, 'catalog.image.select', { job_id: generatedJob.id, visual_ref: generatedVisualRef, expected_revision: String(generatedJob.revision), idempotency_key: `brand-select-${workspaceId}`, reason: '品牌候选图选择', confirmation_ticket_nonce_hash: 'a'.repeat(64), confirmation_ticket_intent_hash: selectionIntentHash })).error?.code).toBe('INTERACTIVE_CONFIRMATION_TICKET_INVALID')
    expect((await mcp(editorHeaders, 9, 'brand-unit.product.create', { brand_id: 'brand_access', title: '可编辑商品', source_product_id: source.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 9.1, 'task.resume', { task_id: protectedTask.id })).error).toBeNull()

    service.confirmProductFacts(workspaceId, source.id)
    expect((await mcp(ownerHeaders, 9.11, 'brand-unit.access.grant', { brand_id: 'brand_access', external_subject: 'brand-publisher', role: 'publisher' })).error).toBeNull()
    const publisherMcpTask = service.createTask({ workspaceId, productId: publishSource.id, platform: 'taobao', accountId: account.id, brandId: 'brand_access' })
    service.selectDirection(publisherMcpTask.id, 'A')
    const publisherMcpDraft = service.createDraft(publisherMcpTask.id)
    service.approveContent(publisherMcpTask.id, publisherMcpDraft.id)
    expect((await mcp(publisherHeaders, 9.12, 'publish.prepare', { task_id: publisherMcpTask.id })).error).toBeNull()
    expect(service.tasks.get(publisherMcpTask.id)?.state).toBe('publish_prepared')
    const publisherHttpTask = service.createTask({ workspaceId, productId: publishSource.id, platform: 'taobao', accountId: account.id, brandId: 'brand_access' })
    service.selectDirection(publisherHttpTask.id, 'A')
    const publisherHttpDraft = service.createDraft(publisherHttpTask.id)
    service.approveContent(publisherHttpTask.id, publisherHttpDraft.id)
    const publisherHttpPrepare = await fetch(`${base}/v1/tasks/${publisherHttpTask.id}/publish-preview`, { method: 'POST', headers: publisherHeaders, body: '{}' }).then(response => response.json() as Promise<Envelope<{ task: { state: string } }>>)
    expect(publisherHttpPrepare.error).toBeNull()
    expect(publisherHttpPrepare.data?.task.state).toBe('publish_prepared')
    const protectedPublishTask = service.createTask({ workspaceId, productId: source.id, platform: 'taobao', accountId: account.id, brandId: 'brand_access' })
    const hiddenPublishTask = service.createTask({ workspaceId, productId: source.id, platform: 'taobao', accountId: account.id, brandId: 'brand_hidden' })
    for (const task of [protectedPublishTask, hiddenPublishTask]) {
      service.selectDirection(task.id, 'A')
      const draft = service.createDraft(task.id)
      service.approveContent(task.id, draft.id)
    }
    const protectedPreview = service.preparePublish(protectedPublishTask.id)
    const protectedJob = service.confirmPublish({ workspaceId, taskId: protectedPublishTask.id, contentVersionId: protectedPreview.version.id, confirmationHash: protectedPreview.confirmationHash, remoteSnapshotHash: protectedPreview.remoteSnapshotHash, idempotencyKey: `brand-access-protected-${Date.now()}` })
    const hiddenPreview = service.preparePublish(hiddenPublishTask.id)
    const hiddenJob = service.confirmPublish({ workspaceId, taskId: hiddenPublishTask.id, contentVersionId: hiddenPreview.version.id, confirmationHash: hiddenPreview.confirmationHash, remoteSnapshotHash: hiddenPreview.remoteSnapshotHash, idempotencyKey: `brand-access-hidden-${Date.now()}` })
    expect((await mcp(editorHeaders, 9.2, 'publish.get', { publish_job_id: protectedJob.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 9.3, 'publish.get', { publish_job_id: hiddenJob.id })).error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const restHidden = await fetch(`${base}/v1/publish-jobs/${hiddenJob.id}`, { headers: editorHeaders }).then(response => response.json() as Promise<Envelope>)
    expect(restHidden.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH', required_scope: 'brand' } })
    const restList = await fetch(`${base}/v1/publish-jobs?limit=1&offset=0`, { headers: editorHeaders }).then(response => response.json() as Promise<Envelope<{ items: Array<{ id: string }>; total: number }>>)
    expect(restList.error).toBeNull()
    expect(restList.data).toMatchObject({ total: 1, items: [{ id: protectedJob.id }], limit: 1, offset: 0 })
    const restHiddenPage = await fetch(`${base}/v1/publish-jobs?limit=1&offset=1`, { headers: editorHeaders }).then(response => response.json() as Promise<Envelope<{ items: Array<{ id: string }>; total: number }>>)
    expect(restHiddenPage.error).toBeNull()
    expect(restHiddenPage.data).toMatchObject({ total: 1, items: [], limit: 1, offset: 1 })
  })

  it('resolves an independent OAuth callback for every platform', () => {
    const template = { PUBLIC_OAUTH_REDIRECT_URI: 'https://merchant.test/v1/oauth/callback/{platform}' }
    expect(configuredOAuthRedirectUri('jd', template)).toBe('https://merchant.test/v1/oauth/callback/jd')
    expect(configuredOAuthRedirectUri('taobao', template)).toBe('https://merchant.test/v1/oauth/callback/taobao')
    expect(configuredOAuthRedirectUri('tmall', { ...template, TMALL_OAUTH_REDIRECT_URI: 'https://tmall.test/v1/oauth/callback/tmall' })).toBe('https://tmall.test/v1/oauth/callback/tmall')
    expect(configuredOAuthRedirectUri('pinduoduo', { PUBLIC_OAUTH_REDIRECT_URI: 'https://merchant.test/v1/oauth/callback' })).toBe('https://merchant.test/v1/oauth/callback/pinduoduo')
  })

  it('binds OAuth state to scope, consumes once, expires, and verifies PKCE hash format', () => {
    let now = 100
    const store = new OAuthStateStore(50, () => now)
    const state = store.issue({ workspaceId: 'ws_secure', actorId: 'actor', platform: 'jd', codeChallenge: hashPkceVerifier('verifier') })
    expect(() => store.consume(state, { workspaceId: 'ws_other', platform: 'jd' })).toThrow(/scope/i)
    expect(store.consume(state, { workspaceId: 'ws_secure', platform: 'jd' }).codeChallenge).toBe(hashPkceVerifier('verifier'))
    expect(() => store.consume(state, { workspaceId: 'ws_secure', platform: 'jd' })).toThrow(/consumed/i)
    const expired = store.issue({ workspaceId: 'ws_secure', actorId: 'actor', platform: 'jd' })
    now = 200
    expect(() => store.consume(expired, { workspaceId: 'ws_secure', platform: 'jd' })).toThrow(/expired/i)
    expect(hashPkceVerifier('verifier')).toBe(hashPkceVerifier('verifier'))
  })

  it('does not expose credential-shaped values through the redaction helper', () => {
    const safe = redactSecrets({ access_token: 'token', refresh_token: 'refresh', nested: { authorization_code: 'code' }, title: 'visible' })
    expect(safe).toEqual({ access_token: '[REDACTED]', refresh_token: '[REDACTED]', nested: { authorization_code: '[REDACTED]' }, title: 'visible' })
    const encoded = JSON.stringify(safe)
    expect(encoded).not.toContain('"access_token":"token"')
    expect(encoded).not.toContain('"refresh_token":"refresh"')
    expect(encoded).not.toContain('"authorization_code":"code"')
  })

  it('rejects oversized JSON bodies before application processing', async () => {
    vi.stubEnv('REQUEST_BODY_LIMIT_BYTES', '32')
    const base = await start()
    const { response, body } = await json(await fetch(`${base}/v1/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_body_limit' },
      body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao', padding: '012345678901234567890123456789' }),
    }))
    expect(response.status).toBe(413)
    expect(body.error?.code).toBe('REQUEST_BODY_TOO_LARGE')
  })

  it('fails closed for production CORS and accepts only the configured origin', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ALLOWED_ORIGINS', 'https://merchant.example')
    const base = await start()
    const denied = await fetch(`${base}/v1/products`, { headers: { origin: 'https://evil.example', 'x-workspace-id': 'ws_cors' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(denied.headers.get('access-control-allow-credentials')).toBeNull()
    const allowed = await fetch(`${base}/v1/products`, { headers: { origin: 'https://merchant.example', 'x-workspace-id': 'ws_cors' } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://merchant.example')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    const preflight = await fetch(`${base}/v1/tasks`, { method: 'OPTIONS', headers: { origin: 'https://merchant.example', 'access-control-request-method': 'POST' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')
  })

  it('binds bearer tokens to an allowlisted workspace in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_bearer_auth' }])
    service.registerPlatformAccount({ workspaceId: 'ws_bearer_auth', platform: 'taobao', remoteAccountId: 'auth-store', credentialRef: 'vault://auth-store' })
    const base = await start()
    const missing = await fetch(`${base}/v1/products`, { headers: { 'x-workspace-id': 'ws_bearer_auth' } })
    expect(missing.status).toBe(401)
    expect((await missing.json() as Envelope).error?.code).toBe('UNAUTHENTICATED')
    const denied = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_other' } })
    expect(denied.status).toBe(403)
    const allowed = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_bearer_auth' } })
    expect(allowed.status).toBe(200)
  })

  it('accepts only a short-lived signed OIDC gateway identity in managed ops mode', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    await workspaceMembers.upsert({ workspaceId: 'ws_oidc', externalSubject: 'oidc-user', displayName: 'oidc-user', role: 'merchant_admin', status: 'active', invitedBy: 'security-test' })
    service.registerPlatformAccount({ workspaceId: 'ws_oidc', platform: 'taobao', remoteAccountId: 'oidc-store', credentialRef: 'vault://oidc-store' })
    const base = await start()
    const path = '/v1/products'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const bodyDigest = createHash('sha256').update('').digest('hex')
    const nonce = `oidc-get-${Date.now()}-nonce`
    const canonical = ['GET', path, 'ws_oidc', 'workspace', 'https://issuer.example.com', 'oidc-user', 'oidc-session-1', 'merchant_admin,operator', 'mfa', authTime, sessionExpiresAt, timestamp, bodyDigest, nonce].join('\n')
    const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
    const headers = { 'x-workspace-id': 'ws_oidc', 'x-oidc-workbench': 'workspace', 'x-oidc-issuer': 'https://issuer.example.com', 'x-oidc-sub': 'oidc-user', 'x-oidc-sid': 'oidc-session-1', 'x-oidc-workspace': 'ws_oidc', 'x-oidc-roles': 'operator,merchant_admin', 'x-oidc-amr': 'mfa', 'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': sessionExpiresAt, 'x-oidc-timestamp': timestamp, 'x-oidc-body-sha256': bodyDigest, 'x-oidc-nonce': nonce, 'x-oidc-signature': signature }
    const missing = await fetch(`${base}${path}`, { headers: { 'x-workspace-id': 'ws_oidc' } })
    expect(missing.status).toBe(401)
    const queryTampered = await fetch(`${base}${path}?limit=1`, { headers })
    expect(queryTampered.status).toBe(401)
    const workbenchTampered = await fetch(`${base}${path}`, { headers: { ...headers, 'x-oidc-workbench': 'platform' } })
    expect(workbenchTampered.status).toBe(401)
    const workbenchMissing = await fetch(`${base}${path}`, { headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'x-oidc-workbench')) })
    expect(workbenchMissing.status).toBe(401)
    expect((await workbenchMissing.json() as Envelope).error?.code).toBe('AUTHZ_WORKBENCH_ASSERTION_INVALID')
    const allowed = await fetch(`${base}${path}`, { headers })
    expect(allowed.status).toBe(200)
    const conflicting = await fetch(`${base}${path}`, { headers: { ...headers, 'x-workspace-id': 'ws_other' } })
    expect(conflicting.status).toBe(403)
    const bearer = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer ignored', 'x-workspace-id': 'ws_oidc' } })
    expect(bearer.status).toBe(401)
  })

  it('keeps the merchant host bearer boundary separate from the OIDC ops host', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    // The ephemeral test server is addressed through 127.0.0.1; production
    // sets this to merchant.example.com in the Kubernetes ConfigMap.
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', '127.0.0.1')
    await configureBearerMembers([{ token: 'merchant-ui-token', workspaceId: 'ws_merchant_host' }])
    service.registerPlatformAccount({ workspaceId: 'ws_merchant_host', platform: 'taobao', remoteAccountId: 'merchant-host-store', credentialRef: 'vault://merchant-host-store' })
    const base = await start()
    const path = '/v1/products'
    const merchant = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer merchant-ui-token', 'x-workspace-id': 'ws_merchant_host' } })
    expect(merchant.status).toBe(200)
    const merchantEscalation = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer merchant-ui-token', 'x-workspace-id': 'ws_merchant_host', 'x-ops-workbench': 'platform' } })
    expect(merchantEscalation.status).toBe(403)
    expect((await merchantEscalation.json() as Envelope).error?.code).toBe('AUTHZ_WORKBENCH_FORBIDDEN')
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', 'ops.merchant.example.com')
    const opsBearer = await fetch(`${base}${path}`, { headers: { host: 'ops.merchant.example.com', authorization: 'Bearer merchant-ui-token', 'x-workspace-id': 'ws_merchant_host' } })
    expect(opsBearer.status).toBe(401)
  })

  it('allows a signed OIDC identity to bootstrap once before a workspace is assigned', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    const base = await start()
    const path = '/mcp'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.bootstrap', params: { display_name: 'OIDC 首次工作区' } })
    const bodyDigest = createHash('sha256').update(requestBody).digest('hex')
    const nonce = `oidc-bootstrap-${Date.now()}-1`
    const canonical = ['POST', path, '', 'workspace', 'https://issuer.example.com', 'new-oidc-user', 'bootstrap-session-1', '', '', authTime, sessionExpiresAt, timestamp, bodyDigest, nonce].join('\n')
    const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
    const headers = {
      'content-type': 'application/json',
      'x-workspace-bootstrap': 'true',
      'x-oidc-workbench': 'workspace',
      'x-oidc-issuer': 'https://issuer.example.com',
      'x-oidc-sub': 'new-oidc-user',
      'x-oidc-sid': 'bootstrap-session-1',
      'x-oidc-auth-time': authTime,
      'x-oidc-session-expires-at': sessionExpiresAt,
      'x-oidc-timestamp': timestamp,
      'x-oidc-body-sha256': bodyDigest,
      'x-oidc-nonce': nonce,
      'x-oidc-signature': signature,
    }
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: requestBody }).then(json)
    expect(response.body.error).toBeNull()
    expect((response.body.data as { result: { workspaceId: string; owner: { actorId: string } } }).result).toMatchObject({ workspaceId: expect.stringMatching(/^ws_[a-f0-9]{24}$/), owner: { actorId: 'new-oidc-user' } })
    const replay = await fetch(`${base}${path}`, { method: 'POST', headers, body: requestBody })
    expect(replay.status).toBe(401)
    expect((await replay.json() as Envelope).error?.code).toBe('UNAUTHENTICATED')
    const substituted = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'workspace.bootstrap', params: { display_name: '被替换的请求体' } }) })
    expect(substituted.status).toBe(401)
    expect((await substituted.json() as Envelope).error?.code).toBe('UNAUTHENTICATED')
  })

  it('reuses bootstrap by signed issuer and subject while isolating another issuer', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    const base = await start()
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const subject = `bootstrap-idempotent-${suffix}`
    const firstRequest = signedOidcBootstrap({ issuer: 'https://issuer-a.example.com', subject, nonce: `bootstrap-a1-${suffix}`, displayName: '首次可信工作区' })
    const secondRequest = signedOidcBootstrap({ issuer: 'https://issuer-a.example.com', subject, nonce: `bootstrap-a2-${suffix}`, displayName: '不得覆盖名称' })
    const isolatedRequest = signedOidcBootstrap({ issuer: 'https://issuer-b.example.com', subject, nonce: `bootstrap-b1-${suffix}`, displayName: '另一发行方工作区' })

    const first = await fetch(`${base}/mcp`, { method: 'POST', ...firstRequest }).then(json)
    const second = await fetch(`${base}/mcp`, { method: 'POST', ...secondRequest }).then(json)
    const isolated = await fetch(`${base}/mcp`, { method: 'POST', ...isolatedRequest }).then(json)
    const firstResult = (first.body.data as { result: { workspaceId: string; displayName: string; reused: boolean; owner: { issuer: string; externalSubject: string } } }).result
    const secondResult = (second.body.data as { result: typeof firstResult }).result
    const isolatedResult = (isolated.body.data as { result: typeof firstResult }).result

    expect(firstResult).toMatchObject({ reused: false, displayName: '首次可信工作区', owner: { issuer: 'https://issuer-a.example.com', externalSubject: subject } })
    expect(secondResult).toMatchObject({ workspaceId: firstResult.workspaceId, reused: true, displayName: '首次可信工作区' })
    expect(isolatedResult).toMatchObject({ reused: false, owner: { issuer: 'https://issuer-b.example.com', externalSubject: subject } })
    expect(isolatedResult.workspaceId).not.toBe(firstResult.workspaceId)
  })

  it('does not allow bootstrap to assign ownership to a different external subject', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    const base = await start()
    const path = '/mcp'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.bootstrap', params: { display_name: '错误 owner 工作区', external_subject: 'different-user' } })
    const bodyDigest = createHash('sha256').update(requestBody).digest('hex')
    const nonce = `oidc-bootstrap-${Date.now()}-2`
    const canonical = ['POST', path, '', 'workspace', 'https://issuer.example.com', 'authenticated-user', 'bootstrap-session-2', '', '', authTime, sessionExpiresAt, timestamp, bodyDigest, nonce].join('\n')
    const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-bootstrap': 'true', 'x-oidc-workbench': 'workspace', 'x-oidc-issuer': 'https://issuer.example.com', 'x-oidc-sub': 'authenticated-user', 'x-oidc-sid': 'bootstrap-session-2', 'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': sessionExpiresAt, 'x-oidc-timestamp': timestamp, 'x-oidc-body-sha256': bodyDigest, 'x-oidc-nonce': nonce, 'x-oidc-signature': signature }, body: requestBody })
    expect(response.status).toBe(403)
    expect((await response.json() as Envelope).error?.code).toBe('FORBIDDEN')
  })

  it('rejects wildcard workspace grants in production even if the local deployment flags are enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'pilot-token', workspaceId: 'ws_any', grantWorkspaces: ['*'] }])
    vi.stubEnv('ALLOW_WILDCARD_WORKSPACE_GRANT', 'false')
    service.registerPlatformAccount({ workspaceId: 'ws_any', platform: 'taobao', remoteAccountId: 'wildcard-store', credentialRef: 'vault://wildcard-store' })
    const base = await start()
    const denied = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer pilot-token', 'x-workspace-id': 'ws_any' } })
    expect(denied.status).toBe(403)
    vi.stubEnv('ALLOW_WILDCARD_WORKSPACE_GRANT', 'true')
    const allowed = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer pilot-token', 'x-workspace-id': 'ws_any' } })
    expect(allowed.status).toBe(403)
  })

  it('requires an HTTPS OAuth callback in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_oauth' }])
    const base = await start()
    const response = await fetch(`${base}/v1/platform-accounts/jd/authorize`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_oauth', 'content-type': 'application/json' },
      body: JSON.stringify({ actor_id: 'actor' }),
    })
    expect(response.status).toBe(503)
    expect((await response.json() as Envelope).error?.code).toBe('OAUTH_REDIRECT_URI_REQUIRED')
  })

  it('accepts six platform-specific HTTPS callback routes before enforcing connector readiness', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_oauth_callbacks' }])
    vi.stubEnv('JD_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/jd')
    vi.stubEnv('TAOBAO_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/taobao')
    vi.stubEnv('TMALL_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/tmall')
    vi.stubEnv('PDD_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/pinduoduo')
    vi.stubEnv('XHS_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/xiaohongshu')
    vi.stubEnv('DOUYIN_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/douyin')
    const base = await start()
    for (const platform of ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']) {
      const response = await fetch(`${base}/v1/platform-accounts/${platform}/authorize`, {
        method: 'POST',
        headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_oauth_callbacks', 'content-type': 'application/json' },
        body: JSON.stringify({ actor_id: 'actor' }),
      })
      expect(response.status).toBe(503)
      expect((await response.json() as Envelope).error?.code).toBe('NOT_CONFIGURED')
    }
  })

  it('allows a browser OAuth callback without the merchant Bearer token', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    // The callback boundary is the one-time state/PKCE record, not an API token.
    const callbackState = oauthStates.issue({ workspaceId: 'ws_callback', actorId: 'actor', platform: 'jd', codeVerifier: 'verifier' })
    const base = await start()
    const response = await fetch(`${base}/v1/oauth/callback/jd?state=${encodeURIComponent(callbackState)}&code=fixture`)
    expect(response.status).not.toBe(401)
    expect((await response.json() as Envelope).error?.code).toBe('OAUTH_STATE_STORE_UNAVAILABLE')
  })

  it('requires a registered platform account for production task binding', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_auth' }])
    const base = await start()
    service.registerPlatformAccount({ workspaceId: 'ws_auth', platform: 'taobao', remoteAccountId: 'remote-acct-1', credentialRef: 'vault://opaque' })
    service.products.set('prod_auth_1', { ...service.products.get('prod_fixture_1')!, id: 'prod_auth_1', workspaceId: 'ws_auth' })
    const headers = { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_auth', 'content-type': 'application/json' }
    const accepted = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_auth_1', platform: 'taobao', account_id: 'remote-acct-1' }) })
    expect(accepted.status).toBe(201)
    const accounts = await fetch(`${base}/v1/platform-accounts`, { headers }).then(response => response.json() as Promise<Envelope<{ items: Array<{ platform: string; accountId?: string }> }>>)
    expect(accounts.data?.items.find(item => item.platform === 'taobao')?.accountId).toBe('remote-acct-1')
    const accountStatus = accounts.data?.items.find(item => item.platform === 'taobao') as { readEnabled?: boolean; writeEnabled?: boolean } | undefined
    expect(accountStatus?.readEnabled).toBe(false)
    expect(accountStatus?.writeEnabled).toBe(false)
    const denied = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_auth_1', platform: 'taobao', account_id: 'not-authorized' }) })
    expect(denied.status).toBe(404)
    expect((await denied.json() as Envelope).error?.code).toBe('PLATFORM_ACCOUNT_NOT_FOUND')
  })

  it('rejects production publish before queueing when platform write readiness is incomplete', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-publish', workspaceId: 'ws_publish_gate' }])
    const productId = `prod_publish_gate_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_publish_gate' })
    service.registerPlatformAccount({ workspaceId: 'ws_publish_gate', platform: 'taobao', remoteAccountId: 'remote-publish-gate', credentialRef: 'vault://opaque' })
    const base = await start()
    const headers = { authorization: 'Bearer token-publish', 'x-workspace-id': 'ws_publish_gate', 'content-type': 'application/json' }
    const created = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao', account_id: 'remote-publish-gate' }) }).then(response => response.json() as Promise<Envelope<{ id: string }>>)
    const taskId = created.data!.id
    const generationBeforeRecharge = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'content.generate', params: { task_id: taskId } }) }).then(response => response.json() as Promise<Envelope>)
    expect(generationBeforeRecharge.error?.code).toBe('RECHARGE_REQUIRED')
    const restGenerationBeforeRecharge = await fetch(`${base}/v1/tasks/${taskId}/content`, { method: 'POST', headers }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(restGenerationBeforeRecharge.status).toBe(402)
    expect(restGenerationBeforeRecharge.body.error?.code).toBe('RECHARGE_REQUIRED')
    const asyncGenerationBeforeRecharge = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'security-generation-before-recharge' }, body: JSON.stringify({}) }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(asyncGenerationBeforeRecharge.status).toBe(402)
    expect(asyncGenerationBeforeRecharge.body.error?.code).toBe('RECHARGE_REQUIRED')
    const batchBeforeRecharge = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'publish.batch.confirm', params: { batch_id: 'batch_not_created', confirmations_json: '[]' } }) }).then(response => response.json() as Promise<Envelope>)
    expect(batchBeforeRecharge.error?.code).toBe('RECHARGE_REQUIRED')
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    // Seed the content version directly after the mandatory production-plan
    // confirmation: model configuration is a separate gate, while this test
    // isolates the publish connector gate.
    service.confirmProductionPlan('ws_publish_gate', taskId, 'security-test')
    const draftVersion = service.createDraft(taskId)
    service.approveContent(taskId, draftVersion.id)
    const preview = service.preparePublish(taskId)
    const response = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'publish-gate-1' }, body: JSON.stringify({ task_id: taskId, content_version_id: draftVersion.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, account_id: 'remote-publish-gate' }) })
    const body = await response.json() as Envelope
    expect(response.status).toBe(503)
    expect(body.error?.code).toBe('PLATFORM_WRITE_NOT_READY')
    expect(service.listPublishJobs('ws_publish_gate')).toHaveLength(0)
    const mcpResponse = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'publish-gate-mcp-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'publish.confirm', params: { task_id: taskId, content_version_id: draftVersion.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, account_id: 'remote-publish-gate' } }) })
    const mcpBody = await mcpResponse.json() as Envelope
    expect(mcpResponse.status).toBe(503)
    expect(mcpBody.error?.code).toBe('PLATFORM_WRITE_NOT_READY')
    expect(service.listPublishJobs('ws_publish_gate')).toHaveLength(0)
  })

  it('requires a bound store for production product imports across MCP and REST', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-import', workspaceId: 'ws_import_gate' }])
    const base = await start()
    const headers = { authorization: 'Bearer token-import', 'x-workspace-id': 'ws_import_gate', 'content-type': 'application/json' }
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.import', params: { platform: 'taobao', title: '未绑定商品' } }) }).then(response => response.json() as Promise<Envelope>)
    expect(mcp.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const rest = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '未绑定商品' }) }).then(response => response.json() as Promise<Envelope>)
    expect(rest.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('enforces the production first-run store onboarding sequence', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-onboarding', workspaceId: 'ws_onboarding_gate' }])
    const base = await start()
    const headers = { authorization: 'Bearer token-onboarding', 'x-workspace-id': 'ws_onboarding_gate', 'content-type': 'application/json' }
    const health = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: {} }) }).then(response => response.json() as Promise<Envelope>)
    expect(health.error).toBeNull()
    const billing = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.status', params: {} }) }).then(response => response.json() as Promise<Envelope>)
    expect(billing.error).toBeNull()
    const catalog = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'catalog.search', params: {} }) }).then(response => response.json() as Promise<Envelope>)
    expect(catalog.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('requires every production task entry to retain an explicit bound store', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-task-store', workspaceId: 'ws_task_store_gate' }])
    const productId = `prod_unbound_task_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_task_store_gate', accountId: undefined })
    service.registerPlatformAccount({ workspaceId: 'ws_task_store_gate', platform: 'taobao', remoteAccountId: 'bound-store', credentialRef: 'vault://bound-store' })
    const base = await start()
    const headers = { authorization: 'Bearer token-task-store', 'x-workspace-id': 'ws_task_store_gate', 'content-type': 'application/json' }
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.create', params: { product_id: productId, platform: 'taobao' } }) }).then(response => response.json() as Promise<Envelope>)
    expect(mcp.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
    const rest = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(rest.status).toBe(400)
    expect(rest.body.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
    const group = await fetch(`${base}/v1/task-groups`, { method: 'POST', headers, body: JSON.stringify({ entries: [{ product_id: productId, platform: 'taobao' }] }) }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(group.status).toBe(400)
    expect(group.body.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
    const mcpGroup = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'task.group.create', params: { entries_json: JSON.stringify([{ product_id: productId, platform: 'taobao' }, { product_id: productId, platform: 'taobao' }]) } }) }).then(response => response.json() as Promise<Envelope>)
    expect(mcpGroup.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
  })

  it('does not allow a publish request to switch a task to another store account', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-store-scope', workspaceId: 'ws_store_scope' }])
    const productId = `prod_store_scope_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_store_scope' })
    service.registerPlatformAccount({ workspaceId: 'ws_store_scope', platform: 'taobao', remoteAccountId: 'store-a', credentialRef: 'vault://opaque-a' })
    service.registerPlatformAccount({ workspaceId: 'ws_store_scope', platform: 'taobao', remoteAccountId: 'store-b', credentialRef: 'vault://opaque-b' })
    const task = service.createTask({ workspaceId: 'ws_store_scope', productId, platform: 'taobao', accountId: 'store-a' })
    const base = await start()
    const response = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { authorization: 'Bearer token-store-scope', 'x-workspace-id': 'ws_store_scope', 'content-type': 'application/json', 'idempotency-key': 'store-scope-conflict' }, body: JSON.stringify({ task_id: task.id, content_version_id: 'version-not-reached', confirmation_hash: 'hash-a', remote_snapshot_hash: 'snapshot-a', account_id: 'store-b' }) })
    const body = await response.json() as Envelope
    expect(response.status).toBe(409)
    expect(body.error?.code).toBe('STORE_ACCOUNT_CONFLICT')
    expect(service.listPublishJobs('ws_store_scope')).toHaveLength(0)
  })

  it('revokes a production account locally before remote cleanup and blocks reuse', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-revoke', workspaceId: 'ws_revoke' }])
    const productId = `prod_revoke_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_revoke', accountId: 'remote-revoke' })
    service.registerPlatformAccount({ workspaceId: 'ws_revoke', platform: 'taobao', remoteAccountId: 'remote-revoke', credentialRef: 'vault://opaque' })
    const base = await start()
    const headers = { authorization: 'Bearer token-revoke', 'x-workspace-id': 'ws_revoke' }
    const response = await fetch(`${base}/v1/platform-accounts/taobao`, { method: 'DELETE', headers: { ...headers, 'x-account-id': 'remote-revoke' } })
    expect(response.status).toBe(503)
    expect((await response.json() as Envelope).error?.code).toBe('PLATFORM_REVOKE_REMOTE_FAILED')
    const accounts = await fetch(`${base}/v1/platform-accounts`, { headers }).then(result => result.json() as Promise<Envelope<{ items: Array<{ platform: string; state: string; readEnabled: boolean }> }>>)
    const taobao = accounts.data?.items.find(item => item.platform === 'taobao')
    expect(taobao).toMatchObject({ state: 'revoked', readEnabled: false })
    const denied = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, platform: 'taobao', account_id: 'remote-revoke' }) })
    expect(denied.status).toBe(428)
    expect((await denied.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const deniedWithoutExplicitStore = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) })
    expect(deniedWithoutExplicitStore.status).toBe(428)
    expect((await deniedWithoutExplicitStore.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const deniedTaskGroupWithoutExplicitStore = await fetch(`${base}/v1/task-groups`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ product_id: productId, platform: 'taobao' }, { product_id: 'missing-second-product', platform: 'jd' }] }) })
    expect(deniedTaskGroupWithoutExplicitStore.status).toBe(428)
    expect((await deniedTaskGroupWithoutExplicitStore.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const deniedCatalogAfterLastRevoke = await fetch(`${base}/v1/products`, { headers })
    expect(deniedCatalogAfterLastRevoke.status).toBe(428)
    expect((await deniedCatalogAfterLastRevoke.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('keeps worker routes on bearer plus workspace HMAC when OIDC is enabled on the internal merchant-api host', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', 'merchant.example.com')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'worker-oidc-secret')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: { token: 'worker-token', signing_secret: 'worker-signing-secret' } }))
    const productId = `prod_worker_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_worker' })
    const task = service.createTask({ workspaceId: 'ws_worker', productId, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_worker', task.id, 'test-worker')
    const job = service.enqueueGeneration({ workspaceId: 'ws_worker', taskId: task.id, idempotencyKey: `worker-${Date.now()}` })
    const base = await start()
    const executionPath = `/v1/generation-jobs/${job.id}`
    const executionHeaders = { host: 'merchant-api', authorization: 'Bearer worker-token', 'x-workspace-id': 'ws_worker', ...workerProofHeaders({ role: 'generation', secret: 'worker-signing-secret', method: 'GET', path: executionPath, workspaceId: 'ws_worker' }) }
    const execution = await fetch(`${base}${executionPath}`, { headers: executionHeaders })
    expect(execution.status).toBe(200)
    expect((await execution.json() as Envelope<{ taskId: string; state: string }>).data).toMatchObject({ taskId: task.id, state: 'queued' })

    const path = `/v1/generation-jobs/${job.id}/result`
    const body = JSON.stringify({ content: workerDecisionContent(productId) })
    const commonHeaders = { host: 'merchant-api', 'x-workspace-id': 'ws_worker', 'content-type': 'application/json' }
    const missing = await fetch(`${base}${path}`, { method: 'POST', headers: commonHeaders, body })
    expect(missing.status).toBe(403)
    expect((await missing.json() as Envelope).error?.code).toBe('FORBIDDEN')

    const invalid = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, authorization: 'Bearer invalid-worker-token', 'x-worker-workspace-signature': '0'.repeat(64) }, body })
    expect(invalid.status).toBe(403)
    expect((await invalid.json() as Envelope).error?.code).toBe('FORBIDDEN')

    const missingSignature = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, authorization: 'Bearer worker-token' }, body })
    expect(missingSignature.status).toBe(403)
    const invalidSignature = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, authorization: 'Bearer worker-token', 'x-worker-workspace-signature': 'f'.repeat(64) }, body })
    expect(invalidSignature.status).toBe(403)

    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const oidcCanonical = ['POST', path, 'ws_worker', 'https://issuer.example.com', 'worker-oidc-user', 'worker-oidc-session', 'platform_ops', 'mfa', authTime, sessionExpiresAt, timestamp].join('\n')
    const oidcSignature = createHmac('sha256', 'worker-oidc-secret').update(oidcCanonical).digest('hex')
    const oidc = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, 'x-oidc-issuer': 'https://issuer.example.com', 'x-oidc-sub': 'worker-oidc-user', 'x-oidc-sid': 'worker-oidc-session', 'x-oidc-workspace': 'ws_worker', 'x-oidc-roles': 'platform_ops', 'x-oidc-amr': 'mfa', 'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': sessionExpiresAt, 'x-oidc-timestamp': timestamp, 'x-oidc-signature': oidcSignature }, body })
    expect(oidc.status).toBe(403)
    expect((await oidc.json() as Envelope).error?.code).toBe('FORBIDDEN')

    const proof = workerProofHeaders({ role: 'generation', secret: 'worker-signing-secret', method: 'POST', path, workspaceId: 'ws_worker', body })
    const tampered = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, authorization: 'Bearer worker-token', ...proof }, body: `${body} ` })
    expect(tampered.status).toBe(403)
    const accepted = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, authorization: 'Bearer worker-token', ...proof }, body })
    // Worker authentication is accepted, but delivery remains pending until
    // the relay posts a settled provider receipt. Auth success must not imply
    // content success or permit an unaccounted generation result.
    expect(accepted.status).toBe(409)
    expect((await accepted.json() as Envelope).error?.code).toBe('MODEL_RELAY_EVIDENCE_REQUIRED')
    const replayed = await fetch(`${base}${path}`, { method: 'POST', headers: { ...commonHeaders, authorization: 'Bearer worker-token', ...proof }, body })
    expect(replayed.status).toBe(409)
    expect((await replayed.json() as Envelope).error?.code).toBe('WORKER_NONCE_REPLAY')
  })

  it('exposes opaque credential locators only through the worker execution gate', async () => {
    vi.stubEnv('WORKER_API_TOKEN', 'worker-context-token')
    const workspaceId = `ws_worker_context_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `remote-${Date.now()}`, credentialRef: 'vault://kv/workspaces/scoped/account' })
    const job = service.createSyncJob({ workspaceId, platform: 'jd', accountId: account.id })
    const base = await start()
    const path = `/v1/sync-jobs/${job.id}/execution-context`
    const denied = await fetch(`${base}${path}`, { headers: { 'x-workspace-id': workspaceId } })
    expect(denied.status).toBe(403)
    const allowed = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer worker-context-token', 'x-workspace-id': workspaceId } })
    expect(allowed.status).toBe(200)
    expect((await allowed.json() as Envelope<{ credential_ref: string }>).data).toEqual(expect.objectContaining({ credential_ref: account.credentialRef }))
  })

  it('accepts only the signed worker automation scheduler endpoint in staging', async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'worker-token': ['ws_worker_automation'] }))
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ automation: [{ token: 'worker-token', signing_secret: 'automation-secret' }, { token: 'previous-worker-token', signing_secret: 'previous-automation-secret' }], generation: { token: 'generation-token', signing_secret: 'generation-secret' } }))
    const base = await start(); const workspaceId = 'ws_worker_automation'; const path = '/v1/internal/automation/tick'
    const unsigned = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': workspaceId } })
    expect(unsigned.status).toBe(403)
    const crossRole = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer generation-token', 'x-workspace-id': workspaceId, ...workerProofHeaders({ role: 'generation', secret: 'generation-secret', method: 'POST', path, workspaceId }) } })
    expect(crossRole.status).toBe(403)
    const previous = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer previous-worker-token', 'x-workspace-id': workspaceId, ...workerProofHeaders({ role: 'automation', secret: 'previous-automation-secret', method: 'POST', path, workspaceId }) } })
    expect(previous.status).toBe(200)
    const signed = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': workspaceId, ...workerProofHeaders({ role: 'automation', secret: 'automation-secret', method: 'POST', path, workspaceId }) } })
    expect(signed.status).toBe(200)
    expect((await signed.json() as Envelope<{ executed: unknown[]; unattendedAutoResubmit: boolean }>).data).toMatchObject({ executed: [], unattendedAutoResubmit: false })
  })

  it('keeps SLA reports on the signed reconcile worker boundary', async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ reconcile: { token: 'reconcile-token', signing_secret: 'reconcile-secret' }, generation: { token: 'generation-token', signing_secret: 'generation-secret' } }))
    const base = await start()
    const workspaceId = `ws_sla_report_${Date.now()}`
    const path = '/v1/internal/support/sla-report'
    const body = JSON.stringify({ workspace_id: workspaceId, report_id: `sla-report-${Date.now()}`, period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-09-01T00:00:00.000Z', cutoff_at: '2026-09-03T00:00:00.000Z' })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }

    const crossRole = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, authorization: 'Bearer generation-token', ...workerProofHeaders({ role: 'generation', secret: 'generation-secret', method: 'POST', path, workspaceId, body }) }, body })
    expect(crossRole.status).toBe(403)
    const signed = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, authorization: 'Bearer reconcile-token', ...workerProofHeaders({ role: 'reconcile', secret: 'reconcile-secret', method: 'POST', path, workspaceId, body }) }, body })
    const signedEnvelope = await signed.json() as Envelope<{ workspaceId: string; reportId: string }>
    expect({ status: signed.status, error: signedEnvelope.error }).toEqual({ status: 200, error: null })
    expect(signedEnvelope.data).toMatchObject({ workspaceId, reportId: expect.stringMatching(/^sla-report-/u) })
  })

  it('authorizes image reconciliation listings only for the reconcile worker', async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ reconcile: { token: 'reconcile-token', signing_secret: 'reconcile-secret' }, generation: { token: 'generation-token', signing_secret: 'generation-secret' } }))
    const base = await start()
    const workspaceId = `ws_image_reconcile_${Date.now()}`
    const path = '/v1/internal/image-generation-jobs/reconciliation'
    const body = JSON.stringify({ workspace_id: workspaceId, limit: 10, query_only: true })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }

    const crossRole = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, authorization: 'Bearer generation-token', ...workerProofHeaders({ role: 'generation', secret: 'generation-secret', method: 'POST', path, workspaceId, body }) }, body })
    expect(crossRole.status).toBe(403)
    const signed = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, authorization: 'Bearer reconcile-token', ...workerProofHeaders({ role: 'reconcile', secret: 'reconcile-secret', method: 'POST', path, workspaceId, body }) }, body })
    expect(signed.status).toBe(200)
    expect((await signed.json() as Envelope<{ attention: unknown[]; next_cursor: string | null }>).data).toMatchObject({ attention: [], next_cursor: null })
  })

  it('fails closed when worker role credentials are shared or a rotation window exceeds two credentials', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const base = await start(); const workspaceId = 'ws_worker_bad_credentials'; const path = '/v1/internal/automation/tick'
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ automation: { token: 'shared-token', signing_secret: 'automation-secret' }, generation: { token: 'shared-token', signing_secret: 'generation-secret' } }))
    const shared = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer shared-token', 'x-workspace-id': workspaceId, ...workerProofHeaders({ role: 'automation', secret: 'automation-secret', method: 'POST', path, workspaceId }) } })
    expect(shared.status).toBe(503)
    expect((await shared.json() as Envelope).error?.code).toBe('WORKER_AUTH_MISCONFIGURED')

    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ automation: [1, 2, 3].map(index => ({ token: `token-${index}`, signing_secret: `secret-${index}` })) }))
    const excessive = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer token-1', 'x-workspace-id': workspaceId, ...workerProofHeaders({ role: 'automation', secret: 'secret-1', method: 'POST', path, workspaceId }) } })
    expect(excessive.status).toBe(503)
    expect((await excessive.json() as Envelope).error?.code).toBe('WORKER_AUTH_MISCONFIGURED')
  })

  it('fails closed when production worker workspace signing is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('WORKER_API_CREDENTIALS', '')
    const base = await start()
    const response = await fetch(`${base}/v1/internal/automation/tick`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': 'ws_worker_missing_signing' } })
    expect(response.status).toBe(503)
    expect((await response.json() as Envelope).error?.code).toBe('WORKER_AUTH_MISCONFIGURED')
  })

  it('enforces a per-workspace request rate limit', async () => {
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '2')
    const base = await start()
    const headers = { 'x-workspace-id': `ws_rate_${Date.now()}` }
    await fetch(`${base}/v1/products`, { headers })
    await fetch(`${base}/v1/products`, { headers })
    const limited = await fetch(`${base}/v1/products`, { headers })
    const body = await limited.json() as Envelope
    expect(limited.status).toBe(429)
    expect(body.error?.code).toBe('RATE_LIMITED')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(body.error?.details).toEqual(expect.objectContaining({ retry_after_seconds: expect.any(Number) }))
  })

  it('prevents cross-tenant job reads and idempotency-key reuse for another intent', async () => {
    const base = await start()
    const owner = `ws_owner_${Date.now()}`
    const attacker = `${owner}_attacker`
    const productId = `prod_security_${Date.now()}`
    service.products.set(productId, { id: productId, workspaceId: owner, platform: 'taobao', storeName: 'owner', remoteId: 'remote', title: 'product', skuCount: 1, stock: 1, factsConfirmed: true, source: 'fixture', updatedAt: new Date().toISOString() })
    const account = service.registerPlatformAccount({ workspaceId: owner, platform: 'taobao', remoteAccountId: `security-owner-${Date.now()}`, credentialRef: 'fixture://security-owner' })
    const create = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ product_id: productId, platform: 'taobao', account_id: account.id }) }).then(response => response.json() as Promise<Envelope>)
    const taskId = (create.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ expected_version: 2 }) })
    const draft = service.createDraft(taskId)
    const contentVersionId = draft.id
    service.approveContent(taskId, contentVersionId)
    const preview = await fetch(`${base}/v1/tasks/${taskId}/publish-preview`, { method: 'POST', headers: { 'x-workspace-id': owner } }).then(response => response.json() as Promise<Envelope>)
    const data = preview.data as { confirmationHash: string; remoteSnapshotHash: string }
    const key = `security-idem-${Date.now()}`
    const publish = { task_id: taskId, content_version_id: contentVersionId, confirmation_hash: data.confirmationHash, remote_snapshot_hash: data.remoteSnapshotHash }
    const first = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner, 'idempotency-key': key }, body: JSON.stringify(publish) })
    expect(first.status).toBe(202)
    const firstBody = await first.json() as Envelope
    const jobId = (firstBody.data as { id: string }).id
    const crossTenantRead = await fetch(`${base}/v1/publish-jobs/${jobId}`, { headers: { 'x-workspace-id': attacker } })
    expect([403, 404]).toContain(crossTenantRead.status)
    const crossTenantCreate = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': attacker, 'idempotency-key': `${key}-attacker` }, body: JSON.stringify(publish) })
    expect(crossTenantCreate.status).toBe(403)
    expect((await crossTenantCreate.json() as Envelope).error?.code).toBe('TENANT_SCOPE_DENIED')
    const conflicting = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner, 'idempotency-key': key }, body: JSON.stringify({ ...publish, remote_snapshot_hash: 'different' }) }).then(response => response.json() as Promise<Envelope>)
    expect(conflicting.error?.code).toBe('IDEMPOTENCY_CONFLICT')
  })
})
