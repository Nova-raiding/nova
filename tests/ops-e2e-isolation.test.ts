import { mkdirSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { disposeOpsE2eResources, fetchOpsE2eHealth, monitorOpsE2eScanner, opsChildEnvironment, runOpsE2e, validateOpsE2eArguments, validateOpsE2eScannerStartupTimeout } from '../scripts/run-ops-oidc-e2e.js'

const { forbidRuntimeResources } = vi.hoisted(() => ({
  forbidRuntimeResources: vi.fn(() => { throw new Error('OPS_E2E_RESOURCE_CREATION_ATTEMPTED') }),
}))

// If preflight validation ever moves below resource creation, fail safely.
// These tests must never start the actual PG/Redis/scanner/browser fixtures.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, mkdirSync: forbidRuntimeResources }
})
vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, createServer: forbidRuntimeResources }
})
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: forbidRuntimeResources }
})
vi.mock('./isolated-ops-fixture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./isolated-ops-fixture.js')>()
  return { ...actual, createIsolatedOpsFixture: forbidRuntimeResources }
})
vi.mock('./local-oidc-gateway.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./local-oidc-gateway.js')>()
  return { ...actual, createLocalOidcGateway: forbidRuntimeResources }
})
vi.mock('../scripts/customer-delivery-scan-fixture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../scripts/customer-delivery-scan-fixture.js')>()
  return { ...actual, startCustomerDeliveryScanFixture: forbidRuntimeResources }
})

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
    const cleanupBody = source.slice(source.indexOf('const cleanup ='))
    expect(cleanupBody.indexOf('fixture = await fixtureSetup.catch')).toBeLessThan(cleanupBody.indexOf('disposeOpsE2eResources(scanner, fixture)'))
    expect(source).toContain("if (stopping) throw new Error('OPS_E2E_INTERRUPTED_DURING_SETUP')")
  })
  it('retains only OS process needs and explicit generated fixture configuration', () => {
    expect(opsChildEnvironment({ PATH: '/usr/bin', DATABASE_URL: 'private-database', REDIS_URL: 'private-redis', MODEL_RELAY_API_KEY: 'private-model', EXECUTE: 'true', NODE_ENV: 'production', KUBECONFIG: 'private-cluster' }, { NODE_ENV: 'development', DATABASE_URL: 'generated-isolated-url' })).toEqual({ PATH: '/usr/bin', NODE_ENV: 'development', DATABASE_URL: 'generated-isolated-url' })
  })
  it('rejects legacy source-container reuse before any runtime is provisioned', () => {
    expect(() => validateOpsE2eArguments([], { OPS_E2E_SOURCE_CONTAINER: 'existing-api' })).toThrow('OPS_E2E_SHARED_SOURCE_UNSUPPORTED')
    expect(validateOpsE2eArguments([], {})).toEqual(['dogfood/chatgpt-all-functions/ops-jit-isolated.spec.js'])
  })
  it('defaults scanner startup to 120 seconds and accepts explicit bounded decimal milliseconds', () => {
    expect(validateOpsE2eScannerStartupTimeout({})).toBe(120_000)
    for (const value of ['1', '5000', '120000', '120001', '300000']) {
      expect(validateOpsE2eScannerStartupTimeout({ OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: value })).toBe(Number(value))
    }
  })
  it.each(['', ' ', '0', '-1', '300001', '1000000', '1.5', '120000.0', '3e5', '0x493e0', '+300000', '0300000', ' 300000', '300000 ', '300000\n', 'Infinity', 'NaN'])('rejects invalid scanner startup budget %j before any resource creation', async value => {
    expect(() => validateOpsE2eScannerStartupTimeout({ OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: value })).toThrow('OPS_E2E_SCANNER_STARTUP_TIMEOUT_INVALID')
    for (const enabled of ['true', 'false']) {
      await expect(runOpsE2e([], { OPS_E2E_DELIVERY_SCAN: enabled, OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: value })).rejects.toThrow('OPS_E2E_SCANNER_STARTUP_TIMEOUT_INVALID')
    }
    expect(mkdirSync).not.toHaveBeenCalled()
    expect(forbidRuntimeResources).not.toHaveBeenCalled()
  })
  it('passes the preflight budget to the scanner without changing child scan safety policy', () => {
    const body = source.slice(source.indexOf('export async function runOpsE2e('))
    const validation = body.indexOf('validateOpsE2eScannerStartupTimeout(source)')
    expect(validation).toBeGreaterThan(-1)
    for (const firstResource of ['mkdirSync(', 'createIsolatedOpsFixture(', 'freeLoopbackPort(', 'startCustomerDeliveryScanFixture(', 'createLocalOidcGateway(', 'spawn(']) {
      expect(body.indexOf(firstResource)).toBeGreaterThan(validation)
    }
    expect(body).toContain('startupTimeoutMs: scannerStartupTimeoutMs')
    expect(opsChildEnvironment({ OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: '300000' })).toEqual({})
  })
  it.each([['-c', 'other.config.js'], ['--config=other.config.js'], ['.'], ['--pass-with-no-tests'], ['--grep', 'anything'], ['dogfood/chatgpt-all-functions/merchant.spec.js']])('rejects a browser override or unscoped selection: %j', (...args) => {
    expect(() => validateOpsE2eArguments(args, {})).toThrow()
  })
})

describe('Ops acceptance runtime failure and cleanup', () => {
  it('bounds the final health response including its body, not only service startup', async () => {
    vi.useFakeTimers()
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => ({
      ok: true,
      json: () => new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('private response body')), { once: true })),
    }) as Response)
    try {
      const result = expect(fetchOpsE2eHealth('http://127.0.0.1:49123/healthz')).rejects.toThrow('OPS_E2E_HEALTH_CHECK_FAILED')
      await vi.advanceTimersByTimeAsync(2_000)
      await result
      expect(vi.getTimerCount()).toBe(0)
    } finally { request.mockRestore(); vi.useRealTimers() }
  })
  it('rejects non-successful health responses without trusting their body', async () => {
    const json = vi.fn()
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json } as unknown as Response)
    try {
      await expect(fetchOpsE2eHealth('http://127.0.0.1:49123/healthz')).rejects.toThrow('OPS_E2E_HEALTH_CHECK_FAILED')
      expect(json).not.toHaveBeenCalled()
    } finally { request.mockRestore() }
  })
  it('returns the real health payload and clears its timeout', async () => {
    vi.useFakeTimers()
    const payload = { data: { persistence: { mode: 'postgres', ready: true }, redis: { ready: true } } }
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => payload } as Response)
    try {
      await expect(fetchOpsE2eHealth('http://127.0.0.1:49123/healthz')).resolves.toEqual(payload)
      expect(vi.getTimerCount()).toBe(0)
    } finally { request.mockRestore(); vi.useRealTimers() }
  })
  it('still disposes PG/Redis when scanner cleanup throws without leaking native errors', async () => {
    const scanner = { stop: vi.fn().mockRejectedValue(new Error('postgres://private:secret@host')) }
    const fixture = { dispose: vi.fn().mockResolvedValue({ stopped: ['owned-pg', 'owned-redis'], leftRunning: [] }) }
    expect(await disposeOpsE2eResources(scanner, fixture)).toEqual(['OPS_E2E_SCANNER_CLEANUP_FAILED'])
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })
  it('preserves both cleanup failures instead of stopping at the first resource', async () => {
    const scanner = { stop: vi.fn().mockResolvedValue({ stopped: [], leftRunning: [{ id: 'owned-scanner', reason: 'unconfirmed' }] }) }
    const fixture = { dispose: vi.fn().mockRejectedValue(new Error('private environment')) }
    expect(await disposeOpsE2eResources(scanner, fixture)).toEqual(['OPS_E2E_SCANNER_CLEANUP_REQUIRES_REVIEW', 'OPS_E2E_FIXTURE_CLEANUP_FAILED'])
  })
  it('does not perform cleanup for absent resources', async () => {
    expect(await disposeOpsE2eResources()).toEqual([])
  })
  it('interrupts a pending phase as soon as the verified scanner fails', async () => {
    const monitor = monitorOpsE2eScanner({ checkRuntime: vi.fn().mockRejectedValue(new Error('raw daemon/private credential')) })
    await expect(monitor.guard(new Promise(() => {}))).rejects.toThrow('OPS_E2E_SCANNER_RUNTIME_FAILED')
    expect(() => monitor.assertHealthy()).toThrow('OPS_E2E_SCANNER_RUNTIME_FAILED')
    await monitor.stop()
  })
  it('does not treat a fast phase as passed before its first scanner check succeeds', async () => {
    const monitor = monitorOpsE2eScanner({ checkRuntime: vi.fn().mockRejectedValue(new Error('scanner missing')) })
    await expect(monitor.guard(Promise.resolve('too fast'))).rejects.toThrow('OPS_E2E_SCANNER_RUNTIME_FAILED')
    await monitor.stop()
  })
  it('keeps monitoring after readiness and cancels its timer before cleanup', async () => {
    vi.useFakeTimers()
    const checkRuntime = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('scanner missing'))
    const monitor = monitorOpsE2eScanner({ checkRuntime }, 5_000)
    const guarded = expect(monitor.guard(new Promise(() => {}))).rejects.toThrow('OPS_E2E_SCANNER_RUNTIME_FAILED')
    await vi.advanceTimersByTimeAsync(5_000)
    await guarded
    expect(checkRuntime).toHaveBeenCalledTimes(2)
    await monitor.stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
  it('does not schedule further scanner probes after a successful run is stopped', async () => {
    vi.useFakeTimers()
    const checkRuntime = vi.fn().mockResolvedValue(undefined)
    const monitor = monitorOpsE2eScanner({ checkRuntime }, 5_000)
    expect(await monitor.guard(Promise.resolve('observed'))).toBe('observed')
    await monitor.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(checkRuntime).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
