import { describe, expect, it, vi } from 'vitest'
import { createIsolatedPostgresConfig } from '../vitest.postgres.config.js'
import { ISOLATED_POSTGRES_TEST_FILES, selectIsolatedPostgresTests, validateIsolatedPostgresReport, runIsolatedPostgresTests, type IsolatedPostgresRuntime } from '../scripts/run-isolated-postgres-tests.js'

const runId = '11111111-1111-4111-8111-111111111111'
const adminUrl = 'postgres://merchant:generated-fixture-secret@127.0.0.1:45678/merchant'
const report = (files: readonly string[]) => ({
  success: true, numTotalTests: files.length, numPassedTests: files.length, numFailedTests: 0,
  numPendingTests: 0, numTodoTests: 0, numRuntimeErrorTestSuites: 0,
  testResults: files.map(file => ({ name: `/project/${file}`, status: 'passed', assertionResults: [{ status: 'passed', fullName: 'fixture assertion' }] })),
})

describe('isolated PostgreSQL entrypoint', () => {
  it('selects exactly the ten audited PostgreSQL files by default', async () => {
    expect(ISOLATED_POSTGRES_TEST_FILES).toHaveLength(11)
    expect(new Set(ISOLATED_POSTGRES_TEST_FILES).size).toBe(11)
    await expect(selectIsolatedPostgresTests([])).resolves.toEqual(ISOLATED_POSTGRES_TEST_FILES)
    expect(ISOLATED_POSTGRES_TEST_FILES.every(file => file.startsWith('packages/persistence/src/') && file.endsWith('.postgres.test.ts'))).toBe(true)
  })
  it('accepts only exact audited file selections and normalizes a relative prefix', async () => {
    await expect(selectIsolatedPostgresTests([`./${ISOLATED_POSTGRES_TEST_FILES[0]}`])).resolves.toEqual([ISOLATED_POSTGRES_TEST_FILES[0]])
  })
  it.each(['--config=other.ts', '--env', '--reporter=json', '--passWithNoTests', '--testNamePattern=x', 'run', 'packages/persistence/src', 'tests/local-docker-runtime-contract.test.ts', 'apps/api/src/canonical-backfill-contract.test.ts', 'packages/persistence/src/migration-051.test.ts'])('rejects an unapproved argument before starting Docker: %s', async argument => {
    await expect(selectIsolatedPostgresTests([argument])).rejects.toThrow(/only exact audited PostgreSQL test files/u)
  })
  it('makes the standalone config fail closed without generated fixture bindings', () => {
    expect(() => createIsolatedPostgresConfig({})).toThrow(/isolated PostgreSQL launcher/u)
    expect(() => createIsolatedPostgresConfig({ PERSISTENCE_RELEASE_DATABASE_URL: adminUrl })).toThrow(/isolated PostgreSQL launcher/u)
    expect(() => createIsolatedPostgresConfig({ MERCHANT_ISOLATED_POSTGRES_RUN_ID: runId, PERSISTENCE_RELEASE_DATABASE_URL: 'postgres://shared.example/merchant' })).toThrow(/isolated PostgreSQL launcher/u)
    const config = createIsolatedPostgresConfig({ MERCHANT_ISOLATED_POSTGRES_RUN_ID: runId, PERSISTENCE_RELEASE_DATABASE_URL: adminUrl })
    expect(config.test.include).toEqual(ISOLATED_POSTGRES_TEST_FILES)
    expect(config.test.passWithNoTests).toBe(false)
    expect(config.test.fileParallelism).toBe(false)
  })
  it('accepts a complete report only when every expected file and assertion passed', () => {
    expect(validateIsolatedPostgresReport(report(ISOLATED_POSTGRES_TEST_FILES), ISOLATED_POSTGRES_TEST_FILES)).toEqual([])
  })
  it('rejects missing, unexpected, duplicated, skipped, empty, and internally inconsistent reports', () => {
    const files = ISOLATED_POSTGRES_TEST_FILES.slice(0, 2)
    const missing = report(files); missing.testResults.pop()
    const unexpected = report(files); unexpected.testResults[0]!.name = '/project/tests/unapproved.test.ts'
    const duplicated = report(files); duplicated.testResults[1]!.name = duplicated.testResults[0]!.name
    const skipped = report(files); skipped.testResults[0]!.assertionResults[0]!.status = 'pending'
    const empty = report(files); empty.testResults[0]!.assertionResults = []
    const failed = report(files); failed.testResults[0]!.status = 'failed'
    const dishonest = report(files); dishonest.numPassedTests = 0
    const runtimeError = report(files); runtimeError.numRuntimeErrorTestSuites = 1
    for (const value of [missing, unexpected, duplicated, skipped, empty, failed, dishonest, runtimeError, {}, null]) {
      expect(validateIsolatedPostgresReport(value, files).length).toBeGreaterThan(0)
    }
  })

  const fixture = () => {
    const handle = {
      runId, adminDatabaseUrl: adminUrl,
      containerEvidence: [{ kind: 'postgres', runId, hostPort: 45678 }],
      dispose: vi.fn(async () => ({ stopped: ['owned-postgres', 'owned-redis'], leftRunning: [] })),
    }
    const runtime: IsolatedPostgresRuntime = {
      createRunDirectory: vi.fn(async () => '/owned/evidence/run-unique'),
      createFixture: vi.fn(async () => handle),
      prepareTestRoles: vi.fn(async () => undefined),
      runVitest: vi.fn(async () => 0),
      readReport: vi.fn(async () => report(ISOLATED_POSTGRES_TEST_FILES)),
      writeSummary: vi.fn(async () => undefined),
    }
    return { handle, runtime }
  }
  it('binds only the fixture-returned admin URL and never inherits ambient runtime settings', async () => {
    const { handle, runtime } = fixture()
    const outcome = await runIsolatedPostgresTests([], { PATH: '/test/bin', DATABASE_URL: 'postgres://external/base', PERSISTENCE_RELEASE_DATABASE_URL: 'postgres://external/release', REDIS_URL: 'redis://external', EXECUTE: 'true', MODEL_RELAY_API_KEY: 'external-secret' }, runtime)
    expect(outcome.exitCode).toBe(0)
    expect(runtime.prepareTestRoles).toHaveBeenCalledExactlyOnceWith(handle.adminDatabaseUrl)
    const [args, environment] = vi.mocked(runtime.runVitest).mock.calls[0]!
    expect(args).toContain('--config')
    expect(args).toContain('--reporter=json')
    expect(args).toContain('--passWithNoTests=false')
    expect(environment).toEqual({ PATH: '/test/bin', NODE_ENV: 'test', ASSET_STORAGE_ROOT: '/owned/evidence/run-unique/local-objects', PERSISTENCE_RELEASE_DATABASE_URL: adminUrl, MERCHANT_ISOLATED_POSTGRES_RUN_ID: runId })
    expect(handle.dispose).toHaveBeenCalledOnce()
    const summary = JSON.stringify(vi.mocked(runtime.writeSummary).mock.calls)
    expect(summary).not.toContain('generated-fixture-secret')
    expect(summary).not.toContain('external-secret')
    expect(summary).not.toContain(adminUrl)
  })
  it('fails before fixture creation for an unapproved selection', async () => {
    const { runtime } = fixture()
    await expect(runIsolatedPostgresTests(['--config=other.ts'], {}, runtime)).rejects.toThrow(/only exact audited PostgreSQL test files/u)
    expect(runtime.createRunDirectory).not.toHaveBeenCalled()
    expect(runtime.createFixture).not.toHaveBeenCalled()
  })
  it('rejects a fixture URL that does not match its generated local container before SQL or Vitest', async () => {
    const { handle, runtime } = fixture()
    handle.adminDatabaseUrl = 'postgres://merchant:secret@127.0.0.1:54329/merchant'
    expect((await runIsolatedPostgresTests([], {}, runtime)).exitCode).toBe(1)
    expect(runtime.prepareTestRoles).not.toHaveBeenCalled()
    expect(runtime.runVitest).not.toHaveBeenCalled()
    expect(handle.dispose).toHaveBeenCalledOnce()
  })
  it('does not report success when the child fails despite a passing JSON report', async () => {
    const { handle, runtime } = fixture()
    vi.mocked(runtime.runVitest).mockResolvedValue(9)
    expect((await runIsolatedPostgresTests([], {}, runtime)).exitCode).toBe(1)
    expect(handle.dispose).toHaveBeenCalledOnce()
  })
  it('fails and disposes on a skipped or missing report', async () => {
    for (const missing of [false, true]) {
      const { handle, runtime } = fixture()
      if (missing) vi.mocked(runtime.readReport).mockRejectedValue(new Error('missing report'))
      else { const value = report(ISOLATED_POSTGRES_TEST_FILES); value.testResults[0]!.assertionResults[0]!.status = 'pending'; vi.mocked(runtime.readReport).mockResolvedValue(value) }
      expect((await runIsolatedPostgresTests([], {}, runtime)).exitCode).toBe(1)
      expect(handle.dispose).toHaveBeenCalledOnce()
    }
  })
  it('disposes after preparation or child errors without leaking native error secrets', async () => {
    for (const action of ['prepareTestRoles', 'runVitest'] as const) {
      const { handle, runtime } = fixture()
      vi.mocked(runtime[action]).mockRejectedValue(new Error(adminUrl))
      expect((await runIsolatedPostgresTests([], {}, runtime)).exitCode).toBe(1)
      expect(handle.dispose).toHaveBeenCalledOnce()
      expect(JSON.stringify(vi.mocked(runtime.writeSummary).mock.calls)).not.toContain(adminUrl)
    }
  })
  it('fails the gate if any owned container could not be disposed', async () => {
    const { handle, runtime } = fixture()
    vi.mocked(handle.dispose).mockResolvedValue({ stopped: [], leftRunning: [{ id: 'owned-postgres', reason: 'identity mismatch' }] } as never)
    expect((await runIsolatedPostgresTests([], {}, runtime)).exitCode).toBe(1)
  })
})
