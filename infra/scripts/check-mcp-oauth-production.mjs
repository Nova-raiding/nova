#!/usr/bin/env node
// Read-only, secret-free OAuth checks. Never print the client registry or URL query.
const requiredOrigin = 'https://yxsona.com'
const mode = process.argv[2]
const errors = []
const fail = code => errors.push(code)

function exactUrl(raw, expected, code) {
  try {
    const url = new URL(raw)
    if (url.href !== expected || url.username || url.password || url.search || url.hash) fail(code)
  } catch { fail(code) }
}

function checkConfig(env) {
  const integrationMode = env.MCP_INTEGRATION_MODE
  if (integrationMode === 'local_stdio') {
    if (env.MCP_OAUTH_REQUIRED !== 'false') fail('local_stdio_oauth_required_must_be_false')
    for (const key of ['MCP_OAUTH_CLIENTS', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_AUTHORIZATION_ENDPOINT', 'MCP_OAUTH_TOKEN_ENDPOINT', 'OPENAI_APPS_CHALLENGE_TOKEN']) {
      if (env[key]?.trim()) fail(`local_stdio_${key.toLowerCase()}_must_be_empty`)
    }
    exactUrl(env.PUBLIC_APP_BASE_URL ?? '', requiredOrigin + '/', 'public_origin_invalid')
    return
  }
  if (integrationMode !== 'remote_oauth') { fail('integration_mode_missing_or_invalid'); return }
  if (env.MCP_OAUTH_REQUIRED !== 'true') fail('oauth_required_disabled')
  const challenge = env.OPENAI_APPS_CHALLENGE_TOKEN?.trim() ?? ''
  if (!challenge || /fixture|example|placeholder|<|>/iu.test(challenge)) fail('openai_apps_challenge_missing_or_placeholder')
  exactUrl(env.PUBLIC_APP_BASE_URL ?? '', requiredOrigin + '/', 'public_origin_invalid')
  exactUrl(env.MCP_OAUTH_ISSUER ?? '', requiredOrigin + '/', 'issuer_invalid')
  exactUrl(env.MCP_OAUTH_AUTHORIZATION_ENDPOINT ?? '', requiredOrigin + '/oauth/authorize', 'authorization_endpoint_invalid')
  exactUrl(env.MCP_OAUTH_TOKEN_ENDPOINT ?? '', requiredOrigin + '/oauth/token', 'token_endpoint_invalid')
  let registry
  try { registry = JSON.parse(env.MCP_OAUTH_CLIENTS ?? '') } catch { fail('client_registry_missing_or_invalid'); return }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || !Object.keys(registry).length) { fail('client_registry_missing_or_invalid'); return }
  for (const [id, redirects] of Object.entries(registry)) {
    if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(id) || /fixture|example|placeholder|<|>/iu.test(id)) fail('client_id_invalid_or_placeholder')
    if (!Array.isArray(redirects) || !redirects.length || redirects.some(uri => typeof uri !== 'string')) { fail('client_redirects_invalid'); continue }
    if (new Set(redirects).size !== redirects.length) fail('client_redirect_duplicate')
    for (const uri of redirects) {
      try {
        const url = new URL(uri)
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || uri !== url.href || /fixture|example|placeholder|<|>/iu.test(uri)) fail('client_redirect_invalid_or_placeholder')
      } catch { fail('client_redirect_invalid_or_placeholder') }
    }
  }
}

async function getJson(path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(requiredOrigin + path, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } })
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('application/json')) { fail('discovery_http_invalid'); return null }
    return await response.json()
  } catch { fail('discovery_unavailable'); return null } finally { clearTimeout(timer) }
}

async function checkSmoke() {
  const resource = await getJson('/.well-known/oauth-protected-resource')
  const server = await getJson('/.well-known/oauth-authorization-server')
  if (resource && (resource.resource !== requiredOrigin + '/mcp' || JSON.stringify(resource.authorization_servers) !== JSON.stringify([requiredOrigin]))) fail('resource_metadata_invalid')
  if (server && (server.issuer !== requiredOrigin || server.authorization_endpoint !== requiredOrigin + '/oauth/authorize' || server.token_endpoint !== requiredOrigin + '/oauth/token' || !server.token_endpoint_auth_methods_supported?.includes('none') || !server.code_challenge_methods_supported?.includes('S256'))) fail('authorization_metadata_invalid')
}

if (mode === '--config') checkConfig(process.env)
else if (mode === '--smoke') await checkSmoke()
else { process.stderr.write('usage: check-mcp-oauth-production.mjs --config|--smoke\n'); process.exit(2) }
if (errors.length) { process.stderr.write(`MCP OAuth ${mode} blocked: ${[...new Set(errors)].join(', ')}\n`); process.exit(1) }
process.stdout.write(`MCP integration ${mode} passed for ${process.env.MCP_INTEGRATION_MODE ?? 'unknown'} mode\n`)
