#!/usr/bin/env node
// Read-only production boundary probe. It never sends credentials or follows redirects.
const productionOrigin = 'https://yxsona.com'
const origin = process.env.NODE_ENV === 'test' && process.env.CHATGPT_OAUTH_PROBE_TEST_ORIGIN
  ? process.env.CHATGPT_OAUTH_PROBE_TEST_ORIGIN : productionOrigin
if (origin !== productionOrigin && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(origin)) {
  process.stderr.write('ChatGPT OAuth probe blocked: test_origin_invalid\n'); process.exit(2)
}
const failures = []
async function request(path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    return await fetch(origin + path, { ...options, signal: controller.signal, redirect: 'manual', headers: { accept: 'application/json', ...options.headers } })
  } catch { failures.push('endpoint_unavailable'); return null }
  finally { clearTimeout(timer) }
}
async function expectProtocolError(path, options, code) {
  const response = await request(path, options)
  if (!response) return
  if (response.status !== 400 || !(response.headers.get('content-type') ?? '').includes('application/json')) { failures.push(code); return }
  try {
    const body = await response.json()
    if (body?.error !== 'invalid_request' || 'access_token' in body || 'code' in body) failures.push(code)
  } catch { failures.push(code) }
}
// A well-formed PKCE request with an unregistered client/callback must be rejected
// before any login page or redirect is presented.
const authorization = new URLSearchParams({
  response_type: 'code', client_id: 'unregistered_probe_client',
  redirect_uri: 'https://invalid.example/oauth/callback', state: 'probe-state',
  code_challenge: 'A'.repeat(43), code_challenge_method: 'S256',
  scope: 'merchant', resource: productionOrigin + '/mcp',
})
await expectProtocolError('/oauth/authorize?' + authorization, {}, 'unregistered_client_not_rejected')
// Empty token grant catches a fixture endpoint that would mint a demo bearer.
await expectProtocolError('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' }, 'invalid_token_grant_not_rejected')
// Tool discovery must require a bearer. The real ChatGPT session remains a
// separate browser acceptance step; this request intentionally has none.
const mcp = await request('/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
})
if (mcp && mcp.status !== 401) failures.push('unauthenticated_tools_not_rejected')
if (failures.length) {
  process.stderr.write(`ChatGPT OAuth boundary probe blocked: ${[...new Set(failures)].join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('ChatGPT OAuth boundary probe passed (negative requests only; real ChatGPT login and tool discovery still required)\n')
