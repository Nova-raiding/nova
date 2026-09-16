import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/probe-chatgpt-oauth-boundary.mjs')
function run(port: number): Promise<{ code: number | null; output: string }> {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', CHATGPT_OAUTH_PROBE_TEST_ORIGIN: `http://127.0.0.1:${port}` },
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('close', code => resolveResult({ code, output }))
  })
}
async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, callback: (port: number) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing local test port')
    await callback(address.port)
  } finally { await new Promise<void>(resolveClosed => server.close(() => resolveClosed())) }
}
function protocolHandler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/oauth/authorize') || req.url === '/oauth/token') {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'invalid_request' }))
  } else { res.writeHead(401); res.end() }
}

describe('ChatGPT OAuth read-only boundary probe', () => {
  it('accepts protocol rejection without a credential and reports its limited scope', async () => {
    await withServer(protocolHandler, async port => {
      const result = await run(port)
      expect(result.code).toBe(0)
      expect(result.output).toContain('negative requests only')
      expect(result.output).not.toContain('invalid.example')
    })
  })
  it('rejects fixture token issuance and unauthenticated tool discovery', async () => {
    await withServer((req, res) => {
      if (req.url === '/oauth/token') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'fixture-secret' })); return }
      if (req.url === '/mcp') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tools: [] })); return }
      protocolHandler(req, res)
    }, async port => {
      const result = await run(port)
      expect(result.code).toBe(1)
      expect(result.output).toContain('invalid_token_grant_not_rejected')
      expect(result.output).toContain('unauthenticated_tools_not_rejected')
      expect(result.output).not.toContain('fixture-secret')
    })
  })
  it('rejects authorization redirects for unregistered clients', async () => {
    await withServer((req, res) => {
      if (req.url?.startsWith('/oauth/authorize')) { res.writeHead(302, { location: 'https://invalid.example/oauth/callback?code=fixture-code' }); res.end(); return }
      protocolHandler(req, res)
    }, async port => {
      const result = await run(port)
      expect(result.code).toBe(1)
      expect(result.output).toContain('unregistered_client_not_rejected')
      expect(result.output).not.toContain('fixture-code')
    })
  })
})
