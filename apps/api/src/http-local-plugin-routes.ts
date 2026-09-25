import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import type { LocalPluginConnectionRepository } from '../../../packages/persistence/src/local-plugin-connection-repository.js'
import { LocalPluginInstallInstanceError, type LocalPluginInstallInstanceRepository } from '../../../packages/persistence/src/local-plugin-install-instance-repository.js'

type Input = Record<string, unknown>

export interface LocalPluginConnectionRouteDependencies {
  passwordAuth: PasswordAuthRepository
  connections: LocalPluginConnectionRepository
  installInstances: LocalPluginInstallInstanceRepository
  readBody: (limit: number) => Promise<Input>
  send: (status: number, workspaceId: string, data: unknown) => unknown
  production: boolean
  integrationMode?: string
  publicOrigin: string
}

export function isLocalPluginConnectionRoute(path: string): boolean {
  return path === '/v1/auth/local-plugin/connect-requests'
    || path === '/v1/auth/local-plugin/install-instances/register'
    || path === '/v1/auth/local-plugin/install-instances/pair'
    || /^\/v1\/auth\/local-plugin\/connect-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/status$/iu.test(path)
}

export async function handleLocalPluginConnectionRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: LocalPluginConnectionRouteDependencies): Promise<boolean> {
  if (!isLocalPluginConnectionRoute(path)) return false
  const header = (name: string) => {
    const value = req.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }
  const sessionToken = () => {
    const encoded = (header('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('damai_session='))?.slice('damai_session='.length)
    if (!encoded) return ''
    try { return decodeURIComponent(encoded) } catch { return '' }
  }
  const merchantSession = async () => {
    const current = await deps.passwordAuth.authenticate(sessionToken())
    if (!current || current.account.accountType !== 'merchant' || current.account.status !== 'active') throw new DomainError('AUTH_SESSION_INVALID', '会话已过期，请重新登录商家后台', 401)
    return current
  }
  res.setHeader('cache-control', 'no-store')
  if (req.method === 'POST' && path === '/v1/auth/local-plugin/install-instances/register') {
    if (process.env.LOCAL_PLUGIN_ONE_CLICK_ENABLED !== 'true') throw new DomainError('LOCAL_PLUGIN_ONE_CLICK_UNAVAILABLE', '本地插件一键连接尚未启用', 503)
    const input = await deps.readBody(16 * 1024)
    try {
      if (input.platform !== 'windows' && input.platform !== 'macos') throw new LocalPluginInstallInstanceError()
      const registered = await deps.installInstances.register({ platform: input.platform, publicKey: String(input.installation_public_key_spki ?? '') })
      deps.send(201, 'unknown', { installation_id: registered.instance.id, key_id: registered.instance.publicKeyFingerprint, platform: registered.instance.platform, pairing_token: registered.pairingToken, pairing_expires_at: registered.pairingExpiresAt })
      return true
    } catch (error) { if (error instanceof LocalPluginInstallInstanceError) throw new DomainError(error.code, '安装实例注册信息无效', 400); throw error }
  }
  if (req.method === 'POST' && path === '/v1/auth/local-plugin/install-instances/pair') {
    if (process.env.LOCAL_PLUGIN_ONE_CLICK_ENABLED !== 'true') throw new DomainError('LOCAL_PLUGIN_ONE_CLICK_UNAVAILABLE', '本地插件一键连接尚未启用', 503)
    if (header('origin')?.trim() !== deps.publicOrigin) throw new DomainError('AUTH_CSRF_ORIGIN_INVALID', '安装实例配对来源无效', 403)
    const current = await merchantSession()
    const input = await deps.readBody(16 * 1024), workspaceIds = [...new Set(current.account.workspaceIds.filter(Boolean))], workspaceId = String(input.workspace_id ?? '').trim()
    if (!workspaceId || !workspaceIds.includes(workspaceId)) throw new DomainError('MCP_OAUTH_WORKSPACE_AMBIGUOUS', '安装实例与当前账号工作区不一致', 409)
    try {
      const instance = await deps.installInstances.pair({ instanceId: String(input.installation_id ?? ''), pairingToken: String(input.pairing_token ?? ''), accountId: current.account.id, identityId: current.account.identityId, workspaceId })
      deps.send(200, workspaceId, { installation_id: instance.id, key_id: instance.publicKeyFingerprint, platform: instance.platform, paired: true })
      return true
    } catch (error) { if (error instanceof LocalPluginInstallInstanceError) throw new DomainError(error.code, '安装实例配对无效或已过期', 409); throw error }
  }
  if (req.method === 'POST' && path === '/v1/auth/local-plugin/connect-requests') {
    if (deps.production && deps.integrationMode !== 'local_stdio') throw new DomainError('MCP_LOCAL_TOKEN_FLOW_DISABLED', '当前部署未启用本地插件凭据', 409)
    if (process.env.LOCAL_PLUGIN_ONE_CLICK_ENABLED !== 'true') throw new DomainError('LOCAL_PLUGIN_ONE_CLICK_UNAVAILABLE', '本地插件一键连接尚未启用', 503)
    const origin = deps.publicOrigin
    if (header('origin')?.trim() !== origin) throw new DomainError('AUTH_CSRF_ORIGIN_INVALID', '本地插件连接来源无效', 403)
    const current = await merchantSession()
    const input = await deps.readBody(16 * 1024)
    const workspaceIds = [...new Set(current.account.workspaceIds.filter(Boolean))]
    const workspaceId = String(input.workspace_id ?? input.workspaceId ?? '').trim()
    if (!workspaceId || !workspaceIds.includes(workspaceId)) throw new DomainError('MCP_OAUTH_WORKSPACE_AMBIGUOUS', '连接请求与当前账号工作区不一致', 409)
    const installationId = String(input.installation_id ?? '').trim()
    if ((deps.production || process.env.LOCAL_PLUGIN_INSTANCE_BINDING_REQUIRED === 'true') && !installationId) throw new DomainError('LOCAL_PLUGIN_INSTALL_INSTANCE_REQUIRED', '生产一键连接必须绑定已配对的安装实例', 409)
    if (installationId && !await deps.installInstances.getForOwner({ id: installationId, accountId: current.account.id, identityId: current.account.identityId, workspaceId })) throw new DomainError('LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID', '安装实例未配对或不属于当前工作区', 409)
    const request = await deps.connections.create({ accountId: current.account.id, identityId: current.account.identityId, workspaceId })
    const challenge = installationId ? await deps.installInstances.issueChallenge({ instanceId: installationId, requestId: request.id, accountId: current.account.id, identityId: current.account.identityId, workspaceId }) : undefined
    const launch = new URL('storenova://connect')
    launch.searchParams.set('api_origin', origin); launch.searchParams.set('workspace', workspaceId); launch.searchParams.set('request_id', request.id)
    if (challenge) { launch.searchParams.set('installation_id', installationId); launch.searchParams.set('challenge_id', challenge.id); launch.searchParams.set('server_nonce', challenge.nonce); launch.searchParams.set('challenge_issued_at', challenge.createdAt); launch.searchParams.set('challenge_expires_at', challenge.expiresAt) }
    deps.send(201, workspaceId, { request_id: request.id, status: request.status, expires_at: request.expiresAt, launch_url: launch.toString(), ...(challenge ? { installation_id: installationId, challenge_id: challenge.id, server_nonce: challenge.nonce, challenge_issued_at: challenge.createdAt, challenge_expires_at: challenge.expiresAt } : {}) })
    return true
  }
  const statusMatch = path.match(/^\/v1\/auth\/local-plugin\/connect-requests\/([^/]+)\/status$/u)
  if (req.method === 'GET' && statusMatch) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(statusMatch[1]!)) throw new DomainError('LOCAL_PLUGIN_CONNECTION_NOT_FOUND', '连接请求不存在', 404)
    const current = await merchantSession()
    const workspaceIds = [...new Set(current.account.workspaceIds.filter(Boolean))]
    const workspaceId = url.searchParams.get('workspace_id')?.trim() || (workspaceIds.length === 1 ? workspaceIds[0] : undefined)
    if (!workspaceId || !workspaceIds.includes(workspaceId)) throw new DomainError('MCP_OAUTH_WORKSPACE_AMBIGUOUS', '请指定当前账号已授权的工作区', 409)
    const request = await deps.connections.getForAccount({ id: statusMatch[1]!, accountId: current.account.id, workspaceId })
    if (!request) throw new DomainError('LOCAL_PLUGIN_CONNECTION_NOT_FOUND', '连接请求不存在', 404)
    deps.send(200, request.workspaceId, { request_id: request.id, status: request.status, expires_at: request.expiresAt, ...(request.exchangedAt ? { connected_at: request.exchangedAt } : {}) })
    return true
  }
  return false
}
