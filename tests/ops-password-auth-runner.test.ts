import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createOpsPasswordProxy } from '../scripts/run-ops-password-e2e.js'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('isolated Ops password authentication runner', () => {
  it('runs the production password-session flow without an identity-signing gateway', () => {
    const source = readFileSync('scripts/run-ops-password-e2e.ts', 'utf8')
    expect(source).toContain("OPS_AUTH_MODE: 'password'")
    expect(source).toContain("VITE_OPS_AUTH_MODE: 'password'")
    expect(source).toContain("VITE_OPS_BUILD_MODE: 'password'")
    expect(source).toContain('createOpsPasswordProxy(')
    expect(source).not.toContain('OIDC_PROXY_SIGNING_SECRET')
    expect(source).not.toContain('createLocalOidcGateway')
    expect(source).not.toContain('VITE_OPS_LOGIN_URL')
  })

  it('starts one password UI and one same-origin gateway for the platform console', () => {
    const source = readFileSync('scripts/run-ops-password-e2e.ts', 'utf8')
    expect(source.match(/'node_modules\/vite\/bin\/vite\.js', 'preview'/gu)).toHaveLength(1)
    expect(source.match(/gateway = createOpsPasswordProxy\(/gu)).toHaveLength(1)
    expect(source).not.toMatch(/workspaceGateway|workspaceUi|OPS_WORKSPACE_BASE_URL/u)
    expect(source).toContain('OPS_TEST_USERNAME: username')
    expect(source).toContain('OPS_TEST_PASSWORD: password')
  })

  it('routes password login through the API and relays the session cookie on later MCP requests', async () => {
    const apiRequests: Array<{ url: string; method: string; cookie?: string; body: string }> = []
    const api = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        apiRequests.push({ url: request.url ?? '', method: request.method ?? '', cookie: request.headers.cookie, body: Buffer.concat(chunks).toString('utf8') })
        if (request.url === '/v1/auth/login') {
          response.setHeader('set-cookie', 'damai_session=fixture-session; Path=/; HttpOnly; SameSite=Lax')
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"data":{"result":{"account":{"accountType":"platform"}}}}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      })
    })
    const ui = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<main>Ops UI</main>') })
    const apiBase = await listen(api)
    const uiBase = await listen(ui)
    const proxy = createOpsPasswordProxy(uiBase, apiBase)
    try {
      const proxyBase = await listen(proxy)
      const login = await fetch(`${proxyBase}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"login":"ops@example.test","password":"fixture"}',
      })
      expect(login.status).toBe(200)
      expect(login.headers.get('set-cookie')).toContain('damai_session=fixture-session')
      const rpc = await fetch(`${proxyBase}/api/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: 'damai_session=fixture-session' }, body: '{"jsonrpc":"2.0","id":1,"method":"ops.session","params":{}}',
      })
      expect(rpc.status).toBe(200)
      const page = await fetch(`${proxyBase}/ops/overview`)
      expect(await page.text()).toContain('Ops UI')
      expect(apiRequests).toEqual([
        { url: '/v1/auth/login', method: 'POST', body: '{"login":"ops@example.test","password":"fixture"}' },
        { url: '/mcp', method: 'POST', cookie: 'damai_session=fixture-session', body: '{"jsonrpc":"2.0","id":1,"method":"ops.session","params":{}}' },
      ])
    } finally {
      await close(proxy)
      await close(ui)
      await close(api)
    }
  })
})
