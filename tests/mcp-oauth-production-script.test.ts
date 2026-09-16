import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/check-mcp-oauth-production.mjs')
const base = {
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

describe('MCP OAuth production configuration preflight', () => {
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
  it('fails closed when the OpenAI Apps domain challenge is missing or a placeholder', () => {
    for (const challenge of ['', 'placeholder-token']) {
      const result = run({ OPENAI_APPS_CHALLENGE_TOKEN: challenge })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('openai_apps_challenge_missing_or_placeholder')
    }
  })
})
