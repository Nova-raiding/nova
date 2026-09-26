import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { WorkspaceBootstrapError, type WorkspaceBootstrapRepository } from '../../../packages/persistence/src/workspace-bootstrap-repository.js'

/** Routes backed by the account/password session. Local-plugin OAuth lives separately. */
export const passwordAccountRoutePaths = new Set([
  '/v1/auth/register', '/v1/auth/login', '/v1/auth/session', '/v1/auth/logout',
  '/v1/auth/refresh', '/v1/auth/password/reset-request',
  '/v1/auth/password/reset-confirm', '/v1/auth/password/change',
  '/v1/auth/workspace-bootstrap',
])

type Input = Record<string, unknown>

export interface PasswordAuthRouteDependencies {
  repository: PasswordAuthRepository
  readBody: (limit: number) => Promise<Input>
  send: (status: number, workspaceId: string, data: unknown) => void
  production: boolean
  publicOrigin: string
  workspaceBootstrap: WorkspaceBootstrapRepository
  onWorkspaceCreated?: (workspaceId: string) => void
}

/** Returns false when the route belongs to another module. Errors use the API's DomainError boundary. */
export async function handlePasswordAuthRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: PasswordAuthRouteDependencies): Promise<boolean> {
  if (!passwordAccountRoutePaths.has(path)) return false
  const { repository, readBody, send } = deps
  const header = (name: string) => {
    const value = req.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }
  const sessionToken = () => {
    const encoded = (header('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('damai_session='))?.slice('damai_session='.length)
    if (!encoded) return ''
    try { return decodeURIComponent(encoded) } catch { return '' }
  }
  const cookie = (token: string, maxAge = 8 * 60 * 60) => `damai_session=${encodeURIComponent(token)}; Path=/; HttpOnly${deps.production || deps.publicOrigin.startsWith('https://') || (req.socket as { encrypted?: boolean }).encrypted === true ? '; Secure' : ''}; SameSite=Lax; Max-Age=${maxAge}`
  res.setHeader('cache-control', 'no-store')
  if (req.method === 'POST' && path === '/v1/auth/register') {
    if (process.env.ALLOW_MERCHANT_SELF_REGISTRATION !== 'true') throw new DomainError('AUTH_PUBLIC_REGISTRATION_DISABLED', '商家账号由平台运营创建，请联系平台运营获取登录账号', 403)
    const input = await readBody(64 * 1024)
    try {
      const registered = await repository.register({ login: String(input.login ?? input.account ?? ''), password: String(input.password ?? ''), enterpriseName: String(input.enterprise_name ?? input.enterpriseName ?? ''), contactName: String(input.contact_name ?? input.contactName ?? ''), termsAgreed: input.terms_agreed === true || input.termsAgreed === true })
      send(201, 'unknown', { application_id: registered.applicationId, login: registered.account.login.replace(/^(.{1,2}).*(@.*)?$/u, '$1***$2'), status: registered.account.status })
      return true
    } catch (error) {
      const code = (error as { code?: string }).code
      const status = code === 'AUTH_LOGIN_ALREADY_EXISTS' ? 409 : code === 'AUTH_PASSWORD_POLICY_INVALID' || code === 'AUTH_REGISTRATION_INVALID' || code === 'AUTH_LOGIN_INVALID' ? 400 : 500
      throw new DomainError(code ?? 'AUTH_REGISTRATION_FAILED', status === 500 ? '注册暂时不可用' : code === 'AUTH_LOGIN_ALREADY_EXISTS' ? '账号已存在' : code === 'AUTH_PASSWORD_POLICY_INVALID' ? '密码至少 8 位并同时包含字母和数字' : '注册信息无效', status)
    }
  }
  if (req.method === 'POST' && path === '/v1/auth/login') {
    const input = await readBody(32 * 1024)
    try {
      const logged = await repository.login({ login: String(input.login ?? input.account ?? ''), password: String(input.password ?? ''), ip: header('x-forwarded-for')?.split(',')[0]?.trim() ?? req.socket.remoteAddress, userAgent: header('user-agent') })
      if (logged.principal.account.status !== 'active') throw Object.assign(new Error('AUTH_ACCOUNT_NOT_ACTIVE'), { code: 'AUTH_ACCOUNT_NOT_ACTIVE' })
      const requestedAccountType = input.account_type === 'merchant' || input.account_type === 'platform' ? input.account_type : undefined
      if (requestedAccountType && logged.principal.account.accountType !== requestedAccountType) {
        await repository.logout(logged.token, 'account_type_mismatch')
        throw Object.assign(new Error('AUTH_ACCOUNT_TYPE_MISMATCH'), { code: 'AUTH_ACCOUNT_TYPE_MISMATCH' })
      }
      res.setHeader('set-cookie', cookie(logged.token))
      send(200, 'unknown', { account: logged.principal.account, session_id: logged.principal.sessionId, expires_at: logged.principal.expiresAt })
      return true
    } catch (error) {
      const code = (error as { code?: string }).code
      console.error('password auth login failed', { code: code ?? 'AUTH_UNKNOWN', login_present: typeof input.login === 'string' && input.login.trim().length > 0, requested_account_type: input.account_type === 'merchant' || input.account_type === 'platform' ? input.account_type : undefined })
      const status = code === 'AUTH_ACCOUNT_LOCKED' ? 423 : code === 'AUTH_ACCOUNT_NOT_ACTIVE' ? 403 : code === 'AUTH_ACCOUNT_TYPE_MISMATCH' ? 403 : code === 'AUTH_LOGIN_INVALID' ? 400 : 401
      throw new DomainError(code ?? 'AUTH_INVALID_CREDENTIALS', status === 423 ? '尝试过多，请稍后重试或联系管理员' : status === 403 && code === 'AUTH_ACCOUNT_TYPE_MISMATCH' ? '当前账号类型与此登录入口不匹配' : status === 403 ? '账号尚未开通，请等待平台运营审核' : status === 400 ? '账号格式无效' : '账号或密码错误', status, status === 423 ? { retry_after_seconds: 900 } : undefined)
    }
  }
  if (req.method === 'GET' && path === '/v1/auth/session') {
    const current = await repository.authenticate(sessionToken())
    if (!current) throw new DomainError('AUTH_SESSION_INVALID', '会话已过期，请重新登录', 401)
    send(200, 'unknown', { account: current.account, session_id: current.sessionId, issued_at: current.issuedAt, expires_at: current.expiresAt, workspaces: current.account.workspaceIds, roles: current.account.roles })
    return true
  }
  if (req.method === 'POST' && path === '/v1/auth/logout') {
    await repository.logout(sessionToken())
    res.setHeader('set-cookie', [cookie('', 0), 'ops_local_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
    send(200, 'unknown', { logged_out: true })
    return true
  }
  if (req.method === 'POST' && path === '/v1/auth/refresh') {
    try {
      const refreshed = await repository.refresh(sessionToken())
      res.setHeader('set-cookie', cookie(refreshed.token))
      send(200, 'unknown', { session_id: refreshed.principal.sessionId, expires_at: refreshed.principal.expiresAt })
      return true
    } catch { throw new DomainError('AUTH_SESSION_INVALID', '会话已过期，请重新登录', 401) }
  }
  if (req.method === 'POST' && path === '/v1/auth/password/reset-request') {
    const input = await readBody(16 * 1024)
    const reset = await repository.requestPasswordReset(String(input.login ?? input.account ?? ''))
    send(202, 'unknown', { accepted: reset.accepted, ...(reset.token ? { reset_token: reset.token } : {}) })
    return true
  }
  if (req.method === 'POST' && path === '/v1/auth/password/reset-confirm') {
    const input = await readBody(32 * 1024)
    try {
      await repository.confirmPasswordReset(String(input.token ?? input.reset_token ?? ''), String(input.password ?? ''))
      res.setHeader('set-cookie', cookie('', 0))
      send(200, 'unknown', { reset: true })
      return true
    } catch (error) {
      const code = (error as { code?: string }).code
      throw new DomainError(code ?? 'AUTH_RESET_TOKEN_INVALID', code === 'AUTH_PASSWORD_POLICY_INVALID' ? '密码至少 8 位并同时包含字母和数字' : '重置链接无效或已过期', 400)
    }
  }
  if (req.method === 'POST' && path === '/v1/auth/password/change') {
    const input = await readBody(32 * 1024)
    const token = sessionToken()
    if (!token) throw new DomainError('AUTH_SESSION_INVALID', '请先登录后再修改密码', 401)
    try {
      await repository.changePassword({ token, currentPassword: String(input.current_password ?? ''), newPassword: String(input.new_password ?? input.password ?? '') })
      res.setHeader('set-cookie', cookie('', 0))
      send(200, 'unknown', { changed: true, login_required: true })
      return true
    } catch (error) {
      const code = (error as { code?: string }).code
      const status = code === 'AUTH_SESSION_INVALID' ? 401 : code === 'AUTH_CURRENT_PASSWORD_INVALID' ? 403 : 400
      throw new DomainError(code ?? 'AUTH_PASSWORD_CHANGE_FAILED', code === 'AUTH_CURRENT_PASSWORD_INVALID' ? '当前密码不正确' : code === 'AUTH_PASSWORD_POLICY_INVALID' ? '密码至少 8 位并同时包含字母和数字' : '修改密码失败，请重新登录后重试', status)
    }
  }
  if (req.method === 'POST' && path === '/v1/auth/workspace-bootstrap') {
    // Only an active, workspace-less merchant password account can take
    // this first-run path. It cannot mint a workspace-scoped MCP token until
    // the durable owner membership and account binding both exist.
    if (header('origin')?.trim() !== deps.publicOrigin) throw new DomainError('AUTH_CSRF_ORIGIN_INVALID', '首次工作区创建来源无效', 403)
    const current = await repository.authenticate(sessionToken())
    if (!current || current.account.accountType !== 'merchant' || current.account.status !== 'active') throw new DomainError('AUTH_SESSION_INVALID', '请先登录已开通的商家账号', 401)
    if (current.account.workspaceIds.length !== 0) throw new DomainError('AUTH_BOOTSTRAP_ACCOUNT_CHANGED', '当前账号已绑定工作区，不能再次创建', 409)
    const input = await readBody(16 * 1024)
    const displayName = String(input.display_name ?? '').normalize('NFKC').trim()
    if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f\u200b-\u200f]/u.test(displayName)) throw new DomainError('INVALID_REQUEST', '工作区名称无效', 400)
    try {
      await repository.assertBootstrapEligible({ login: current.account.login, identityId: current.account.identityId })
      const workspace = await deps.workspaceBootstrap.bootstrap({
        issuer: 'damai-password', externalSubject: current.account.login, identityId: current.account.identityId,
        candidateWorkspaceId: `ws_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        displayName, actorId: current.account.identityId, allowCreate: true,
      })
      await repository.bindBootstrappedWorkspace({ login: current.account.login, identityId: current.account.identityId, workspaceId: workspace.workspaceId })
      deps.onWorkspaceCreated?.(workspace.workspaceId)
      send(201, workspace.workspaceId, { workspace_id: workspace.workspaceId, status: 'active', reused: !workspace.created, next_action: 'local_plugin_connect' })
      return true
    } catch (error) {
      if (error instanceof WorkspaceBootstrapError) throw new DomainError(error.code, '商家身份与首次工作区绑定无效，请联系管理员核查', error.code === 'WORKSPACE_BOOTSTRAP_BINDING_INACTIVE' ? 409 : 403)
      if ((error as { code?: string }).code === 'AUTH_BOOTSTRAP_PRINCIPAL_INVALID') throw new DomainError('AUTH_BOOTSTRAP_PRINCIPAL_INVALID', '商家身份状态或风控校验未通过，不能创建工作区', 403)
      if (['AUTH_BOOTSTRAP_ACCOUNT_CHANGED', 'AUTH_BOOTSTRAP_MEMBERSHIP_INVALID'].includes((error as { code?: string }).code ?? '')) throw new DomainError((error as { code: string }).code, '首次工作区绑定未完成，请重新登录或联系管理员', 409)
      throw error
    }
  }
  if (req.method !== 'GET' && req.method !== 'POST') throw new DomainError('METHOD_NOT_ALLOWED', '不支持的认证请求方法', 405)
  return false
}
