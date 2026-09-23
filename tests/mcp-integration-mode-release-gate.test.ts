import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const checker = resolve('infra/scripts/check-mcp-oauth-production.mjs')
const remote = {
  MCP_INTEGRATION_MODE: 'remote_oauth',
  MCP_OAUTH_REQUIRED: 'true',
  PUBLIC_APP_BASE_URL: 'https://yxsona.com',
  MCP_OAUTH_ISSUER: 'https://yxsona.com',
  MCP_OAUTH_AUTHORIZATION_ENDPOINT: 'https://yxsona.com/oauth/authorize',
  MCP_OAUTH_TOKEN_ENDPOINT: 'https://yxsona.com/oauth/token',
  MCP_OAUTH_CLIENTS: JSON.stringify({ production_client: ['https://chatgpt.com/connector/oauth/callback/release-gate'] }),
  OPENAI_APPS_CHALLENGE_TOKEN: 'production-domain-challenge-token',
}

function check(env: Record<string, string>) {
  return spawnSync(process.execPath, [checker, '--config'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })
}

describe('MCP integration-mode release gate', () => {
  it('accepts the isolated local_stdio profile', () => {
    const result = check({
      MCP_INTEGRATION_MODE: 'local_stdio',
      MCP_OAUTH_REQUIRED: 'false',
      PUBLIC_APP_BASE_URL: 'https://yxsona.com',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('local_stdio mode')
  })

  it('accepts the complete remote_oauth profile', () => {
    const result = check(remote)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('remote_oauth mode')
  })

  it('rejects every cross-mode configuration', () => {
    const localWithRemoteRegistration = check({
      ...remote,
      MCP_INTEGRATION_MODE: 'local_stdio',
      MCP_OAUTH_REQUIRED: 'false',
    })
    expect(localWithRemoteRegistration.status).toBe(1)
    expect(localWithRemoteRegistration.stderr).toContain('local_stdio_')

    const remoteWithoutOAuth = check({
      MCP_INTEGRATION_MODE: 'remote_oauth',
      MCP_OAUTH_REQUIRED: 'false',
      PUBLIC_APP_BASE_URL: 'https://yxsona.com',
    })
    expect(remoteWithoutOAuth.status).toBe(1)
    expect(remoteWithoutOAuth.stderr).toContain('oauth_required_disabled')
    expect(remoteWithoutOAuth.stderr).toContain('client_registry_missing_or_invalid')
  })

  it('requires ECS production deploy preflight to enforce the adopted local_stdio mode', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight-ecs.sh', 'utf8')
    expect(preflight).toContain(': "${MCP_INTEGRATION_MODE:?MCP_INTEGRATION_MODE is required}"')
    expect(preflight).toContain('local_stdio) ;;')
    expect(preflight).toContain('ECS production deploy requires MCP_INTEGRATION_MODE=local_stdio')
    expect(preflight).not.toContain('local_stdio|remote_oauth')
    expect(preflight).toContain('node infra/scripts/check-mcp-oauth-production.mjs --config')
    expect(preflight.indexOf('MCP_INTEGRATION_MODE is required')).toBeLessThan(
      preflight.indexOf('check-mcp-oauth-production.mjs --config'),
    )
  })

  it('keeps the desktop release contract local and documents remote OAuth as optional', () => {
    const adr = readFileSync('docs/architecture/desktop-only-auth-adr.md', 'utf8')
    const installer = readFileSync('apps/plugin/scripts/install-local-macos.sh', 'utf8')
    const compose = readFileSync('infra/local/docker-compose.ecs-pilot.yml', 'utf8')

    expect(adr).toContain('MCP_INTEGRATION_MODE=local_stdio')
    expect(adr).toContain('MCP_OAUTH_REQUIRED=false')
    expect(adr).toContain('remote_mcp')
    expect(adr).toMatch(/不.*ChatGPT.*OAuth/u)
    expect(installer).toMatch(/不使用 ChatGPT OAuth/u)
    expect(compose).toContain('MCP_INTEGRATION_MODE: local_stdio')
    expect(compose).toContain('MCP_OAUTH_REQUIRED: "false"')
  })

  it('never prints client registration or challenge values on failure', () => {
    const secretClient = 'sensitive-client-id'
    const secretChallenge = 'sensitive-domain-challenge'
    const result = check({
      ...remote,
      MCP_OAUTH_CLIENTS: JSON.stringify({ [secretClient]: ['http://chatgpt.com/callback'] }),
      OPENAI_APPS_CHALLENGE_TOKEN: secretChallenge,
    })
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain(secretClient)
    expect(result.stdout + result.stderr).not.toContain(secretChallenge)
  })
})
