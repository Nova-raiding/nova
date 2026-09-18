import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/check-mcp-oauth-production.mjs')
const base = {
  MCP_INTEGRATION_MODE: 'remote_oauth',
  MCP_OAUTH_REQUIRED: 'true',
  PUBLIC_APP_BASE_URL: 'https://yxsona.com',
  MCP_OAUTH_ISSUER: 'https://yxsona.com',
  MCP_OAUTH_AUTHORIZATION_ENDPOINT: 'https://yxsona.com/oauth/authorize',
  MCP_OAUTH_TOKEN_ENDPOINT: 'https://yxsona.com/oauth/token',
  MCP_OAUTH_CLIENTS: JSON.stringify({ real_client_1: ['https://chatgpt.com/connector/oauth/callback/abc123'] }),
  OPENAI_APPS_CHALLENGE_TOKEN: 'openai-domain-token-production-123',
}
function run(changes: Record<string, string>) {
  return spawnSync(process.execPath, [script, '--config'], { env: { PATH: process.env.PATH ?? '', ...base, ...changes }, encoding: 'utf8' })
}

const remoteOnlyKeys = [
  'MCP_OAUTH_CLIENTS',
  'MCP_OAUTH_ISSUER',
  'MCP_OAUTH_AUTHORIZATION_ENDPOINT',
  'MCP_OAUTH_TOKEN_ENDPOINT',
  'OPENAI_APPS_CHALLENGE_TOKEN',
] as const

function local(changes: Record<string, string> = {}) {
  return run({
    ...Object.fromEntries(remoteOnlyKeys.map(key => [key, ''])),
    MCP_INTEGRATION_MODE: 'local_stdio',
    MCP_OAUTH_REQUIRED: 'false',
    PUBLIC_APP_BASE_URL: 'https://yxsona.com',
    ...changes,
  })
}

describe('MCP OAuth production configuration preflight', () => {
  it('accepts local stdio only when all remote OAuth registration is absent', () => {
    expect(local().status).toBe(0)
    for (const key of remoteOnlyKeys) {
      const contaminated = local({ [key]: 'configured-secret-value' })
      expect(contaminated.status, key).toBe(1)
      expect(contaminated.stderr).toContain(`local_stdio_${key.toLowerCase()}_must_be_empty`)
      expect(contaminated.stdout + contaminated.stderr).not.toContain('configured-secret-value')
    }
    expect(local({ MCP_OAUTH_REQUIRED: 'true' }).stderr).toContain('local_stdio_oauth_required_must_be_false')
  })
  it('fails closed for a missing, misspelled, or padded integration mode', () => {
    for (const mode of ['', 'LOCAL_STDIO', 'local-stdio', ' local_stdio ']) {
      const result = run({ MCP_INTEGRATION_MODE: mode })
      expect(result.status, JSON.stringify(mode)).toBe(1)
      expect(result.stderr).toContain('integration_mode_missing_or_invalid')
    }
  })
  it('accepts a real-shaped exact HTTPS callback allowlist without printing it', () => {
    const result = run({})
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('real_client_1')
    expect(result.stdout + result.stderr).not.toContain('abc123')
  })
  it('fails closed for missing, placeholder, and non-HTTPS registrations', () => {
    for (const clients of ['', '{"fixture-client":["https://example.com/callback"]}', '{"real_client_1":["http://chatgpt.com/callback"]}']) {
      const result = run({ MCP_OAUTH_CLIENTS: clients })
      expect(result.status).toBe(1)
      if (clients) expect(result.stdout + result.stderr).not.toContain(clients)
    }
  })
  it('rejects disabled OAuth and wrong self-hosted endpoints', () => {
    const result = run({ MCP_OAUTH_REQUIRED: 'false', MCP_OAUTH_TOKEN_ENDPOINT: 'https://other.example/token' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('oauth_required_disabled')
    expect(result.stderr).toContain('token_endpoint_invalid')
  })
  it('requires every remote OAuth endpoint explicitly', () => {
    for (const key of ['PUBLIC_APP_BASE_URL', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_AUTHORIZATION_ENDPOINT', 'MCP_OAUTH_TOKEN_ENDPOINT']) {
      const result = run({ [key]: '' })
      expect(result.status, key).toBe(1)
    }
  })
  it('fails closed when the OpenAI Apps domain challenge is missing or a placeholder', () => {
    for (const challenge of ['', 'placeholder-token']) {
      const result = run({ OPENAI_APPS_CHALLENGE_TOKEN: challenge })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('openai_apps_challenge_missing_or_placeholder')
    }
  })
})
