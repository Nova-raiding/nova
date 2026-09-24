import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/check-mcp-integration-production.mjs')
const base = {
  MCP_INTEGRATION_MODE: 'local_stdio',
  PUBLIC_APP_BASE_URL: 'https://yxsona.com',
  MCP_OAUTH_REQUIRED: '',
  MCP_OAUTH_ISSUER: '',
  MCP_OAUTH_AUTHORIZATION_ENDPOINT: '',
  MCP_OAUTH_TOKEN_ENDPOINT: '',
  MCP_OAUTH_CLIENTS: '',
  OPENAI_APPS_CHALLENGE_TOKEN: '',
  OIDC_PROXY_SIGNING_SECRET: '',
}
function run(changes: Record<string, string>) {
  return spawnSync(process.execPath, [script, '--config'], { env: { PATH: process.env.PATH ?? '', ...base, ...changes }, encoding: 'utf8' })
}

const retiredKeys = [
  'MCP_OAUTH_CLIENTS',
  'MCP_OAUTH_ISSUER',
  'MCP_OAUTH_AUTHORIZATION_ENDPOINT',
  'MCP_OAUTH_TOKEN_ENDPOINT',
  'OPENAI_APPS_CHALLENGE_TOKEN',
  'OIDC_PROXY_SIGNING_SECRET',
] as const

function local(changes: Record<string, string> = {}) {
  return run({
    ...Object.fromEntries(retiredKeys.map(key => [key, ''])),
    MCP_INTEGRATION_MODE: 'local_stdio',
    PUBLIC_APP_BASE_URL: 'https://yxsona.com',
    ...changes,
  })
}

describe('MCP local stdio production configuration preflight', () => {
  it('accepts local stdio only when all retired ChatGPT OAuth settings are absent', () => {
    expect(local().status).toBe(0)
    for (const key of retiredKeys) {
      const contaminated = local({ [key]: 'configured-secret-value' })
      expect(contaminated.status, key).toBe(1)
      expect(contaminated.stderr).toContain(`retired_external_auth_setting_${key.toLowerCase()}_must_be_empty`)
      expect(contaminated.stdout + contaminated.stderr).not.toContain('configured-secret-value')
    }
  })
  it('fails closed for a missing, misspelled, or padded integration mode', () => {
    for (const mode of ['', 'LOCAL_STDIO', 'local-stdio', ' local_stdio ']) {
      const result = run({ MCP_INTEGRATION_MODE: mode })
      expect(result.status, JSON.stringify(mode)).toBe(1)
      expect(result.stderr).toContain('integration_mode_must_be_local_stdio')
    }
  })
})
