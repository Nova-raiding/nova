import { describe, expect, it, vi } from 'vitest'
import { createIsolatedRedisConfig, ISOLATED_REDIS_TEST_FILES } from '../vitest.redis.config.js'
import { isolatedRedisUrl, runIsolatedRedisTests, selectIsolatedRedisTests, validateIsolatedRedisReport, type IsolatedRedisRuntime } from '../scripts/run-isolated-redis-tests.js'
import { NON_HERMETIC_TEST_FILES } from './test-suite-isolation.js'

const ownedRedisUrl = 'redis://127.0.0.1:6399/0'
const report = (files: readonly string[]) => ({
  success: true, numTotalTests: files.length, numPassedTests: files.length, numFailedTests: 0,
  numPendingTests: 0, numTodoTests: 0, numRuntimeErrorTestSuites: 0,
  testResults: files.map(file => ({ name: `/project/${file}`, status: 'passed', assertionResults: [{ status: 'passed', fullName: 'fixture assertion' }] })),
})

describe('isolated Redis entrypoint', () => {
  it('keeps the REDIS_URL-gated files out of the default suite and inside this manifest', () => {
    expect(ISOLATED_REDIS_TEST_FILES).toHaveLength(2)
    for (const file of ISOLATED_REDIS_TEST_FILES) expect(NON_HERMETIC_TEST_FILES).toContain(file)
  })

  it('selects exactly the audited Redis files by default and rejects anything else', () => {
    expect(selectIsolatedRedisTests([])).toEqual([...ISOLATED_REDIS_TEST_FILES])
    expect(selectIsolatedRedisTests([`./${ISOLATED_REDIS_TEST_FILES[0]}`])).toEqual([ISOLATED_REDIS_TEST_FILES[0]])
    for (const argument of ['packages/workers/src', '--all', '--config=other.ts', 'run', 'apps/api/src/security.e2e.test.ts', 'packages/workers/src/durable.test.ts']) {
      expect(() => selectIsolatedRedisTests([argument]), argument).toThrow(/only exact audited Redis test files/u)
    }
  })

  it('accepts only an owned loopback Redis binding', () => {
    expect(isolatedRedisUrl({ REDIS_URL: ownedRedisUrl })).toBe(ownedRedisUrl)
    for (const source of [
      {},
      { REDIS_URL: '' },
      { REDIS_URL: 'redis://shared.example:6379/0' },
      { REDIS_URL: 'redis://10.0.0.7:6379' },
      { REDIS_URL: 'redis://user:secret@127.0.0.1:6379' },
      { REDIS_URL: 'redis://127.0.0.1:6379?family=6' },
      { REDIS_URL: 'http://127.0.0.1:6379' },
    ]) {
      expect(() => isolatedRedisUrl(source), JSON.stringify(source)).toThrow(/^ISOLATED_REDIS_URL_(MISSING|NOT_OWNED)$/u)
    }
  })

  it('makes the standalone config fail closed without an owned binding', () => {
    expect(() => createIsolatedRedisConfig({})).toThrow(/isolated Redis launcher/u)
    expect(() => createIsolatedRedisConfig({ REDIS_URL: 'redis://redis.internal:6379' })).toThrow(/isolated Redis launcher/u)
    const config = createIsolatedRedisConfig({ REDIS_URL: ownedRedisUrl, MERCHANT_ISOLATED_REDIS_RUN_ID: 'audited' })
    expect(config.test.include).toEqual([...ISOLATED_REDIS_TEST_FILES])
    expect(config.test.passWithNoTests).toBe(false)
    expect(config.test.fileParallelism).toBe(false)
  })

  it('accepts a complete report only when every expected file and assertion passed', () => {
    expect(validateIsolatedRedisReport(report(ISOLATED_REDIS_TEST_FILES), ISOLATED_REDIS_TEST_FILES)).toEqual([])
  })

  it('fails the gate on a skipped report, which is what a missing REDIS_URL produced', () => {
    // The previous default-suite behaviour: `describe.skipIf(!REDIS_URL)` reports
    // every assertion as pending and the run still exits 0.
    const skipped = report(ISOLATED_REDIS_TEST_FILES)
    for (const file of skipped.testResults) file.assertionResults = file.assertionResults.map(assertion => ({ ...assertion, status: 'pending' }))
    skipped.numPendingTests = ISOLATED_REDIS_TEST_FILES.length
    skipped.numPassedTests = 0
    expect(validateIsolatedRedisReport(skipped, ISOLATED_REDIS_TEST_FILES)).toContain('REDIS_REPORT_FAILED_OR_SKIPPED_ASSERTIONS')
  })

  it('rejects missing, unexpected, duplicated, empty, failed, and inconsistent reports', () => {
    const files = ISOLATED_REDIS_TEST_FILES.slice(0, 2)
    const missing = report(files); missing.testResults.pop()
    const unexpected = report(files); unexpected.testResults[0]!.name = '/project/tests/unapproved.test.ts'
    const duplicated = report(files); duplicated.testResults[1]!.name = duplicated.testResults[0]!.name
    const empty = report(files); empty.testResults[0]!.assertionResults = []
    const failed = report(files); failed.testResults[0]!.status = 'failed'
    const dishonest = report(files); dishonest.numPassedTests = 0
    const todo = report(files); todo.numTodoTests = 1
    const runtimeError = report(files); runtimeError.numRuntimeErrorTestSuites = 1
    for (const value of [missing, unexpected, duplicated, empty, failed, dishonest, todo, runtimeError, {}, null]) {
      expect(validateIsolatedRedisReport(value, files).length, JSON.stringify(value)).toBeGreaterThan(0)
    }
  })

  const fixture = () => {
    const runtime: IsolatedRedisRuntime = {
      createRunDirectory: vi.fn(async () => '/owned/evidence/run-unique'),
      runVitest: vi.fn(async () => 0),
      readReport: vi.fn(async () => report(ISOLATED_REDIS_TEST_FILES)),
      writeSummary: vi.fn(async () => undefined),
    }
    return { runtime }
  }

  it('injects only the validated owned binding and never inherits ambient credentials', async () => {
    const { runtime } = fixture()
    const outcome = await runIsolatedRedisTests([], { PATH: '/test/bin', DATABASE_URL: 'postgres://external/base', REDIS_URL: ownedRedisUrl, MODEL_RELAY_API_KEY: 'external-secret', EXECUTE: 'true' }, runtime)
    expect(outcome.exitCode).toBe(0)
    const [args, environment] = vi.mocked(runtime.runVitest).mock.calls[0]!
    expect(args).toContain('--config')
    expect(args).toContain('--reporter=json')
    expect(args).toContain('--passWithNoTests=false')
    expect(environment).toEqual({ PATH: '/test/bin', NODE_ENV: 'test', ASSET_STORAGE_ROOT: '/owned/evidence/run-unique/local-objects', REDIS_URL: ownedRedisUrl, MERCHANT_ISOLATED_REDIS_RUN_ID: 'audited' })
    expect(JSON.stringify(vi.mocked(runtime.writeSummary).mock.calls)).not.toContain('external-secret')
  })

  it('fails before spawning vitest when no owned Redis binding is provided', async () => {
    const { runtime } = fixture()
    await expect(runIsolatedRedisTests([], {}, runtime)).rejects.toThrow(/^ISOLATED_REDIS_URL_MISSING$/u)
    expect(runtime.createRunDirectory).not.toHaveBeenCalled()
    expect(runtime.runVitest).not.toHaveBeenCalled()
  })

  it('fails and reports the gate error when the child fails or the report is skipped', async () => {
    for (const mutate of ['child-failed', 'skipped'] as const) {
      const { runtime } = fixture()
      if (mutate === 'child-failed') vi.mocked(runtime.runVitest).mockResolvedValue(9)
      else {
        const value = report(ISOLATED_REDIS_TEST_FILES)
        value.testResults[0]!.assertionResults[0]!.status = 'pending'
        vi.mocked(runtime.readReport).mockResolvedValue(value)
      }
      const outcome = await runIsolatedRedisTests([], { REDIS_URL: ownedRedisUrl }, runtime)
      expect(outcome.exitCode).toBe(1)
      const summary = JSON.stringify(vi.mocked(runtime.writeSummary).mock.calls)
      expect(summary).toContain('"status":"failed"')
      expect(summary).not.toContain(ownedRedisUrl)
    }
  })
})
