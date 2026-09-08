import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { createIsolatedOpsFixture, type IsolatedFixtureDisposal } from '../tests/isolated-ops-fixture.js'
import { ISOLATED_POSTGRES_TEST_FILES } from '../vitest.postgres.config.js'
import { buildSafeTestEnvironment } from './run-safe-tests.js'

export { ISOLATED_POSTGRES_TEST_FILES }
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function discoverPostgresTests(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(projectRoot, directory, prefix), { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return discoverPostgresTests(directory, relative)
    return entry.name.endsWith('.postgres.test.ts') ? [`${directory}/${relative}`] : []
  }))
  return files.flat().sort()
}

let allPostgresTestsPromise: Promise<string[]> | undefined
function allPostgresTests(): Promise<string[]> {
  allPostgresTestsPromise ??= Promise.all(['packages/persistence', 'apps/worker', 'tests'].map(directory => discoverPostgresTests(directory))).then(groups => groups.flat().sort())
  return allPostgresTestsPromise
}

export async function selectIsolatedPostgresTests(args: readonly string[]): Promise<string[]> {
  if (args.length === 0) return [...ISOLATED_POSTGRES_TEST_FILES]
  if (args.length === 1 && args[0] === '--all') return allPostgresTests()
  const selected = args.map(argument => posix.normalize(argument.replaceAll('\\', '/')))
  if (selected.some(file => !ISOLATED_POSTGRES_TEST_FILES.some(expected => file === expected)) || new Set(selected).size !== selected.length) {
    throw new Error('This entrypoint accepts only exact audited PostgreSQL test files or --all; omit arguments to run the audited ten files.')
  }
  return selected
}

type ReportObject = Record<string, unknown>
const object = (value: unknown): value is ReportObject => typeof value === 'object' && value !== null && !Array.isArray(value)

export function validateIsolatedPostgresReport(value: unknown, expectedFiles: readonly string[]): string[] {
  if (!object(value) || !Array.isArray(value.testResults)) return ['POSTGRES_REPORT_MISSING_OR_INVALID']
  const errors: string[] = []
  if (value.success !== true || (value.numFailedTestSuites ?? 0) !== 0 || (value.numRuntimeErrorTestSuites ?? 0) !== 0) errors.push('POSTGRES_REPORT_NOT_SUCCESSFUL')
  if (value.numFailedTests !== 0 || value.numPendingTests !== 0 || (value.numTodoTests ?? 0) !== 0) errors.push('POSTGRES_REPORT_FAILED_OR_SKIPPED_ASSERTIONS')
  const observed = new Set<string>()
  let assertionCount = 0
  for (const item of value.testResults) {
    if (!object(item) || typeof item.name !== 'string' || !Array.isArray(item.assertionResults)) { errors.push('POSTGRES_REPORT_INVALID_FILE_RESULT'); continue }
    const name = item.name.replaceAll('\\', '/')
    const file = expectedFiles.find(expected => name === expected || name.endsWith(`/${expected}`))
    if (!file || observed.has(file)) errors.push('POSTGRES_REPORT_UNEXPECTED_OR_DUPLICATE_FILE')
    if (file) observed.add(file)
    if (item.status !== 'passed' || item.assertionResults.length === 0) errors.push('POSTGRES_REPORT_FAILED_OR_EMPTY_FILE')
    for (const assertion of item.assertionResults) {
      assertionCount += 1
      if (!object(assertion) || assertion.status !== 'passed') errors.push('POSTGRES_REPORT_ASSERTION_NOT_PASSED')
    }
  }
  if (expectedFiles.length === 0 || observed.size !== expectedFiles.length || value.testResults.length !== expectedFiles.length) errors.push('POSTGRES_REPORT_EXPECTED_FILES_MISSING')
  if (assertionCount === 0 || value.numTotalTests !== assertionCount || value.numPassedTests !== assertionCount) errors.push('POSTGRES_REPORT_ASSERTION_COUNTS_MISMATCH')
  return [...new Set(errors)]
}

interface IsolatedPostgresFixture {
  runId: string
  adminDatabaseUrl: string
  containerEvidence: readonly { kind: string; runId: string; hostPort: number }[]
  dispose(): Promise<IsolatedFixtureDisposal>
}
export interface IsolatedPostgresRuntime {
  createRunDirectory(): Promise<string>
  createFixture(input: { evidenceDir: string }): Promise<IsolatedPostgresFixture>
  prepareTestRoles(adminDatabaseUrl: string): Promise<void>
  runVitest(args: string[], environment: NodeJS.ProcessEnv): Promise<number>
  readReport(path: string): Promise<unknown>
  writeSummary(path: string, summary: Record<string, unknown>): Promise<void>
  cancelled?(): boolean
}

function assertOwnDatabaseBinding(fixture: IsolatedPostgresFixture) {
  const database = new URL(fixture.adminDatabaseUrl)
  const postgres = fixture.containerEvidence.filter(container => container.kind === 'postgres')
  if (!/^[a-f0-9-]{36}$/u.test(fixture.runId) || postgres.length !== 1 || postgres[0]!.runId !== fixture.runId
    || !/^postgres(?:ql)?:$/u.test(database.protocol) || database.hostname !== '127.0.0.1' || database.username !== 'merchant'
    || !database.password || database.pathname !== '/merchant' || Number(database.port) !== postgres[0]!.hostPort
    || postgres[0]!.hostPort < 1 || postgres[0]!.hostPort > 65535 || database.search || database.hash) {
    throw new Error('ISOLATED_POSTGRES_FIXTURE_BINDING_MISMATCH')
  }
}

let interrupted = false
let activeChild: ChildProcess | undefined
const defaultRuntime: IsolatedPostgresRuntime = {
  async createRunDirectory() {
    const parent = join(projectRoot, 'artifacts/isolated-postgres')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    return mkdtemp(join(parent, 'run-'))
  },
  createFixture: createIsolatedOpsFixture,
  async prepareTestRoles(adminDatabaseUrl) {
    // Existing acceptance files use these fixture-only role passwords. This
    // connection can only be the validated URL returned by our newly-created
    // fixture; the desktop fixture and external clusters are never reused.
    const pool = new Pool({ connectionString: adminDatabaseUrl, max: 1, connectionTimeoutMillis: 1_000 })
    try {
      await pool.query("ALTER ROLE merchant_app PASSWORD 'merchant_app_local_only'")
      await pool.query("ALTER ROLE merchant_ops PASSWORD 'merchant_ops_local_only'")
    } catch { throw new Error('ISOLATED_POSTGRES_TEST_ROLE_SETUP_FAILED') } finally { await pool.end() }
  },
  runVitest(args, environment) {
    return new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(projectRoot, 'node_modules/vitest/vitest.mjs'), ...args], { cwd: projectRoot, env: environment, stdio: 'inherit' })
      activeChild = child
      child.once('error', () => { activeChild = undefined; reject(new Error('ISOLATED_POSTGRES_TEST_PROCESS_FAILED')) })
      child.once('close', code => { activeChild = undefined; resolveExit(code ?? 1) })
    })
  },
  async readReport(path) { return JSON.parse(await readFile(path, 'utf8')) as unknown },
  async writeSummary(path, summary) { await writeFile(path, JSON.stringify(summary, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' }) },
  cancelled: () => interrupted,
}

export async function runIsolatedPostgresTests(args: readonly string[], source: NodeJS.ProcessEnv = process.env, runtime: IsolatedPostgresRuntime = defaultRuntime) {
  const selectedFiles = await selectIsolatedPostgresTests(args)
  const evidenceDir = await runtime.createRunDirectory()
  const reportPath = join(evidenceDir, 'vitest.json')
  const startedAt = new Date().toISOString()
  let fixture: IsolatedPostgresFixture | undefined
  let childExitCode: number | null = null
  let disposal: IsolatedFixtureDisposal | undefined
  const errors: string[] = []
  try {
    fixture = await runtime.createFixture({ evidenceDir })
    assertOwnDatabaseBinding(fixture)
    if (runtime.cancelled?.()) throw new Error('ISOLATED_POSTGRES_INTERRUPTED')
    await runtime.prepareTestRoles(fixture.adminDatabaseUrl)
    if (runtime.cancelled?.()) throw new Error('ISOLATED_POSTGRES_INTERRUPTED')
    const environment = {
      ...buildSafeTestEnvironment(source, join(evidenceDir, 'local-objects')),
      PERSISTENCE_RELEASE_DATABASE_URL: fixture.adminDatabaseUrl,
      MERCHANT_ISOLATED_POSTGRES_RUN_ID: fixture.runId,
      ...(selectedFiles.length !== ISOLATED_POSTGRES_TEST_FILES.length ? { MERCHANT_ISOLATED_POSTGRES_ALL: 'true' } : {}),
    }
    const vitestArgs = ['run', ...selectedFiles, '--config', join(projectRoot, 'vitest.postgres.config.ts'), '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`, '--passWithNoTests=false']
    childExitCode = await runtime.runVitest(vitestArgs, environment)
    if (childExitCode !== 0) errors.push('ISOLATED_POSTGRES_TEST_PROCESS_NONZERO')
    try { errors.push(...validateIsolatedPostgresReport(await runtime.readReport(reportPath), selectedFiles)) } catch { errors.push('POSTGRES_REPORT_MISSING_OR_INVALID') }
  } catch (error) {
    // Never serialize native errors, connection strings, or source environment.
    errors.push(error instanceof Error && /^ISOLATED_POSTGRES_[A-Z_]+$/u.test(error.message) ? error.message : 'ISOLATED_POSTGRES_RUN_FAILED')
  } finally {
    if (fixture) {
      try {
        disposal = await fixture.dispose()
        if (disposal.leftRunning.length > 0) errors.push('ISOLATED_POSTGRES_DISPOSAL_INCOMPLETE')
      } catch { errors.push('ISOLATED_POSTGRES_DISPOSAL_FAILED') }
    }
  }
  if (runtime.cancelled?.()) errors.push('ISOLATED_POSTGRES_INTERRUPTED')
  const exitCode = errors.length === 0 ? 0 : 1
  await runtime.writeSummary(join(evidenceDir, 'run-result.json'), {
    schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), runId: fixture?.runId ?? null,
    selectedFiles, childExitCode, status: exitCode === 0 ? 'passed' : 'failed', report: 'vitest.json', errors: [...new Set(errors)],
    fixtureOnly: true, databaseSource: 'newly-created-isolated-fixture', rolePasswordCompatibility: 'isolated-test-fixture-only',
    inheritedBusinessEnvironment: false, sharedContainersTouched: false, disposal: disposal ?? null,
  })
  return { exitCode, reportPath, selectedFiles }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const interrupt = () => { interrupted = true; activeChild?.kill('SIGINT') }
  const terminate = () => { interrupted = true; activeChild?.kill('SIGTERM') }
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  try {
    const result = await runIsolatedPostgresTests(process.argv.slice(2))
    process.exitCode = result.exitCode
    console.log(`Isolated PostgreSQL acceptance ${result.exitCode === 0 ? 'passed' : 'failed'}; report: ${result.reportPath}`)
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith('This entrypoint accepts only') ? error.message : 'Isolated PostgreSQL entrypoint failed; no external runtime configuration was used.')
    process.exitCode = 1
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
}
