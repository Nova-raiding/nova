import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

// This fixture is deliberately HTTP loopback-only. The __Host- prefix would
// require Secure/TLS and Chromium would correctly discard such cookies here.
const SESSION_COOKIE = 'ops_local_oidc_session'
const LOGIN_CSRF_COOKIE = 'ops_local_oidc_login_csrf'
const MAX_PROXY_BODY_BYTES = 50 * 1024 * 1024
type OpsWorkbench = 'platform' | 'workspace'

export interface LocalOidcGatewayConfig {
  uiUpstream: string
  apiUpstream: string
  username: string
  password: string
  sessionSecret: string
  oidcSigningSecret: string
  issuer: string
  subject: string
  workspaceId: string
  roles: readonly string[]
  workbench?: OpsWorkbench
  amr?: readonly string[]
  sessionTtlSeconds?: number
}

interface GatewaySession {
  sub: string
  workspace: string
  sid: string
  authTime: number
  expiresAt: number
  csrf: string
}

function fail(message: string): never { throw new Error(message) }

function validatedConfig(input: LocalOidcGatewayConfig): Required<LocalOidcGatewayConfig> {
  const uiUpstream = loopbackUrl(input.uiUpstream, 'uiUpstream')
  const apiUpstream = loopbackUrl(input.apiUpstream, 'apiUpstream')
  if (!input.username.trim()) fail('LOCAL_OIDC_TEST_USERNAME is required')
  if (input.password.length < 12) fail('LOCAL_OIDC_TEST_PASSWORD must contain at least 12 characters')
  if (input.sessionSecret.length < 24) fail('LOCAL_OIDC_SESSION_SECRET must contain at least 24 characters')
  // Match the API's established test fixture while still rejecting trivial
  // local secrets. Production entropy requirements remain deployment policy.
  if (input.oidcSigningSecret.length < 16) fail('OIDC_PROXY_SIGNING_SECRET must contain at least 16 characters')
  if (!input.subject.trim()) fail('OIDC subject is required')
  const issuer = new URL(input.issuer)
  if (issuer.protocol !== 'https:' && issuer.hostname !== '127.0.0.1' && issuer.hostname !== 'localhost')
    fail('OIDC issuer must use HTTPS or a loopback hostname')
  const roles = [...new Set(input.roles.map(value => value.trim()).filter(Boolean))].sort()
  const workbench = input.workbench ?? 'platform'
  if (workbench !== 'platform' && workbench !== 'workspace') fail('workbench must be platform or workspace')
  const amr = [...new Set((input.amr ?? ['mfa', 'pwd']).map(value => value.trim()).filter(Boolean))].sort()
  if (roles.length === 0) fail('at least one OIDC role is required')
  const sessionTtlSeconds = input.sessionTtlSeconds ?? 900
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 3600)
    fail('sessionTtlSeconds must be between 60 and 3600')
  return { ...input, uiUpstream, apiUpstream, issuer: issuer.toString().replace(/\/$/u, ''), roles, workbench, amr, sessionTtlSeconds }
}

function loopbackUrl(raw: string, name: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
    fail(`${name} must be a loopback HTTP URL`)
  return url.toString().replace(/\/$/u, '')
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function signedValue(value: string, secret: string): string {
  return `${value}.${sign(value, secret)}`
}

function verifySignedValue(value: string | undefined, secret: string): string | undefined {
  if (!value) return undefined
  const separator = value.lastIndexOf('.')
  if (separator <= 0) return undefined
  const payload = value.slice(0, separator)
  return safeEqual(sign(payload, secret), value.slice(separator + 1)) ? payload : undefined
}

function cookies(req: IncomingMessage): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    output[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim())
  }
  return output
}

function sessionCookie(session: GatewaySession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
  return signedValue(payload, secret)
}

function readSession(req: IncomingMessage, config: Required<LocalOidcGatewayConfig>): GatewaySession | undefined {
  const payload = verifySignedValue(cookies(req)[SESSION_COOKIE], config.sessionSecret)
  if (!payload) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<GatewaySession>
    const now = Math.floor(Date.now() / 1000)
    if (parsed.sub !== config.subject || (config.workspaceId && parsed.workspace !== config.workspaceId) || (config.workbench === 'workspace' && !parsed.workspace) || typeof parsed.workspace !== 'string' ||
        typeof parsed.sid !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(parsed.sid) ||
        typeof parsed.csrf !== 'string' || typeof parsed.authTime !== 'number' ||
        typeof parsed.expiresAt !== 'number' || parsed.authTime > now + 60 || parsed.expiresAt <= now)
      return undefined
    return parsed as GatewaySession
  } catch { return undefined }
}

async function bodyBytes(req: IncomingMessage, maxBytes = MAX_PROXY_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) throw new Error('request body exceeds gateway limit')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function safeReturnTo(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function loginPage(csrf: string, returnTo: string, error = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ops 安全登录</title><style>body{font:16px system-ui;background:#f5f7fb;margin:0;display:grid;min-height:100vh;place-items:center}.card{background:white;border:1px solid #d8dee9;border-radius:14px;padding:28px;width:min(88vw,380px);box-shadow:0 12px 36px #1f29371a}label{display:block;margin:16px 0 6px}input,button{box-sizing:border-box;width:100%;min-height:44px;font:inherit;border-radius:8px}input{border:1px solid #9ca3af;padding:10px}button{margin-top:20px;border:0;background:#155eef;color:white;font-weight:700}.error{color:#b42318}small{color:#667085}</style></head><body><main class="card"><h1>Merchant Ops Console</h1><p>本地 OIDC Gateway 安全登录</p>${error ? `<p class="error" role="alert">${htmlEscape(error)}</p>` : ''}<form method="post" action="/auth/login"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><input type="hidden" name="return_to" value="${htmlEscape(returnTo)}"><label for="username">运营账号</label><input id="username" name="username" autocomplete="username" required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">安全登录</button></form><small>登录凭据和 OIDC 签名密钥仅存在于服务端环境变量。</small></main></body></html>`
}

function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...extra })
  res.end(html)
}

function redirectToLogin(req: IncomingMessage, res: ServerResponse): void {
  const target = safeReturnTo(req.url ?? '/')
  res.writeHead(302, { location: `/auth/login?return_to=${encodeURIComponent(target)}`, 'cache-control': 'no-store' })
  res.end()
}

function forwardedHeaders(source: IncomingHttpHeaders): Headers {
  const output = new Headers()
  const blocked = /^(?:authorization|connection|content-length|cookie|host|proxy-|sec-|transfer-encoding|upgrade|x-forwarded-|x-oidc-)/iu
  for (const [name, raw] of Object.entries(source)) {
    if (blocked.test(name) || raw === undefined) continue
    for (const value of Array.isArray(raw) ? raw : [raw]) output.append(name, value)
  }
  return output
}

async function proxy(req: IncomingMessage, res: ServerResponse, upstream: string, target: string, headers: Headers, body?: Buffer): Promise<void> {
  const response = await fetch(`${upstream}${target}`, {
    method: req.method,
    headers,
    body: body && body.length > 0 ? Uint8Array.from(body).buffer : undefined,
    redirect: 'manual',
  })
  const responseHeaders: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    if (!['content-encoding', 'content-length', 'connection', 'transfer-encoding', 'set-cookie'].includes(name.toLowerCase())) responseHeaders[name] = value
  })
  responseHeaders['cache-control'] = responseHeaders['cache-control'] ?? 'no-store'
  res.writeHead(response.status, responseHeaders)
  res.end(Buffer.from(await response.arrayBuffer()))
}

function oidcProofHeaders(config: Required<LocalOidcGatewayConfig>, input: { method: string; target: string; workspace: string; workbench: OpsWorkbench; subject: string; sid: string; authTime: number; expiresAt: number; body: Buffer }): Headers {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(24).toString('base64url')
  const bodyDigest = createHash('sha256').update(input.body).digest('hex')
  const roles = config.roles.join(',')
  const amr = config.amr.join(',')
  const canonical = [input.method, input.target, input.workspace, input.workbench, config.issuer, input.subject, input.sid, roles, amr, String(input.authTime), String(input.expiresAt), timestamp, bodyDigest, nonce].join('\n')
  const headers = new Headers({
    'content-type': 'application/json',
    'x-oidc-issuer': config.issuer,
    'x-oidc-sub': input.subject,
    'x-oidc-sid': input.sid,
    'x-oidc-workspace': input.workspace,
    'x-oidc-workbench': input.workbench,
    'x-oidc-roles': roles,
    'x-oidc-amr': amr,
    'x-oidc-auth-time': String(input.authTime),
    'x-oidc-session-expires-at': String(input.expiresAt),
    'x-oidc-timestamp': timestamp,
    'x-oidc-body-sha256': bodyDigest,
    'x-oidc-nonce': nonce,
    'x-oidc-signature': createHmac('sha256', config.oidcSigningSecret).update(canonical).digest('hex'),
  })
  return headers
}

async function bootstrapWorkspace(config: Required<LocalOidcGatewayConfig>, session: Omit<GatewaySession, 'workspace' | 'csrf'>): Promise<string> {
  const target = '/mcp'
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: randomBytes(12).toString('hex'), method: 'workspace.bootstrap', params: { display_name: 'Local OIDC Browser E2E' } }))
  const headers = oidcProofHeaders(config, { method: 'POST', target, workspace: '', workbench: 'workspace', subject: session.sub, sid: session.sid, authTime: session.authTime, expiresAt: session.expiresAt, body })
  headers.set('x-workspace-bootstrap', 'true')
  const response = await fetch(`${config.apiUpstream}${target}`, { method: 'POST', headers, body: Uint8Array.from(body).buffer })
  const envelope = await response.json() as { data?: { result?: { workspaceId?: unknown } }; error?: { code?: unknown; message?: unknown } }
  const workspaceId = envelope.data?.result?.workspaceId
  if (!response.ok || typeof workspaceId !== 'string' || !workspaceId.trim())
    throw new Error(`OIDC workspace bootstrap failed (${response.status} ${String(envelope.error?.code ?? 'INVALID_RESPONSE')})`)
  return workspaceId.trim()
}

export function createLocalOidcGateway(rawConfig: LocalOidcGatewayConfig): Server {
  const config = validatedConfig(rawConfig)
  return createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('ok\n'); return
      }
      if (requestUrl.pathname === '/auth/login' && req.method === 'GET') {
        const token = signedValue(randomBytes(24).toString('base64url'), config.sessionSecret)
        sendHtml(res, 200, loginPage(token, safeReturnTo(requestUrl.searchParams.get('return_to'))), {
          'set-cookie': `${LOGIN_CSRF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`,
        }); return
      }
      if (requestUrl.pathname === '/auth/login' && req.method === 'POST') {
        const form = new URLSearchParams((await bodyBytes(req, 16 * 1024)).toString('utf8'))
        const loginCsrf = cookies(req)[LOGIN_CSRF_COOKIE]
        const validCsrf = Boolean(verifySignedValue(loginCsrf, config.sessionSecret)) && safeEqual(loginCsrf ?? '', form.get('csrf') ?? '')
        const validCredentials = safeEqual(config.username, form.get('username') ?? '') && safeEqual(config.password, form.get('password') ?? '')
        if (!validCsrf || !validCredentials) {
          const token = signedValue(randomBytes(24).toString('base64url'), config.sessionSecret)
          sendHtml(res, 401, loginPage(token, safeReturnTo(form.get('return_to')), '账号、密码或登录会话无效。'), {
            'set-cookie': `${LOGIN_CSRF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`,
          }); return
        }
        const now = Math.floor(Date.now() / 1000)
        const identitySession = { sub: config.subject, sid: randomBytes(24).toString('base64url'), authTime: now, expiresAt: now + config.sessionTtlSeconds }
        const workspace = config.workspaceId || (config.workbench === 'workspace' ? await bootstrapWorkspace(config, identitySession) : '')
        const session: GatewaySession = { ...identitySession, workspace, csrf: randomBytes(24).toString('base64url') }
        res.writeHead(303, {
          location: safeReturnTo(form.get('return_to')),
          'cache-control': 'no-store',
          'set-cookie': [`${SESSION_COOKIE}=${encodeURIComponent(sessionCookie(session, config.sessionSecret))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtlSeconds}`, `${LOGIN_CSRF_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`],
        }); res.end(); return
      }
      const session = readSession(req, config)
      if (!session) { redirectToLogin(req, res); return }
      if (requestUrl.pathname === '/auth/session' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ subject: session.sub, workspaceId: session.workspace, expiresAt: new Date(session.expiresAt * 1000).toISOString(), amr: config.amr }))
        return
      }
      if (requestUrl.pathname === '/auth/logout' && req.method === 'POST') {
        res.writeHead(303, { location: '/auth/login', 'cache-control': 'no-store', 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); res.end(); return
      }
      if (requestUrl.pathname.startsWith('/api/')) {
        const requestedWorkspace = typeof req.headers['x-workspace-id'] === 'string' ? req.headers['x-workspace-id'].trim() : ''
        if (requestedWorkspace && requestedWorkspace !== session.workspace) {
          res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'workspace does not match authenticated OIDC session' } })); return
        }
        const requestedWorkbench = typeof req.headers['x-ops-workbench'] === 'string' ? req.headers['x-ops-workbench'].trim() : ''
        if (requestedWorkbench && requestedWorkbench !== config.workbench) {
          res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { code: 'AUTHZ_WORKBENCH_FORBIDDEN', message: 'workbench does not match the configured OIDC gateway session' } })); return
        }
        const target = `${requestUrl.pathname.slice(4) || '/'}${requestUrl.search}`
        const bytes = await bodyBytes(req)
        const headers = forwardedHeaders(req.headers)
        const proof = oidcProofHeaders(config, { method: req.method ?? 'GET', target, workspace: session.workspace, workbench: config.workbench, subject: session.sub, sid: session.sid, authTime: session.authTime, expiresAt: session.expiresAt, body: bytes })
        proof.forEach((value, name) => headers.set(name, value))
        await proxy(req, res, config.apiUpstream, target, headers, bytes); return
      }
      await proxy(req, res, config.uiUpstream, `${requestUrl.pathname}${requestUrl.search}`, forwardedHeaders(req.headers)); return
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: { code: 'LOCAL_OIDC_GATEWAY_ERROR', message: error instanceof Error ? error.message : 'gateway failure' } }))
    }
  })
}

export function localOidcGatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LocalOidcGatewayConfig {
  return {
    uiUpstream: env.LOCAL_OIDC_UI_UPSTREAM ?? 'http://127.0.0.1:18092',
    // Keep this host distinct from the release-sim merchant bearer hostname
    // (127.0.0.1), otherwise the API correctly selects the merchant boundary.
    apiUpstream: env.LOCAL_OIDC_API_UPSTREAM ?? 'http://localhost:8787',
    username: env.LOCAL_OIDC_TEST_USERNAME ?? '',
    password: env.LOCAL_OIDC_TEST_PASSWORD ?? '',
    sessionSecret: env.LOCAL_OIDC_SESSION_SECRET ?? '',
    oidcSigningSecret: env.OIDC_PROXY_SIGNING_SECRET ?? '',
    issuer: env.LOCAL_OIDC_ISSUER ?? 'http://127.0.0.1/local-test-idp',
    subject: env.LOCAL_OIDC_SUBJECT ?? 'actor_demo',
    // Empty means: bootstrap/reuse the subject's workspace through the real
    // signed workspace.bootstrap API instead of mutating membership storage.
    workspaceId: env.LOCAL_OIDC_WORKSPACE_ID ?? '',
    roles: (env.LOCAL_OIDC_ROLES ?? 'platform_ops').split(','),
    workbench: env.LOCAL_OIDC_WORKBENCH === 'workspace' ? 'workspace' : 'platform',
    amr: (env.LOCAL_OIDC_AMR ?? 'mfa,pwd').split(','),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.LOCAL_OIDC_GATEWAY_PORT ?? 18093)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail('LOCAL_OIDC_GATEWAY_PORT must be between 1024 and 65535')
  const server = createLocalOidcGateway(localOidcGatewayConfigFromEnv())
  server.listen(port, '127.0.0.1', () => process.stdout.write(`local OIDC gateway listening on http://127.0.0.1:${port}\n`))
}
