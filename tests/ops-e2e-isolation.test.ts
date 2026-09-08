import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { opsChildEnvironment, validateOpsE2eArguments } from '../scripts/run-ops-oidc-e2e.js'

describe('Ops browser acceptance isolation', () => {
  const source = readFileSync('scripts/run-ops-oidc-e2e.ts', 'utf8')
  it('provisions its own persistence instead of copying a running business service', () => {
    expect(source).toContain('createIsolatedOpsFixture')
    expect(source).not.toContain('inspected.Config.Env')
    expect(source).not.toContain("label=com.docker.compose.service=api")
    expect(source).not.toContain('hostUrl(serviceEnv.')
  })
  it('does not spread ambient business credentials into child services', () => {
    expect(source).toContain('opsChildEnvironment')
    expect(source).not.toContain('...process.env')
    expect(source).toContain('fixture.dispose()')
  })
  it('binds the real API to loopback and supplies the session hash secret', () => {
    expect(source).toContain("API_BIND_HOST: '127.0.0.1'")
    expect(source).toContain('SESSION_ID_HASH_SECRET: randomBytes')
    expect(readFileSync('apps/api/src/server.ts', 'utf8')).toContain('server.listen(port, process.env.API_BIND_HOST,')
  })
  it('waits for in-flight fixture provisioning before signal cleanup', () => {
    expect(source).toContain('fixture = await fixtureSetup.catch(() => undefined)')
    expect(source.indexOf('fixture = await fixtureSetup.catch')).toBeLessThan(source.indexOf('fixture.dispose()'))
    expect(source).toContain("if (stopping) throw new Error('OPS_E2E_INTERRUPTED_DURING_SETUP')")
  })
  it('retains only OS process needs and explicit generated fixture configuration', () => {
    expect(opsChildEnvironment({ PATH: '/usr/bin', DATABASE_URL: 'private-database', REDIS_URL: 'private-redis', MODEL_RELAY_API_KEY: 'private-model', EXECUTE: 'true', NODE_ENV: 'production', KUBECONFIG: 'private-cluster' }, { NODE_ENV: 'development', DATABASE_URL: 'generated-isolated-url' })).toEqual({ PATH: '/usr/bin', NODE_ENV: 'development', DATABASE_URL: 'generated-isolated-url' })
  })
  it('rejects legacy source-container reuse before any runtime is provisioned', () => {
    expect(() => validateOpsE2eArguments([], { OPS_E2E_SOURCE_CONTAINER: 'existing-api' })).toThrow('OPS_E2E_SHARED_SOURCE_UNSUPPORTED')
    expect(validateOpsE2eArguments([], {})).toEqual(['dogfood/chatgpt-all-functions/ops-jit-isolated.spec.js'])
  })
  it.each([['-c', 'other.config.js'], ['--config=other.config.js'], ['.'], ['--pass-with-no-tests'], ['--grep', 'anything'], ['dogfood/chatgpt-all-functions/merchant.spec.js']])('rejects a browser override or unscoped selection: %j', (...args) => {
    expect(() => validateOpsE2eArguments(args, {})).toThrow()
  })
})
