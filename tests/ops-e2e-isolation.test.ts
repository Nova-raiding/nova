import { mkdirSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createOpsPasswordProxy, disposeOpsE2eResources, fetchOpsE2eHealth, isolatedManualOperationsMode, monitorOpsE2eScanner, opsChildEnvironment, opsE2eFailureReport, opsE2eScanPurpose, productImportPointGrantInput, productImportSyntheticSku, runOpsE2e, validateOpsE2eArguments, validateOpsE2eBrowserTimeout, validateOpsE2eScannerStartupTimeout, validateOpsE2eSpecIsolation } from '../scripts/run-ops-password-e2e.js'

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
vi.mock('../scripts/customer-delivery-scan-fixture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../scripts/customer-delivery-scan-fixture.js')>()
  return { ...actual, startCustomerDeliveryScanFixture: forbidRuntimeResources }
})

describe('Ops browser acceptance isolation', () => {
  const source = readFileSync('scripts/run-ops-password-e2e.ts', 'utf8')
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
    expect(source).toContain('SESSION_ID_HASH_SECRET: sessionHashSecret')
    expect(source).toContain("const sessionHashSecret = randomBytes(32).toString('hex')")
    expect(readFileSync('apps/api/src/server.ts', 'utf8')).toContain('server.listen(port, process.env.API_BIND_HOST,')
  })
  it('preserves the browser Host for same-origin merchant CSRF while rejecting a forged Origin', async () => {
    const ui = createServer((_request, response) => { response.writeHead(200); response.end('ui') })
    const api = createServer((request, response) => {
      const origin = request.headers.origin
      const host = request.headers.host
      response.writeHead(origin === `http://${host}` ? 200 : 403)
      response.end()
    })
    const listen = async (server: ReturnType<typeof createServer>) => {
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing test port')
      return `http://127.0.0.1:${address.port}`
    }
    let proxy: ReturnType<typeof createOpsPasswordProxy> | undefined
    try {
      const uiUrl = await listen(ui), apiUrl = await listen(api)
      proxy = createOpsPasswordProxy(uiUrl, apiUrl)
      const publicUrl = await listen(proxy)
      const status = (origin: string) => new Promise<number>((done, reject) => {
        const request = httpRequest(`${publicUrl}/api/v1/auth/mcp-token`, { method: 'POST', agent: false, headers: { origin } }, response => {
          response.resume()
          response.once('end', () => done(response.statusCode ?? 0))
        })
        request.once('error', reject)
        request.end()
      })
      expect(await status(publicUrl)).toBe(200)
      expect(await status('http://evil.example')).toBe(403)
    } finally {
      await Promise.all([proxy, ui, api].filter(Boolean).map(server => new Promise<void>(done => server!.close(() => done()))))
    }
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
  it('enables manual store operations only for an explicit isolated fixture flag', async () => {
    expect(isolatedManualOperationsMode({})).toBe(false)
    expect(isolatedManualOperationsMode({ OPS_E2E_MANUAL_OPERATIONS: 'true' })).toBe(true)
    for (const value of ['false', '1', 'TRUE', '']) {
      expect(() => isolatedManualOperationsMode({ OPS_E2E_MANUAL_OPERATIONS: value })).toThrow('OPS_E2E_MANUAL_OPERATIONS_INVALID')
      await expect(runOpsE2e([], { OPS_E2E_MANUAL_OPERATIONS: value })).rejects.toThrow('OPS_E2E_MANUAL_OPERATIONS_INVALID')
    }
    expect(forbidRuntimeResources).not.toHaveBeenCalled()
  })
  it('requires the manual import browser spec to run alone with isolated manual mode', async () => {
    const spec = 'dogfood/chatgpt-all-functions/ops-manual-import-isolated.spec.js'
    const other = 'dogfood/chatgpt-all-functions/ops-users.spec.js'
    expect(validateOpsE2eArguments([spec], { OPS_E2E_MANUAL_OPERATIONS: 'true' })).toEqual([spec])
    await expect(runOpsE2e([spec], { OPS_E2E_MANUAL_OPERATIONS: 'false' })).rejects.toThrow('OPS_E2E_MANUAL_OPERATIONS_INVALID')
    expect(validateOpsE2eSpecIsolation([spec], true)).toBe('hyp@sn.com')
    expect(validateOpsE2eSpecIsolation([other], false)).toBeUndefined()
    await expect(runOpsE2e([spec], {})).rejects.toThrow('OPS_E2E_MANUAL_IMPORT_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
    await expect(runOpsE2e([spec, other], { OPS_E2E_MANUAL_OPERATIONS: 'true' })).rejects.toThrow('OPS_E2E_MANUAL_IMPORT_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
    await expect(runOpsE2e(['dogfood/chatgpt-all-functions/ops-delivery-readonly-isolated.spec.js', other], {})).rejects.toThrow('OPS_E2E_DELIVERY_READONLY_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
    expect(forbidRuntimeResources).not.toHaveBeenCalled()
  })
  it('requires public rule upload to use its dedicated isolated fixture and designated admin', async () => {
    const spec = 'dogfood/chatgpt-all-functions/ops-public-rule-upload-isolated.spec.js'
    const other = 'dogfood/chatgpt-all-functions/ops-users.spec.js'
    expect(validateOpsE2eSpecIsolation([spec], false)).toBe('hyp@sn.com')
    await expect(runOpsE2e([spec, other], {})).rejects.toThrow('OPS_E2E_PUBLIC_RULE_UPLOAD_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
    expect(forbidRuntimeResources).not.toHaveBeenCalled()
  })
  it('requires the unmatched receipt read-only browser spec to use its dedicated isolated fixture', async () => {
    const spec = 'dogfood/chatgpt-all-functions/ops-unmatched-receipt-readonly-isolated.spec.js'
    const other = 'dogfood/chatgpt-all-functions/ops-users.spec.js'
    expect(validateOpsE2eArguments([spec], {})).toEqual([spec])
    expect(validateOpsE2eSpecIsolation([spec], false)).toBeUndefined()
    await expect(runOpsE2e([spec, other], {})).rejects.toThrow('OPS_E2E_UNMATCHED_RECEIPT_READONLY_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
    expect(forbidRuntimeResources).not.toHaveBeenCalled()
  })
  it('defaults scanner startup to 120 seconds and accepts explicit bounded decimal milliseconds', () => {
    expect(validateOpsE2eScannerStartupTimeout({})).toBe(120_000)
    for (const value of ['1', '5000', '120000', '120001', '300000']) {
      expect(validateOpsE2eScannerStartupTimeout({ OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: value })).toBe(Number(value))
    }
  })
  it('bounds browser lifetime before provisioning an isolated fixture', async () => {
    expect(validateOpsE2eBrowserTimeout({})).toBe(300_000)
    expect(validateOpsE2eBrowserTimeout({ OPS_E2E_BROWSER_TIMEOUT_MS: '600000' })).toBe(600_000)
    for (const value of ['0', '9999', '600001', '1.5', ' 300000', '300000 ', '1e5', 'Infinity', 'NaN']) {
      expect(() => validateOpsE2eBrowserTimeout({ OPS_E2E_BROWSER_TIMEOUT_MS: value })).toThrow('OPS_E2E_BROWSER_TIMEOUT_INVALID')
    }
    await expect(runOpsE2e([], { OPS_E2E_BROWSER_TIMEOUT_MS: '9999' })).rejects.toThrow('OPS_E2E_BROWSER_TIMEOUT_INVALID')
  })
  it('keeps customer-delivery scanning as the default and isolates product-import evidence', async () => {
    const product = 'dogfood/chatgpt-all-functions/ops-product-import-scan-isolated.spec.js'
    const delivery = 'dogfood/chatgpt-all-functions/ops-delivery-readonly-isolated.spec.js'
    expect(opsE2eScanPurpose([delivery], { OPS_E2E_DELIVERY_SCAN: 'true' })).toBe('customer_delivery')
    expect(opsE2eScanPurpose([product], { OPS_E2E_DELIVERY_SCAN: 'true', OPS_E2E_SCAN_PURPOSE: 'product_import' })).toBe('product_import')
    await expect(runOpsE2e([product], { OPS_E2E_SCAN_PURPOSE: 'product_import' })).rejects.toThrow('OPS_E2E_PRODUCT_IMPORT_REQUIRES_DEDICATED_SCANNER_FIXTURE')
    await expect(runOpsE2e([delivery], { OPS_E2E_DELIVERY_SCAN: 'true', OPS_E2E_SCAN_PURPOSE: 'product_import' })).rejects.toThrow('OPS_E2E_PRODUCT_IMPORT_REQUIRES_DEDICATED_SCANNER_FIXTURE')
    await expect(runOpsE2e([product], { OPS_E2E_DELIVERY_SCAN: 'true', OPS_E2E_SCAN_PURPOSE: 'other' })).rejects.toThrow('OPS_E2E_SCAN_PURPOSE_INVALID')
    expect(forbidRuntimeResources).not.toHaveBeenCalled()
  })
  it('provisions a single idempotent test-only scan point bound to the disposable workspace', () => {
    expect(productImportPointGrantInput({ workspaceId: 'ws_isolated', runId: 'run_isolated' })).toEqual({
      workspaceId: 'ws_isolated', idempotencyKey: 'product-import-scan:run_isolated', sourceType: 'test_fixture',
      sourceId: 'run_isolated', points: 1, metadata: { isolated: true, purpose: 'product_import_scan',
        actor: 'isolated_fixture', reason: 'Admit one no-charge asset scan in this disposable workspace' },
    })
  })
  it('labels the disposable entitlement as synthetic and keeps its period and benefits explicit', () => {
    const sku = productImportSyntheticSku('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-28T00:00:00.000Z')
    expect(sku).toMatchObject({ kind: 'monthly', visibility: 'public', priceFen: 1, payload: { synthetic: true, purpose: 'product_import_scan' } })
    expect(sku.benefits.map(item => item.code)).toEqual(['max_brands', 'max_stores', 'monthly_creative_points'])
    expect(sku.checksum).toMatch(/^[a-f0-9]{64}$/u)
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
    for (const firstResource of ['mkdirSync(', 'createIsolatedOpsFixture(', 'freeLoopbackPort(', 'startCustomerDeliveryScanFixture(', 'createOpsPasswordProxy(', 'spawn(']) {
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
  it('writes a whitelisted scanner-cleanup phase for a successful browser followed by cleanup failure', () => {
    const report = opsE2eFailureReport({ throwSite: 'cleanup', browserExitCode: 0,
      cleanupErrors: ['OPS_E2E_SCANNER_CLEANUP_FAILED', 'postgres://private:secret@host'] })
    expect(report).toMatchObject({ status: 'failed', errorCode: 'OPS_E2E_SCANNER_CLEANUP_FAILED',
      stageCode: 'OPS_E2E_STAGE_SCANNER_CLEANUP', throwSite: 'scanner_cleanup', browserExitCode: 0,
      cleanupErrors: ['OPS_E2E_SCANNER_CLEANUP_FAILED'], runtimeErrors: [], sharedContainersTouched: false })
    expect(JSON.stringify(report)).not.toContain('secret')
  })
  it('writes the concrete scanner runtime stage without preserving raw exception text', () => {
    const report = opsE2eFailureReport({ throwSite: 'cleanup', browserExitCode: 0,
      runtimeErrors: ['OPS_E2E_SCANNER_RUNTIME_FAILED', 'raw daemon/private credential'] })
    expect(report).toMatchObject({ errorCode: 'OPS_E2E_SCANNER_RUNTIME_FAILED',
      stageCode: 'OPS_E2E_STAGE_SCANNER_RUNTIME', throwSite: 'scanner_runtime', browserExitCode: 0,
      cleanupErrors: [], runtimeErrors: ['OPS_E2E_SCANNER_RUNTIME_FAILED'] })
    expect(JSON.stringify(report)).not.toMatch(/daemon|credential/iu)
  })
  it('keeps a primary scanner runtime error aligned with its report stage', () => {
    const report = opsE2eFailureReport({ throwSite: 'browser_run', primaryErrorCode: 'OPS_E2E_SCANNER_RUNTIME_FAILED', browserExitCode: 0 })
    expect(report).toMatchObject({ errorCode: 'OPS_E2E_SCANNER_RUNTIME_FAILED', stageCode: 'OPS_E2E_STAGE_SCANNER_RUNTIME', throwSite: 'scanner_runtime' })
  })
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
