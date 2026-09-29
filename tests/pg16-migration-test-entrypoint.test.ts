import { describe, expect, it } from 'vitest'
import { PG16_MIGRATION_TEST_FILE, PG16_MIGRATION_TEST_FILES, pg16MigrationTestEnvironment, selectPg16MigrationTests, validatePg16MigrationReport } from '../scripts/pg16-migration-test-entrypoint.js'

const report = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  numFailedTestSuites: 0,
  numRuntimeErrorTestSuites: 0,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTests: 1,
  numPassedTests: 1,
  testResults: [{ name: `/repo/${PG16_MIGRATION_TEST_FILE}`, status: 'passed', assertionResults: [{ status: 'passed' }] }],
  ...overrides,
})

describe('PG16 migration acceptance entrypoint', () => {
  it('selects only the fixed isolated acceptance file', () => {
    expect(PG16_MIGRATION_TEST_FILES).toEqual([PG16_MIGRATION_TEST_FILE])
    expect(selectPg16MigrationTests([])).toEqual([PG16_MIGRATION_TEST_FILE])
    expect(selectPg16MigrationTests([PG16_MIGRATION_TEST_FILE])).toEqual([PG16_MIGRATION_TEST_FILE])
  })

  it.each([
    ['another file', ['tests/server.e2e.test.ts']],
    ['a directory', ['tests']],
    ['a duplicate selection', [PG16_MIGRATION_TEST_FILE, PG16_MIGRATION_TEST_FILE]],
    ['a Vitest option', ['--config=vitest.config.ts']],
  ])('rejects %s so the dedicated launcher cannot widen its test scope', (_name, args) => {
    expect(() => selectPg16MigrationTests(args)).toThrow(/accepts only the exact PostgreSQL 16 migration acceptance file/u)
  })

  it('requires one actually passed assertion with no pending or todo tests', () => {
    expect(validatePg16MigrationReport(report())).toEqual([])
    expect(validatePg16MigrationReport(report({ numPendingTests: 1 }))).toContain('PG16_REPORT_FAILED_OR_SKIPPED_ASSERTIONS')
    expect(validatePg16MigrationReport(report({ numPassedTests: 0 }))).toContain('PG16_REPORT_ASSERTION_COUNTS_MISMATCH')
    expect(validatePg16MigrationReport(report({ testResults: [] }))).toContain('PG16_REPORT_EXPECTED_FILE_MISSING')
    expect(validatePg16MigrationReport(report({ testResults: [{ name: '/repo/tests/other.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }] }] }))).toContain('PG16_REPORT_UNEXPECTED_FILE')
    expect(validatePg16MigrationReport(report({ testResults: [{ name: `/repo/${PG16_MIGRATION_TEST_FILE}`, status: 'skipped', assertionResults: [] }] }))).toContain('PG16_REPORT_FILE_NOT_EXECUTED')
  })

  it('passes only non-secret host settings and the private report path to Vitest', () => {
    expect(pg16MigrationTestEnvironment({ PATH: '/bin', HOME: '/home/test', DATABASE_URL: 'postgres://shared', DOCKER_HOST: 'tcp://remote:2375', API_TOKEN: 'secret' }, '/tmp/private/vitest.json'))
      .toEqual({ PATH: '/bin', HOME: '/home/test', NODE_ENV: 'test', PG16_MIGRATION_TEST_REPORT_PATH: '/tmp/private/vitest.json' })
  })
})
