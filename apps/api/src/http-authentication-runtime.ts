import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type CapabilityId, type MemberRole, type OpsWorkbench } from '../../../packages/contracts/src/index.js'
import type { RequestPrincipal, AuthenticationRuntime } from './server.js'

export async function authenticateRequest(req: IncomingMessage, dependencies: AuthenticationRuntime): Promise<void> {
  const {
    mcpIntegrationMode, isProduction, header, passwordAuthRepository, isTrustedPlatformBrowserOrigin,
    requestPrincipals, hydrateDurableAuthorizationContext, requiresStrictAuth, workspaceMemberRoles,
    requestActor, localPluginTokenContext, safeEqual, CAPABILITIES, canonicalizeRole, platformCanonicalRoles,
    observeAuthenticatedPrincipal, environment,
  } = dependencies

  // A valid password session is an explicit identity assertion and must take
  // precedence over the local fixture adapter. Otherwise development mode
  // silently replaces a real platform login with actor_demo, making the
  // login cookie appear accepted while every API call still runs as demo.
  const isMcpRequest = (req.url ?? '').split('?')[0] === '/mcp'
  const integrationMode = isMcpRequest ? mcpIntegrationMode() : undefined
  if (isMcpRequest && isProduction() && environment.VITEST !== 'true' && !integrationMode) throw new DomainError('MCP_INTEGRATION_MODE_NOT_CONFIGURED', 'MCP 接入模式未配置', 503)
  const localStdio = integrationMode === 'local_stdio'
  const mcpOAuthBoundary = isMcpRequest && localStdio
  const authorizationHeader = header(req, 'authorization')?.trim() ?? ''
  const passwordCookie = (header(req, 'cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('damai_session='))?.slice('damai_session='.length)
  let invalidPasswordSession = false
  if (passwordCookie) {
    let rawToken = ''
    try { rawToken = decodeURIComponent(passwordCookie) } catch { rawToken = '' }
    if (rawToken) {
      const session = await passwordAuthRepository.authenticate(rawToken)
      if (session) {
        const platform = session.account.accountType === 'platform'
        // Local desktop MCP access and browser operations share the /mcp
        // transport, but not the same credential. A merchant browser session
        // must exchange for a short-lived local-desktop token; an authenticated
        // platform session remains usable by the desktop operations console.
        if (mcpOAuthBoundary && !platform) {
          if (!/^Bearer\s+[^\s]+$/iu.test(authorizationHeader)) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '商家插件 MCP 请求必须携带本地插件凭据', 401)
        } else {
          if (isMcpRequest && platform && isProduction()) {
            const requestOrigin = header(req, 'origin')?.trim()
            if (!isTrustedPlatformBrowserOrigin(req, requestOrigin)) throw new DomainError('AUTH_CSRF_ORIGIN_INVALID', '运营工作台请求来源无效', 403)
          }
          const requestedWorkspace = header(req, 'x-workspace-id')?.trim()
          if (!platform && requestedWorkspace && !session.account.workspaceIds.includes(requestedWorkspace)) {
            throw new DomainError(ERROR_CODES.FORBIDDEN, '请求工作区不属于当前商家账号', 403)
          }
          // Audit actor IDs must be stable opaque identity keys. Login identifiers
          // may contain characters such as "@", which are intentionally rejected
          // by the operation-audit identity grammar and must never become the
          // authorization actor principal.
          const principal: RequestPrincipal = { actorId: session.account.identityId, externalSubject: session.account.login, workspaceIdentityIssuer: 'damai-password', accountLogin: session.account.login, identityId: session.account.identityId, sessionId: session.sessionId, sessionSubject: session.sessionId, sessionKind: 'api_token', sessionIssuedAt: session.issuedAt, sessionExpiresAt: session.expiresAt, roles: session.account.roles, workspaces: session.account.workspaceIds, workbench: platform ? 'platform' : 'workspace', availableWorkbenches: platform ? ['platform', 'workspace'] : ['workspace'], identityStatus: 'active', mfaVerified: false }
          requestPrincipals.set(req, principal)
          await hydrateDurableAuthorizationContext(req, principal)
          return
        }
      } else invalidPasswordSession = true
    }
    else invalidPasswordSession = true
  }
  if (invalidPasswordSession) throw new DomainError('AUTH_SESSION_INVALID', '平台登录会话已失效，请重新登录', 401)
  if (mcpOAuthBoundary && !/^Bearer\s+[^\s]+$/iu.test(authorizationHeader)) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, 'MCP 请求必须携带本地插件凭据', 401)
  if (!requiresStrictAuth()) {
    const requestedWorkbench = header(req, 'x-ops-workbench')?.trim()
    if (requestedWorkbench && requestedWorkbench !== 'platform' && requestedWorkbench !== 'workspace') throw new DomainError('AUTHZ_WORKBENCH_ASSERTION_INVALID', '工作台只能是 platform 或 workspace', 400)
    const roles = (header(req, 'x-role') ?? '').split(',').map(value => value.trim()).filter(Boolean)
    const workbench: OpsWorkbench = requestedWorkbench === 'platform' ? 'platform' : 'workspace'
    const localMemberRole = workbench === 'workspace' ? roles.find(role => workspaceMemberRoles.has(role as MemberRole)) as MemberRole | undefined : undefined
    requestPrincipals.set(req, {
      actorId: requestActor(req, 'actor_demo'),
      workspaces: [header(req, 'x-workspace-id')?.trim() || 'ws_demo'],
      roles,
      workbench,
      availableWorkbenches: requestedWorkbench === 'platform' ? ['platform', 'workspace'] : ['workspace'],
      ...(localMemberRole ? { memberRole: localMemberRole, memberStatus: 'active' as const } : {}),
    })
    return
  }
  // The merchant UI/plugin and operations console share this API service but
  // keep separate password and local-plugin credential boundaries.
  const merchantBearerHostname = environment.MERCHANT_BEARER_HOSTNAME?.trim().toLowerCase()
  const requestHostname = (() => {
    const forwardedHost = header(req, 'x-forwarded-host')?.split(',')[0]?.trim()
    const host = (forwardedHost || header(req, 'host')?.trim() || '').trim().toLowerCase()
    try { return new URL(`https://${host}`).hostname.toLowerCase() } catch { return '' }
  })()
  const merchantBearerRequest = Boolean(merchantBearerHostname && requestHostname === merchantBearerHostname)
  const authorization = authorizationHeader
  const encodedCookieToken = (header(req, 'cookie') ?? '')
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith('damai_session='))
    ?.slice('damai_session='.length)
  let cookieToken: string | undefined
  try { cookieToken = encodedCookieToken ? decodeURIComponent(encodedCookieToken) : undefined } catch { cookieToken = undefined }
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? cookieToken
  if (!token) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '生产请求必须携带有效 Bearer token', 401)
  if (isMcpRequest) {
    if (localStdio) {
      const context = localPluginTokenContext(req)
      const oauthPrincipal = await passwordAuthRepository.authenticateMcpAccessToken({ ...context, clientId: 'local-desktop', accessToken: token })
      if (!oauthPrincipal) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '本地插件 MCP token 无效或已过期', 401)
      const requestedWorkspace = header(req, 'x-workspace-id')?.trim()
      if (requestedWorkspace && requestedWorkspace !== oauthPrincipal.workspaceId) throw new DomainError(ERROR_CODES.FORBIDDEN, '本地插件 token 无权切换到其他工作区', 403)
      const principal: RequestPrincipal = { credentialSource: 'mcp_oauth', actorId: oauthPrincipal.identityId, externalSubject: oauthPrincipal.accountLogin, workspaceIdentityIssuer: 'damai-password', accountLogin: oauthPrincipal.accountLogin, identityId: oauthPrincipal.identityId, sessionId: oauthPrincipal.tokenId, sessionSubject: oauthPrincipal.tokenId, sessionKind: 'api_token', sessionIssuedAt: oauthPrincipal.issuedAt, sessionExpiresAt: oauthPrincipal.expiresAt, roles: ['merchant'], workspaces: [oauthPrincipal.workspaceId], workbench: 'workspace', availableWorkbenches: ['workspace'], identityStatus: 'active', mfaVerified: false }
      requestPrincipals.set(req, principal)
      await hydrateDurableAuthorizationContext(req, principal)
      return
    }
  }
  const publicOpsBase = environment.PUBLIC_OPS_BASE_URL?.trim()
  const publicOpsHostname = publicOpsBase ? (() => { try { return new URL(publicOpsBase).hostname.toLowerCase() } catch { return '' } })() : ''
  const usesBearerCredential = /^Bearer\s+[^\s]+$/iu.test(authorizationHeader ?? '')
  if (usesBearerCredential && publicOpsHostname && requestHostname === publicOpsHostname && !localStdio) {
    throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '运营台必须使用账号密码会话登录', 401)
  }
  let grants: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(environment.API_AUTH_TOKENS ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid grants')
    grants = parsed as Record<string, unknown>
  } catch {
    throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '服务端认证映射未正确配置', 401)
  }
  const matched = Object.keys(grants).find(known => safeEqual(known, token))
  const permitted = matched ? grants[matched] : undefined
  const grant = permitted && typeof permitted === 'object' && !Array.isArray(permitted) ? permitted as Record<string, unknown> : undefined
  const workspaceValues = Array.isArray(permitted) ? permitted : grant?.workspaces
  const workspaces = Array.isArray(workspaceValues) ? workspaceValues.filter((value): value is string => typeof value === 'string') : []
  const roles = Array.isArray(grant?.roles) ? grant.roles.filter((value): value is string => typeof value === 'string') : []
  const rawDeniedCapabilities = Array.isArray(grant?.denied_capabilities) ? grant.denied_capabilities.filter((value): value is string => typeof value === 'string') : []
  const unknownDeniedCapabilities = rawDeniedCapabilities.filter(value => !CAPABILITIES.includes(value as CapabilityId))
  if (unknownDeniedCapabilities.length) throw new DomainError('AUTHZ_EXPLICIT_DENY_INVALID', '服务端 token grant 包含未知 capability deny，已拒绝认证', 503)
  const explicitDeniedCapabilities = [...new Set(rawDeniedCapabilities)] as CapabilityId[]
  const configuredWorkbenches = Array.isArray(grant?.workbenches) ? grant.workbenches.filter((value): value is string => typeof value === 'string') : []
  const invalidWorkbenches = configuredWorkbenches.filter(value => value !== 'platform' && value !== 'workspace')
  if (invalidWorkbenches.length) throw new DomainError('AUTHZ_WORKBENCH_GRANT_INVALID', '服务端 token grant 包含未知 workbench，已拒绝认证', 503)
  const availableWorkbenches = [...new Set((configuredWorkbenches.length ? configuredWorkbenches : ['workspace']) as OpsWorkbench[])]
  const requestedWorkbench = header(req, 'x-ops-workbench')?.trim()
  if (requestedWorkbench && requestedWorkbench !== 'platform' && requestedWorkbench !== 'workspace') throw new DomainError('AUTHZ_WORKBENCH_ASSERTION_INVALID', '工作台只能是 platform 或 workspace', 400)
  const workbench: OpsWorkbench = merchantBearerRequest ? 'workspace'
    : requestedWorkbench === 'platform' ? 'platform'
      : requestedWorkbench === 'workspace' ? 'workspace'
        : availableWorkbenches.length === 1 ? availableWorkbenches[0]!
          : 'workspace'
  if (merchantBearerRequest && requestedWorkbench === 'platform') throw new DomainError('AUTHZ_WORKBENCH_FORBIDDEN', '商家 Bearer 边界固定为 workspace 工作台', 403)
  if (!availableWorkbenches.includes(workbench)) throw new DomainError('AUTHZ_WORKBENCH_FORBIDDEN', 'Bearer token grant 未授权所选工作台', 403)
  const actorId = typeof grant?.actor_id === 'string' && grant.actor_id.trim() ? grant.actor_id.trim() : ''
  const requested = header(req, 'x-workspace-id')?.trim()
  const bootstrapRequested = header(req, 'x-workspace-bootstrap') === 'true'
  const wildcardAllowed = environment.NODE_ENV !== 'production' && environment.ALLOW_WILDCARD_WORKSPACE_GRANT === 'true'
  const hasPlatformRole = roles.some(role => {
    const canonicalRole = canonicalizeRole(role, 'gateway')
    return canonicalRole !== undefined && platformCanonicalRoles.has(canonicalRole)
  })
  if (workbench === 'platform' && !hasPlatformRole) throw new DomainError('AUTHZ_WORKBENCH_FORBIDDEN', 'Bearer token 没有平台工作台角色', 403)
  if (!matched || (workbench === 'workspace' && !requested && !bootstrapRequested) || (!requested && bootstrapRequested && grant?.bootstrap !== true) || (requested && (workspaces.includes('*') ? !wildcardAllowed : !workspaces.includes(requested)))) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Bearer token 无权访问该工作区或创建新工作区', 403)
  const principal: RequestPrincipal = { actorId, workspaces, roles, workbench, availableWorkbenches: merchantBearerRequest ? ['workspace'] : availableWorkbenches, explicitDeniedCapabilities, issuer: typeof grant?.issuer === 'string' && grant.issuer.trim() ? grant.issuer.trim() : 'urn:merchant:api-token', sessionSubject: token, sessionKind: 'api_token', sessionIssuedAt: new Date().toISOString(), mfaVerified: false }
  requestPrincipals.set(req, principal)
  await observeAuthenticatedPrincipal(req, principal)
  const claimedActor = header(req, 'x-actor-id')?.trim()
  if (claimedActor && claimedActor !== principal.actorId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'X-Actor-Id 与认证身份不一致', 403)
}
