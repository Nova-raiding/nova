import { describe, expect, it, vi } from 'vitest'
import { buildSafeTestEnvironment, buildSafeVitestArgs, runSafeTests, type SafeTestRuntime } from '../scripts/run-safe-tests.js'
import { NON_HERMETIC_TEST_FILES } from './test-suite-isolation.js'

describe('safe default test launcher', () => {
  it('passes only necessary system settings and never inherits business or execution credentials', () => {
    const environment = buildSafeTestEnvironment({
      PATH: '/test/bin', HOME: '/test/home', TMPDIR: '/test/tmp', LANG: 'en_US.UTF-8', CI: 'true', FORCE_COLOR: '0',
      NODE_ENV: 'production', NODE_OPTIONS: '--import=/unsafe/preload.mjs', EXECUTE: 'true', KUBECONFIG: '/shared/kube',
      DATABASE_URL: 'postgres://shared/database', OPS_DATABASE_URL: 'postgres://shared/ops', REDIS_URL: 'redis://shared',
      PERSISTENCE_RELEASE_DATABASE_URL: 'postgres://shared/release', LEGACY_BACKFILL_DATABASE_URL: 'postgres://shared/legacy',
      MODEL_BUDGET_DATABASE_URL: 'postgres://shared/budget', STORAGE_QUOTA_DATABASE_URL: 'postgres://shared/quota',
      MODEL_RELAY_API_KEY: 'secret', VIDEO_MODEL_RELAY_API_KEY: 'secret', AWS_ACCESS_KEY_ID: 'secret',
      ASSET_STORAGE_ROOT: '/shared/objects', OPS_BASE_URL: 'https://shared.example', VITE_API_BASE: 'https://shared.example',
    }, '/test/tmp/merchant-safe-tests-owned')
    expect(environment).toEqual({ PATH: '/test/bin', HOME: '/test/home', TMPDIR: '/test/tmp', LANG: 'en_US.UTF-8', CI: 'true', FORCE_COLOR: '0', NODE_ENV: 'test', ASSET_STORAGE_ROOT: '/test/tmp/merchant-safe-tests-owned' })
  })

  it('retains ordinary Vitest arguments while forcing a failing empty selection', () => {
    expect(buildSafeVitestArgs(['tests/safe-test-launcher.test.ts', '--reporter=json', '--outputFile=/tmp/test-report.json']))
      .toEqual(['run', 'tests/safe-test-launcher.test.ts', '--reporter=json', '--outputFile=/tmp/test-report.json', '--passWithNoTests=false'])
    expect(buildSafeVitestArgs(['run', '--no-file-parallelism'])).toEqual(['run', '--no-file-parallelism', '--passWithNoTests=false'])
  })

  it.each(NON_HERMETIC_TEST_FILES)('rejects an explicit real-runtime test before spawning: %s', file => {
    for (const selection of [file, `./${file}`, `/workspace/project/${file}`, `${file}:12`, file.split('/').at(-1)!]) {
      expect(() => buildSafeVitestArgs([selection])).toThrow(/dedicated integration entrypoint/u)
    }
  })

  it.each(['--config=integration.ts', '-c', '--root=/shared/project', '--dir', '--project=integration', '--workspace=integration.ts', '--exclude=anything', '--passWithNoTests', '--watch', '--ui'])('rejects an isolation-bypassing argument: %s', argument => {
    expect(() => buildSafeVitestArgs([argument])).toThrow(/safe test entrypoint/u)
  })
  it('allows only an explicit leading watch command with the same exclusions and environment', async () => {
    const runtime = fixture()
    await runSafeTests(['watch', 'tests/safe-test-launcher.test.ts'], { EXECUTE: 'true', REDIS_URL: 'redis://shared' }, runtime)
    expect(runtime.runVitest).toHaveBeenCalledWith(['watch', 'tests/safe-test-launcher.test.ts', '--passWithNoTests=false'], { NODE_ENV: 'test', ASSET_STORAGE_ROOT: '/test/tmp/merchant-safe-tests-owned' })
    expect(() => buildSafeVitestArgs(['watch', 'tests/local-docker-runtime-contract.test.ts'])).toThrow(/dedicated integration/u)
    expect(() => buildSafeVitestArgs(['watch', '--config=unsafe.ts'])).toThrow(/safe test entrypoint/u)
  })

  it('keeps the explicit isolation manifest unique and limited to the audited files', () => {
    expect(NON_HERMETIC_TEST_FILES).toHaveLength(16)
    expect(new Set(NON_HERMETIC_TEST_FILES).size).toBe(16)
    expect(NON_HERMETIC_TEST_FILES).toContain('apps/api/src/canonical-backfill-contract.test.ts')
    expect(NON_HERMETIC_TEST_FILES).toContain('tests/local-creative-points-seed-runtime.test.ts')
  })

  const fixture = () => {
    const runtime: SafeTestRuntime = {
      createStorageRoot: vi.fn(async () => '/test/tmp/merchant-safe-tests-owned'),
      runVitest: vi.fn(async () => 0),
      removeStorageRoot: vi.fn(async () => undefined),
    }
    return runtime
  }

  it('spawns with the safe environment and cleans only the newly-created directory', async () => {
    const runtime = fixture()
    await expect(runSafeTests(['tests/safe-test-launcher.test.ts'], { PATH: '/test/bin', ASSET_STORAGE_ROOT: '/shared/assets', EXECUTE: 'true' }, runtime)).resolves.toBe(0)
    expect(runtime.runVitest).toHaveBeenCalledWith(['run', 'tests/safe-test-launcher.test.ts', '--passWithNoTests=false'], { PATH: '/test/bin', NODE_ENV: 'test', ASSET_STORAGE_ROOT: '/test/tmp/merchant-safe-tests-owned' })
    expect(runtime.removeStorageRoot).toHaveBeenCalledExactlyOnceWith('/test/tmp/merchant-safe-tests-owned')
  })

  it('preserves a child failure and cleans the owned directory after the child has finished', async () => {
    const runtime = fixture()
    vi.mocked(runtime.runVitest).mockResolvedValue(7)
    await expect(runSafeTests([], {}, runtime)).resolves.toBe(7)
    expect(runtime.removeStorageRoot).toHaveBeenCalledExactlyOnceWith('/test/tmp/merchant-safe-tests-owned')
  })

  it('cleans after a spawn error without touching the inherited storage root', async () => {
    const runtime = fixture()
    vi.mocked(runtime.runVitest).mockRejectedValue(new Error('spawn failed'))
    await expect(runSafeTests([], { ASSET_STORAGE_ROOT: '/shared/assets' }, runtime)).rejects.toThrow('spawn failed')
    expect(runtime.removeStorageRoot).toHaveBeenCalledExactlyOnceWith('/test/tmp/merchant-safe-tests-owned')
  })

  it('fails before filesystem or child activity for a forbidden explicit selection', async () => {
    const runtime = fixture()
    await expect(runSafeTests(['tests/local-docker-fault-acceptance.test.ts'], {}, runtime)).rejects.toThrow(/dedicated integration entrypoint/u)
    expect(runtime.createStorageRoot).not.toHaveBeenCalled()
    expect(runtime.runVitest).not.toHaveBeenCalled()
    expect(runtime.removeStorageRoot).not.toHaveBeenCalled()
  })
})
