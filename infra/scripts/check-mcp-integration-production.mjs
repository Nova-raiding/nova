#!/usr/bin/env node
// Read-only production boundary check for the supported local stdio profile.
// Retired remote plugin-auth and external identity settings are rejected and never printed.
const mode = process.argv[2]
const errors = []
const fail = code => errors.push(code)
const retiredKeys = [
  'MCP_OAUTH_REQUIRED',
  'MCP_OAUTH_CLIENTS',
  'MCP_OAUTH_ISSUER',
  'MCP_OAUTH_AUTHORIZATION_ENDPOINT',
  'MCP_OAUTH_TOKEN_ENDPOINT',
  'OPENAI_APPS_CHALLENGE_TOKEN',
  'OIDC_PROXY_SIGNING_SECRET',
]

function checkConfig(env) {
  if (env.MCP_INTEGRATION_MODE !== 'local_stdio') fail('integration_mode_must_be_local_stdio')
  for (const key of retiredKeys) if (env[key]?.trim()) fail(`retired_external_auth_setting_${key.toLowerCase()}_must_be_empty`)
  try {
    const url = new URL(env.PUBLIC_APP_BASE_URL ?? '')
    if (url.href !== 'https://yxsona.com/' || url.username || url.password || url.search || url.hash) fail('public_origin_invalid')
  } catch { fail('public_origin_invalid') }
}

if (mode !== '--config') {
  process.stderr.write('usage: check-mcp-integration-production.mjs --config\n')
  process.exit(2)
}
checkConfig(process.env)
if (errors.length) {
  process.stderr.write(`MCP local stdio ${mode} blocked: ${[...new Set(errors)].join(', ')}\n`)
  process.exit(1)
}
process.stdout.write('MCP integration --config passed for local_stdio mode\n')
