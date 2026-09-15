import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const required = ['JD_APP_KEY', 'JD_APP_SECRET', 'JD_OAUTH_AUTHORIZE_URL', 'JD_OAUTH_TOKEN_URL', 'JD_OAUTH_REDIRECT_URI', 'JD_API_BASE_URL', 'VAULT_ADDR', 'VAULT_TOKEN']
const config = () => ({
  JD_APP_KEY: 'test-key', JD_APP_SECRET: 'test-secret',
  JD_OAUTH_AUTHORIZE_URL: 'https://open-oauth.jd.com/oauth/authorize',
  JD_OAUTH_TOKEN_URL: 'https://open-oauth.jd.com/oauth/token',
  JD_OAUTH_REDIRECT_URI: 'https://merchant.example.test/v1/oauth/callback/jd',
  JD_API_BASE_URL: 'https://api.jd.com/routerjson',
  VAULT_ADDR: 'https://vault.example.test', VAULT_TOKEN: 'test-vault-token',
})
function render(settings: Record<string, string>) {
  const env = { ...process.env }
  for (const key of required) delete env[key]
  return spawnSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'infra/local/docker-compose.yml', '-f', 'infra/local/docker-compose.jd-oauth.yml', 'config', '--format', 'json'], { env: { ...env, ...settings }, encoding: 'utf8' })
}
describe('JD real authorization deployment configuration', () => {
  it.each(required)('rejects missing %s rather than falling back to fixture', name => {
    const settings: Record<string, string> = config()
    delete settings[name]
    const result = render(settings)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(name)
    expect(result.stderr).not.toContain('test-secret')
    expect(result.stderr).not.toContain('test-vault-token')
  })
  it('configures both API instances identically and never enables publishing', () => {
    const result = render(config())
    expect(result.status).toBe(0)
    const services = JSON.parse(result.stdout).services
    for (const service of ['api', 'api-replica']) {
      expect(services[service].environment).toMatchObject({
        ...config(), CONNECTOR_FIXTURE_MODE: 'false', PLUGIN_WRITE_ENABLED: 'false',
        JD_AUTH_ENABLED: 'true', JD_READ_ENABLED: 'false', JD_WRITE_ENABLED: 'false',
        JD_CREATE_PATH: '', JD_UPDATE_PATH: '', JD_QUERY_PATH: '',
      })
    }
  })
})
