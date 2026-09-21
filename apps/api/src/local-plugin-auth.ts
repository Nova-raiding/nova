export const LOCAL_PLUGIN_CLIENT_ID = 'local-desktop'
export const LOCAL_PLUGIN_CALLBACK_PATH = '/merchant-mcp-callback'

export type LocalPluginAuthorizationRequest = {
  clientId: typeof LOCAL_PLUGIN_CLIENT_ID
  redirectUri: string
  state: string
  codeChallenge: string
  scope: 'merchant'
  resource: string
  workspaceId: string
}

export class LocalPluginAuthorizationRequestError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'INVALID_REDIRECT_URI') {
    super(code)
    this.name = 'LocalPluginAuthorizationRequestError'
  }
}

function single(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key)
  return values.length === 1 ? values[0] : undefined
}

export function validateLocalPluginRedirectUri(value: string): string {
  let target: URL
  try { target = new URL(value) } catch { throw new LocalPluginAuthorizationRequestError('INVALID_REDIRECT_URI') }
  const port = Number(target.port)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
    || !Number.isSafeInteger(port) || port < 1024 || port > 65_535
    || target.pathname !== LOCAL_PLUGIN_CALLBACK_PATH || target.username || target.password
    || target.search || target.hash || value !== target.toString()) {
    throw new LocalPluginAuthorizationRequestError('INVALID_REDIRECT_URI')
  }
  return target.toString()
}

export function parseLocalPluginAuthorizationRequest(params: URLSearchParams): LocalPluginAuthorizationRequest {
  const responseType = single(params, 'response_type')
  const clientId = single(params, 'client_id')
  const redirectUri = single(params, 'redirect_uri')
  const state = single(params, 'state')
  const codeChallenge = single(params, 'code_challenge')
  const codeChallengeMethod = single(params, 'code_challenge_method')
  const scope = single(params, 'scope')
  const resource = single(params, 'resource')
  const workspaceId = single(params, 'workspace_id')
  if (responseType !== 'code' || clientId !== LOCAL_PLUGIN_CLIENT_ID || !redirectUri || !state || !/^[A-Za-z0-9_-]{43}$/u.test(state)
    || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)
    || codeChallengeMethod !== 'S256' || scope !== 'merchant' || !resource
    || !workspaceId || workspaceId.length > 128 || !/^(?:ws|workspace)_[A-Za-z0-9_-]+$/u.test(workspaceId)) {
    throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  }
  return { clientId, redirectUri: validateLocalPluginRedirectUri(redirectUri), state, codeChallenge, scope, resource, workspaceId }
}

export type LocalPluginTokenRequest = {
  clientId: typeof LOCAL_PLUGIN_CLIENT_ID
  redirectUri: string
  code: string
  codeVerifier: string
  resource: string
  workspaceId: string
}

export function parseLocalPluginTokenRequest(params: URLSearchParams): LocalPluginTokenRequest {
  const clientId = single(params, 'client_id')
  const grantType = single(params, 'grant_type')
  const redirectUri = single(params, 'redirect_uri')
  const code = single(params, 'code')
  const codeVerifier = single(params, 'code_verifier')
  const resource = single(params, 'resource')
  const workspaceId = single(params, 'workspace_id')
  if (clientId !== LOCAL_PLUGIN_CLIENT_ID || grantType !== 'authorization_code' || !redirectUri
    || !code || code.length > 16_384 || !codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)
    || !resource || !workspaceId || workspaceId.length > 128 || !/^(?:ws|workspace)_[A-Za-z0-9_-]+$/u.test(workspaceId)) {
    throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  }
  return { clientId, redirectUri: validateLocalPluginRedirectUri(redirectUri), code, codeVerifier, resource, workspaceId }
}

export function escapeLocalPluginHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function localPluginAuthorizationHtml(input: LocalPluginAuthorizationRequest, account: { login: string; workspaceId: string }): string {
  const hidden = [
    ['response_type', 'code'], ['client_id', input.clientId], ['redirect_uri', input.redirectUri], ['state', input.state],
    ['code_challenge', input.codeChallenge], ['code_challenge_method', 'S256'], ['scope', input.scope],
    ['resource', input.resource], ['workspace_id', input.workspaceId],
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeLocalPluginHtml(value!)}">`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>授权 Store Nova 本地插件</title></head><body><main><h1>授权 Store Nova 本地插件</h1><p>登录账号：${escapeLocalPluginHtml(account.login)}</p><p>工作区：${escapeLocalPluginHtml(account.workspaceId)}</p><p>仅允许本机安装器连接当前工作区。授权不会绑定第三方店铺，也不会执行扣费或发布。</p><form method="post" action="/v1/auth/local-plugin/authorize">${hidden}<button type="submit">确认授权本地插件</button></form><p><a href="/">取消并返回商家后台</a></p></main></body></html>`
}

export function localPluginLoginRequiredHtml(input: LocalPluginAuthorizationRequest): string {
  const query = new URLSearchParams({ response_type: 'code', client_id: input.clientId, redirect_uri: input.redirectUri, state: input.state, code_challenge: input.codeChallenge, code_challenge_method: 'S256', scope: input.scope, resource: input.resource, workspace_id: input.workspaceId }).toString()
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>请先登录</title></head><body><main><h1>需要商家登录</h1><p>请先在新标签页登录 Store Nova 商家后台。登录完成后回到本页继续；PKCE challenge 和 state 会保留在当前授权地址中。</p><p><a href="/" target="_blank" rel="noopener noreferrer">新标签页打开商家后台登录</a></p><p><a href="/v1/auth/local-plugin/authorize?${escapeLocalPluginHtml(query)}">我已登录，继续授权</a></p></main></body></html>`
}
