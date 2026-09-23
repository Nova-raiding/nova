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
  /** Correlates a browser-initiated one-click request. It is not a credential. */
  requestId?: string
  installInstanceId?: string
  instanceChallengeId?: string
  instanceSignature?: string
  clientNonce?: string
  serverNonce?: string
  challengeIssuedAt?: string
  challengeExpiresAt?: string
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
  const requestId = single(params, 'connection_request_id')
  const installInstanceId = single(params, 'installation_id')
  const instanceChallengeId = single(params, 'challenge_id')
  const instanceSignature = single(params, 'instance_signature')
  const clientNonce = single(params, 'client_nonce'), serverNonce = single(params, 'server_nonce'), challengeIssuedAt = single(params, 'challenge_issued_at'), challengeExpiresAt = single(params, 'challenge_expires_at')
  if (responseType !== 'code' || clientId !== LOCAL_PLUGIN_CLIENT_ID || !redirectUri || !state || !/^[A-Za-z0-9_-]{43}$/u.test(state)
    || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)
    || codeChallengeMethod !== 'S256' || scope !== 'merchant' || !resource
    || !workspaceId || workspaceId.length > 128 || !/^(?:ws|workspace)_[A-Za-z0-9_-]+$/u.test(workspaceId)) {
    throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  }
  if (requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  const instanceFields = [installInstanceId, instanceChallengeId, instanceSignature, clientNonce, serverNonce, challengeIssuedAt, challengeExpiresAt]
  if (instanceFields.some(Boolean) && !instanceFields.every(Boolean)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  if (installInstanceId && !/^[0-9a-f-]{36}$/iu.test(installInstanceId)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  if (instanceChallengeId && !/^[0-9a-f-]{36}$/iu.test(instanceChallengeId)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  if (instanceSignature && !/^[A-Za-z0-9_-]{80,128}$/u.test(instanceSignature)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  if (clientNonce && !/^[A-Za-z0-9_-]{43}$/u.test(clientNonce) || serverNonce && !/^[A-Za-z0-9_-]{43}$/u.test(serverNonce) || challengeIssuedAt && !Number.isFinite(Date.parse(challengeIssuedAt)) || challengeExpiresAt && !Number.isFinite(Date.parse(challengeExpiresAt))) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  return { clientId, redirectUri: validateLocalPluginRedirectUri(redirectUri), state, codeChallenge, scope, resource, workspaceId, ...(requestId ? { requestId } : {}), ...(installInstanceId ? { installInstanceId, instanceChallengeId: instanceChallengeId!, instanceSignature: instanceSignature!, clientNonce: clientNonce!, serverNonce: serverNonce!, challengeIssuedAt: challengeIssuedAt!, challengeExpiresAt: challengeExpiresAt! } : {}) }
}

export type LocalPluginTokenRequest = {
  clientId: typeof LOCAL_PLUGIN_CLIENT_ID
  redirectUri: string
  code: string
  codeVerifier: string
  resource: string
  workspaceId: string
  requestId?: string
  installInstanceId?: string
}

export function parseLocalPluginTokenRequest(params: URLSearchParams): LocalPluginTokenRequest {
  const clientId = single(params, 'client_id')
  const grantType = single(params, 'grant_type')
  const redirectUri = single(params, 'redirect_uri')
  const code = single(params, 'code')
  const codeVerifier = single(params, 'code_verifier')
  const resource = single(params, 'resource')
  const workspaceId = single(params, 'workspace_id')
  const requestId = single(params, 'connection_request_id')
  const installInstanceId = single(params, 'installation_id')
  if (clientId !== LOCAL_PLUGIN_CLIENT_ID || grantType !== 'authorization_code' || !redirectUri
    || !code || code.length > 16_384 || !codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)
    || !resource || !workspaceId || workspaceId.length > 128 || !/^(?:ws|workspace)_[A-Za-z0-9_-]+$/u.test(workspaceId)) {
    throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  }
  if (requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  if (installInstanceId !== undefined && !/^[0-9a-f-]{36}$/iu.test(installInstanceId)) throw new LocalPluginAuthorizationRequestError('INVALID_REQUEST')
  return { clientId, redirectUri: validateLocalPluginRedirectUri(redirectUri), code, codeVerifier, resource, workspaceId, ...(requestId ? { requestId } : {}), ...(installInstanceId ? { installInstanceId } : {}) }
}

export function escapeLocalPluginHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const localPluginAuthStyles = `<style>
:root{color-scheme:light;--ink:#18252b;--muted:#65757a;--line:#dce6e3;--paper:#f3f7f5;--card:#fff;--brand:#087f72;--brand-dark:#06675e;--soft:#eaf5f1;--warning:#8a6118}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% -25%,#d9eee7 0,transparent 55%),var(--paper);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;padding:32px 20px}
main{width:min(100%,540px);background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 20px 55px #173c3212;padding:36px}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:30px;color:var(--brand-dark);font-weight:700;letter-spacing:.01em}.brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:var(--soft);font-size:18px}
.eyebrow{margin:0 0 8px;color:var(--brand);font-size:12px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}h1{margin:0;font-size:28px;line-height:1.25;letter-spacing:-.025em} .intro{margin:12px 0 26px;color:var(--muted)}
.summary{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 22px}.summary-item{min-width:0;padding:14px 16px;background:#f7faf9;border:1px solid var(--line);border-radius:12px}.label{display:block;margin-bottom:3px;color:var(--muted);font-size:12px}.value{display:block;overflow-wrap:anywhere;font-weight:650}
.permissions{padding:18px 18px 17px;border:1px solid var(--line);border-radius:12px}.permissions h2{margin:0 0 12px;font-size:14px}.permissions ul{display:grid;gap:9px;margin:0;padding:0;list-style:none;color:#405157;font-size:14px}.permissions li{display:flex;gap:9px;align-items:flex-start}.check{flex:none;color:var(--brand);font-weight:800}
.notice{margin:15px 0 22px;padding:12px 14px;border-radius:10px;background:#fff8e9;color:#73571c;font-size:13px}.actions{display:grid;gap:12px}.primary{width:100%;min-height:48px;border:0;border-radius:11px;background:var(--brand);color:white;font:inherit;font-weight:700;cursor:pointer;transition:background .15s,transform .15s}.primary:hover{background:var(--brand-dark)}.primary:active{transform:translateY(1px)}.primary:focus-visible,a:focus-visible{outline:3px solid #54b8a5;outline-offset:3px}.secondary{display:block;text-align:center;color:var(--muted);font-size:14px;text-decoration:none}.secondary:hover{color:var(--brand-dark);text-decoration:underline}
.login-link{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 17px;border-radius:10px;background:var(--brand);color:#fff;text-decoration:none;font-weight:700}.login-link:hover{background:var(--brand-dark)}.login-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}.login-actions .secondary{align-self:center;padding:10px}
@media(max-width:520px){body{padding:16px 12px}main{padding:25px 20px;border-radius:16px}.brand{margin-bottom:24px}h1{font-size:24px}.summary{grid-template-columns:1fr}}
</style>`

function localPluginAuthHead(title: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f3f7f5"><title>${escapeLocalPluginHtml(title)}</title>${localPluginAuthStyles}</head><body>`
}

function localPluginBrand(): string {
  return '<div class="brand"><span class="brand-mark" aria-hidden="true">S</span><span>Store Nova</span></div>'
}

export function localPluginAuthorizationHtml(input: LocalPluginAuthorizationRequest, account: { login: string; workspaceId: string }): string {
  const hidden = [
    ['response_type', 'code'], ['client_id', input.clientId], ['redirect_uri', input.redirectUri], ['state', input.state],
    ['code_challenge', input.codeChallenge], ['code_challenge_method', 'S256'], ['scope', input.scope],
    ['resource', input.resource], ['workspace_id', input.workspaceId], ...(input.requestId ? [['connection_request_id', input.requestId]] : []), ...(input.installInstanceId ? [['installation_id', input.installInstanceId], ['challenge_id', input.instanceChallengeId!], ['instance_signature', input.instanceSignature!], ['client_nonce', input.clientNonce!], ['server_nonce', input.serverNonce!], ['challenge_issued_at', input.challengeIssuedAt!], ['challenge_expires_at', input.challengeExpiresAt!]] : []),
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeLocalPluginHtml(value!)}">`).join('')
  return `${localPluginAuthHead('确认插件授权')}<main>${localPluginBrand()}<p class="eyebrow">本地插件连接</p><h1>连接 Store Nova 插件</h1><p class="intro">确认后，已安装在本机的插件将获得当前工作区的商家 API 访问权限。</p><section class="summary" aria-label="授权账号与工作区"><div class="summary-item"><span class="label">登录账号</span><span class="value">${escapeLocalPluginHtml(account.login)}</span></div><div class="summary-item"><span class="label">授权工作区</span><span class="value">${escapeLocalPluginHtml(account.workspaceId)}</span></div></section><section class="permissions" aria-labelledby="permission-title"><h2 id="permission-title">授权范围</h2><ul><li><span class="check" aria-hidden="true">✓</span><span>仅连接此工作区的 Store Nova 本地插件</span></li><li><span class="check" aria-hidden="true">✓</span><span>不会连接第三方店铺或执行店铺操作</span></li><li><span class="check" aria-hidden="true">✓</span><span>不会因本次授权扣费或发布内容</span></li></ul></section><p class="notice">请确认账号和工作区属于你。授权凭据保存在这台电脑的系统凭据库中。</p><form method="post" action="/v1/auth/local-plugin/authorize" class="actions">${hidden}<button class="primary" type="submit">确认授权本地插件</button><a class="secondary" href="/">取消并返回商家后台</a></form></main></body></html>`
}

export function localPluginLoginRequiredHtml(input: LocalPluginAuthorizationRequest): string {
  const query = new URLSearchParams({ response_type: 'code', client_id: input.clientId, redirect_uri: input.redirectUri, state: input.state, code_challenge: input.codeChallenge, code_challenge_method: 'S256', scope: input.scope, resource: input.resource, workspace_id: input.workspaceId, ...(input.requestId ? { connection_request_id: input.requestId } : {}), ...(input.installInstanceId ? { installation_id: input.installInstanceId, challenge_id: input.instanceChallengeId!, instance_signature: input.instanceSignature!, client_nonce: input.clientNonce!, server_nonce: input.serverNonce!, challenge_issued_at: input.challengeIssuedAt!, challenge_expires_at: input.challengeExpiresAt! } : {}) }).toString()
  return `${localPluginAuthHead('登录 Store Nova 后继续')}<main>${localPluginBrand()}<p class="eyebrow">需要登录</p><h1>登录后继续授权</h1><p class="intro">先在商家后台登录，再回来继续本地插件授权。当前授权请求会保留。</p><div class="summary"><div class="summary-item"><span class="label">授权工作区</span><span class="value">${escapeLocalPluginHtml(input.workspaceId)}</span></div><div class="summary-item"><span class="label">访问范围</span><span class="value">商家工作区</span></div></div><div class="login-actions"><a class="login-link" href="/" target="_blank" rel="noopener noreferrer">打开商家后台登录</a><a class="secondary" href="/v1/auth/local-plugin/authorize?${escapeLocalPluginHtml(query)}">我已登录，继续</a></div></main></body></html>`
}
