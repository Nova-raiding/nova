import { createHash, createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalOidcGateway, type LocalOidcGatewayConfig } from './local-oidc-gateway.js'

const servers: Server[] = []

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
})

async function fixture(overrides: Partial<LocalOidcGatewayConfig> = {}) {
  const observed: Array<{ target: string; headers: Record<string, string | string[] | undefined>; body: string }> = []
  const ui = await listen(createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Authenticated Ops</h1>') }))
  const signingSecret = 'oidc-signing-secret-for-local-tests'
  const api = await listen(createServer(async (req, res) => {
    const body = await new Promise<string>((resolve, reject) => { const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => resolve(Buffer.concat(chunks).toString())); req.on('error', reject) })
    observed.push({ target: req.url ?? '', headers: req.headers, body })
    const fields = ['x-oidc-workspace', 'x-oidc-workbench', 'x-oidc-issuer', 'x-oidc-sub', 'x-oidc-sid', 'x-oidc-roles', 'x-oidc-amr', 'x-oidc-auth-time', 'x-oidc-session-expires-at', 'x-oidc-timestamp', 'x-oidc-body-sha256', 'x-oidc-nonce'] as const
    const values = Object.fromEntries(fields.map(name => [name, String(req.headers[name] ?? '')]))
    const canonical = [req.method, req.url, values['x-oidc-workspace'], values['x-oidc-workbench'], values['x-oidc-issuer'], values['x-oidc-sub'], values['x-oidc-sid'], values['x-oidc-roles'], values['x-oidc-amr'], values['x-oidc-auth-time'], values['x-oidc-session-expires-at'], values['x-oidc-timestamp'], values['x-oidc-body-sha256'], values['x-oidc-nonce']].join('\n')
    const valid = createHash('sha256').update(body).digest('hex') === values['x-oidc-body-sha256'] && createHmac('sha256', signingSecret).update(canonical).digest('hex') === req.headers['x-oidc-signature']
    res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify(valid && req.headers['x-workspace-bootstrap'] === 'true'
      ? { data: { result: { workspaceId: 'ws_bootstrapped' } } }
      : { valid }))
  }))
  const config: LocalOidcGatewayConfig = { uiUpstream: ui, apiUpstream: api, username: 'ops@example.test', password: 'correct horse battery', sessionSecret: 'session-secret-for-local-oidc-tests', oidcSigningSecret: signingSecret, issuer: 'https://local-idp.example.test', subject: 'actor_demo', workspaceId: 'ws_demo', roles: ['platform_ops', 'rules_admin'], amr: ['pwd', 'mfa'], ...overrides }
  const gateway = await listen(createLocalOidcGateway(config))
  return { gateway, observed }
}

function cookieFrom(response: Response, name: string): string {
  const raw = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))
  if (!raw) throw new Error(`missing ${name} cookie`)
  return raw.split(';', 1)[0] ?? ''
}

async function login(gateway: string, password = 'correct horse battery'): Promise<{ response: Response; sessionCookie?: string }> {
  const wall = await fetch(`${gateway}/auth/login?return_to=%2Ftasks`, { redirect: 'manual' })
  const csrfCookie = cookieFrom(wall, 'ops_local_oidc_login_csrf')
  const csrf = (await wall.text()).match(/name="csrf" value="([^"]+)"/u)?.[1]
  const response = await fetch(`${gateway}/auth/login`, { method: 'POST', redirect: 'manual', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: csrf ?? '', return_to: '/tasks', username: 'ops@example.test', password }) })
  const sessionCookie = response.status === 303 ? cookieFrom(response, 'ops_local_oidc_session') : undefined
  return { response, sessionCookie }
}

describe('local authenticated OIDC gateway', () => {
  it('enforces the login wall and rejects invalid credentials', async () => {
    const { gateway } = await fixture()
    const wall = await fetch(`${gateway}/tasks`, { redirect: 'manual' })
    expect(wall.status).toBe(302)
    expect(wall.headers.get('location')).toBe('/auth/login?return_to=%2Ftasks')
    const invalid = await login(gateway, 'definitely-wrong')
    expect(invalid.response.status).toBe(401)
    expect(await invalid.response.text()).toContain('账号、密码或登录会话无效')
  })

  it('creates an HttpOnly session and signs the exact API request without trusting browser identity headers', async () => {
    const { gateway, observed } = await fixture()
    const authenticated = await login(gateway)
    expect(authenticated.response.status).toBe(303)
    expect(authenticated.response.headers.get('location')).toBe('/tasks')
    expect(authenticated.response.headers.getSetCookie().join('\n')).toContain('HttpOnly')
    expect(authenticated.response.headers.getSetCookie().join('\n')).toContain('SameSite=Strict')
    const page = await fetch(`${gateway}/tasks`, { headers: { cookie: authenticated.sessionCookie ?? '' } })
    expect(await page.text()).toContain('Authenticated Ops')
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: {} })
    const api = await fetch(`${gateway}/api/mcp?evidence=1`, { method: 'POST', headers: { cookie: authenticated.sessionCookie ?? '', authorization: 'Bearer browser-injected', 'content-type': 'application/json', 'x-workspace-id': 'ws_demo', 'x-oidc-sub': 'attacker' }, body })
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ valid: true })
    expect(observed[0]).toMatchObject({ target: '/mcp?evidence=1', body })
    expect(observed[0]?.headers.authorization).toBeUndefined()
    expect(observed[0]?.headers['x-oidc-sub']).toBe('actor_demo')
    expect(observed[0]?.headers['x-oidc-roles']).toBe('platform_ops,rules_admin')
    expect(observed[0]?.headers['x-oidc-workbench']).toBe('platform')
  })

  it('bootstraps and exposes a first-login workspace through signed OIDC APIs', async () => {
    const { gateway, observed } = await fixture({ workspaceId: '', workbench: 'workspace', subject: 'new-oidc-operator', roles: ['workspace_owner'] })
    const authenticated = await login(gateway)
    expect(authenticated.response.status).toBe(303)
    expect(observed[0]?.headers['x-workspace-bootstrap']).toBe('true')
    expect(observed[0]?.headers['x-oidc-workspace']).toBe('')
    expect(observed[0]?.headers['x-oidc-workbench']).toBe('workspace')
    const session = await fetch(`${gateway}/auth/session`, { headers: { cookie: authenticated.sessionCookie ?? '' } })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ subject: 'new-oidc-operator', workspaceId: 'ws_bootstrapped', amr: ['mfa', 'pwd'] })
  })

  it('signs a pure platform session without bootstrapping or forwarding a tenant workspace', async () => {
    const { gateway, observed } = await fixture({ workspaceId: '', workbench: 'platform', roles: ['platform_ops'] })
    const authenticated = await login(gateway)
    expect(authenticated.response.status).toBe(303)
    expect(observed).toHaveLength(0)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.session', params: {} })
    const response = await fetch(`${gateway}/api/mcp`, { method: 'POST', headers: { cookie: authenticated.sessionCookie ?? '', 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body })
    expect(response.status).toBe(200)
    expect(observed[0]?.headers['x-oidc-workspace']).toBe('')
    expect(observed[0]?.headers['x-oidc-workbench']).toBe('platform')
    expect(observed[0]?.headers['x-workspace-id']).toBeUndefined()
  })

  it('fails closed on cross-workspace requests and invalid configuration', async () => {
    const { gateway, observed } = await fixture()
    const authenticated = await login(gateway)
    const response = await fetch(`${gateway}/api/mcp`, { method: 'POST', headers: { cookie: authenticated.sessionCookie ?? '', 'content-type': 'application/json', 'x-workspace-id': 'ws_other' }, body: '{}' })
    expect(response.status).toBe(403)
    expect(observed).toHaveLength(0)
    const wrongWorkbench = await fetch(`${gateway}/api/mcp`, { method: 'POST', headers: { cookie: authenticated.sessionCookie ?? '', 'content-type': 'application/json', 'x-workspace-id': 'ws_demo', 'x-ops-workbench': 'workspace' }, body: '{}' })
    expect(wrongWorkbench.status).toBe(403)
    expect(() => createLocalOidcGateway({ uiUpstream: 'https://remote.example', apiUpstream: 'http://127.0.0.1:1', username: 'u', password: 'short', sessionSecret: 'short', oidcSigningSecret: 'short', issuer: 'https://issuer.example', subject: 's', workspaceId: 'w', roles: ['r'] })).toThrow(/loopback/u)
  })
})
