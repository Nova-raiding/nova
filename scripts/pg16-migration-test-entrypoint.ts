import { posix } from 'node:path'

export const PG16_MIGRATION_TEST_FILE = 'tests/ecs-pg16-migration-compatibility.isolated.test.ts'
export const PG16_MIGRATION_TEST_FILES = [PG16_MIGRATION_TEST_FILE] as const

export function selectPg16MigrationTests(args: readonly string[]): string[] {
  if (args.length === 0) return [...PG16_MIGRATION_TEST_FILES]
  const selected = args.map(argument => posix.normalize(argument.replaceAll('\\', '/')))
  if (selected.length !== 1 || selected[0] !== PG16_MIGRATION_TEST_FILE) {
    throw new Error('This entrypoint accepts only the exact PostgreSQL 16 migration acceptance file; omit arguments to run it.')
  }
  return selected
}

type ReportObject = Record<string, unknown>
const object = (value: unknown): value is ReportObject => typeof value === 'object' && value !== null && !Array.isArray(value)

export function validatePg16MigrationReport(value: unknown): string[] {
  if (!object(value) || !Array.isArray(value.testResults)) return ['PG16_REPORT_MISSING_OR_INVALID']
  const errors: string[] = []
  if (value.success !== true || (value.numFailedTestSuites ?? 0) !== 0 || (value.numRuntimeErrorTestSuites ?? 0) !== 0) errors.push('PG16_REPORT_NOT_SUCCESSFUL')
  if (value.numFailedTests !== 0 || value.numPendingTests !== 0 || (value.numTodoTests ?? 0) !== 0) errors.push('PG16_REPORT_FAILED_OR_SKIPPED_ASSERTIONS')
  const item = value.testResults[0]
  if (value.testResults.length !== 1 || !object(item) || typeof item.name !== 'string' || !Array.isArray(item.assertionResults)) {
    errors.push('PG16_REPORT_EXPECTED_FILE_MISSING')
  } else {
    const name = item.name.replaceAll('\\', '/')
    if (!(name === PG16_MIGRATION_TEST_FILE || name.endsWith(`/${PG16_MIGRATION_TEST_FILE}`))) errors.push('PG16_REPORT_UNEXPECTED_FILE')
    if (item.status !== 'passed' || item.assertionResults.length !== 1) errors.push('PG16_REPORT_FILE_NOT_EXECUTED')
    for (const assertion of item.assertionResults) {
      if (!object(assertion) || assertion.status !== 'passed') errors.push('PG16_REPORT_ASSERTION_NOT_PASSED')
    }
  }
  if (value.numTotalTests !== 1 || value.numPassedTests !== 1) errors.push('PG16_REPORT_ASSERTION_COUNTS_MISMATCH')
  return [...new Set(errors)]
}

export function pg16MigrationTestEnvironment(source: NodeJS.ProcessEnv, reportPath: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'TZ', 'CI', 'GITHUB_ACTIONS'] as const
  const environment: NodeJS.ProcessEnv = {}
  for (const key of allowed) if (source[key] !== undefined) environment[key] = source[key]
  environment.NODE_ENV = 'test'
  environment.PG16_MIGRATION_TEST_REPORT_PATH = reportPath
  return environment
}
