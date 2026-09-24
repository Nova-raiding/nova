import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const checker = resolve('infra/scripts/check-mcp-integration-production.mjs')
const localProfile = {
  MCP_INTEGRATION_MODE: 'local_stdio',
  PUBLIC_APP_BASE_URL: 'https://yxsona.com',
}

function check(env: Record<string, string>) {
  return spawnSync(process.execPath, [checker, '--config'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })
}

describe('MCP local stdio release gate', () => {
  it('accepts the supported local_stdio production profile', () => {
    const result = check(localProfile)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('local_stdio mode')
  })

  it('rejects missing, misspelled, padded, and retired remote modes', () => {
    for (const mode of ['', 'LOCAL_STDIO', 'local-stdio', ' local_stdio ', 'remote_oauth']) {
      const result = check({ ...localProfile, MCP_INTEGRATION_MODE: mode })
      expect(result.status, JSON.stringify(mode)).toBe(1)
      expect(result.stderr).toContain('integration_mode_must_be_local_stdio')
    }
  })

  it('rejects every retired external authentication setting without echoing values', () => {
    for (const key of ['MCP_OAUTH_REQUIRED', 'MCP_OAUTH_CLIENTS', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_AUTHORIZATION_ENDPOINT', 'MCP_OAUTH_TOKEN_ENDPOINT', 'OPENAI_APPS_CHALLENGE_TOKEN', 'OIDC_PROXY_SIGNING_SECRET']) {
      const secret = 'sensitive-retired-setting-value'
      const result = check({ ...localProfile, [key]: secret })
      expect(result.status, key).toBe(1)
      expect(result.stderr).toContain(`retired_external_auth_setting_${key.toLowerCase()}_must_be_empty`)
      expect(result.stdout + result.stderr).not.toContain(secret)
    }
  })

  it('keeps the ECS deploy preflight aligned with local_stdio only', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight-ecs.sh', 'utf8')
    expect(preflight).toContain(': "${MCP_INTEGRATION_MODE:?MCP_INTEGRATION_MODE is required}"')
    expect(preflight).toContain('local_stdio) ;;')
    expect(preflight).toContain('ECS production deploy requires MCP_INTEGRATION_MODE=local_stdio')
    expect(preflight).not.toContain('local_stdio|remote_oauth')
    expect(preflight).toContain('node infra/scripts/check-mcp-integration-production.mjs --config')
  })

  it('keeps the desktop release docs and Compose profile aligned', () => {
    const adr = readFileSync('docs/architecture/desktop-only-auth-adr.md', 'utf8')
    const installer = readFileSync('apps/plugin/scripts/install-local-macos.sh', 'utf8')
    const compose = readFileSync('infra/local/docker-compose.ecs-pilot.yml', 'utf8')
    expect(adr).toContain('MCP_INTEGRATION_MODE=local_stdio')
    expect(adr).toMatch(/不.*ChatGPT.*OAuth/u)
    expect(installer).toMatch(/不使用 ChatGPT OAuth/u)
    expect(compose).toContain('MCP_INTEGRATION_MODE: local_stdio')
    expect(compose).not.toContain('MCP_OAUTH_REQUIRED:')
  })
})
