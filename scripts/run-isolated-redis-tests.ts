import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ISOLATED_REDIS_TEST_FILES } from '../vitest.redis.config.js'
import { buildSafeTestEnvironment } from './run-safe-tests.js'

export { ISOLATED_REDIS_TEST_FILES }
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Bounded to the exact audited files, like the PostgreSQL launcher. There is no
 * directory or `--all` discovery mode here on purpose: the Redis manifest is
 * two files, and an argument the launcher does not recognise must fail instead
 * of silently widening the run.
 */
export function selectIsolatedRedisTests(args: readonly string[]): string[] {
  if (args.length === 0) return [...ISOLATED_REDIS_TEST_FILES]
  const selected = args.map(argument => posix.normalize(argument.replaceAll('\\', '/')))
  if (selected.some(file => !ISOLATED_REDIS_TEST_FILES.some(expected => file === expected)) || new Set(selected).size !== selected.length) {
    throw new Error('This entrypoint accepts only exact audited Redis test files; omit arguments to run the audited Redis files.')
  }
  return selected
}

type ReportObject = Record<string, unknown>
const object = (value: unknown): value is ReportObject => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The failure this gate exists for: `describe.skipIf(!process.env.REDIS_URL)`
 * reports `pending` assertions and a green suite. `numPendingTests === 0` is
 * therefore a mandatory condition, exactly as in the PostgreSQL validator.
 */
export function validateIsolatedRedisReport(value: unknown, expectedFiles: readonly string[]): string[] {
  if (!object(value) || !Array.isArray(value.testResults)) return ['REDIS_REPORT_MISSING_OR_INVALID']
  const errors: string[] = []
  if (value.success !== true || (value.numFailedTestSuites ?? 0) !== 0 || (value.numRuntimeErrorTestSuites ?? 0) !== 0) errors.push('REDIS_REPORT_NOT_SUCCESSFUL')
  if (value.numFailedTests !== 0 || value.numPendingTests !== 0 || (value.numTodoTests ?? 0) !== 0) errors.push('REDIS_REPORT_FAILED_OR_SKIPPED_ASSERTIONS')
  const observed = new Set<string>()
  let assertionCount = 0
  for (const item of value.testResults) {
    if (!object(item) || typeof item.name !== 'string' || !Array.isArray(item.assertionResults)) { errors.push('REDIS_REPORT_INVALID_FILE_RESULT'); continue }
    const name = item.name.replaceAll('\\', '/')
    const file = expectedFiles.find(expected => name === expected || name.endsWith(`/${expected}`))
    if (!file || observed.has(file)) errors.push('REDIS_REPORT_UNEXPECTED_OR_DUPLICATE_FILE')
    if (file) observed.add(file)
    if (item.status !== 'passed' || item.assertionResults.length === 0) errors.push('REDIS_REPORT_FAILED_OR_EMPTY_FILE')
    for (const assertion of item.assertionResults) {
      assertionCount += 1
      if (!object(assertion) || assertion.status !== 'passed') errors.push('REDIS_REPORT_ASSERTION_NOT_PASSED')
    }
  }
  if (expectedFiles.length === 0 || observed.size !== expectedFiles.length || value.testResults.length !== expectedFiles.length) errors.push('REDIS_REPORT_EXPECTED_FILES_MISSING')
  if (assertionCount === 0 || value.numTotalTests !== assertionCount || value.numPassedTests !== assertionCount) errors.push('REDIS_REPORT_ASSERTION_COUNTS_MISMATCH')
  return [...new Set(errors)]
}

export interface IsolatedRedisRuntime {
  createRunDirectory(): Promise<string>
  runVitest(args: string[], environment: NodeJS.ProcessEnv): Promise<number>
  readReport(path: string): Promise<unknown>
  writeSummary(path: string, summary: Record<string, unknown>): Promise<void>
  cancelled?(): boolean
}

let interrupted = false
let activeChild: ChildProcess | undefined
const defaultRuntime: IsolatedRedisRuntime = {
  async createRunDirectory() {
    const parent = join(projectRoot, 'artifacts/isolated-redis')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    return mkdtemp(join(parent, 'run-'))
  },
  runVitest(args, environment) {
    return new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(projectRoot, 'node_modules/vitest/vitest.mjs'), ...args], { cwd: projectRoot, env: environment, stdio: 'inherit' })
      activeChild = child
      child.once('error', () => { activeChild = undefined; reject(new Error('ISOLATED_REDIS_TEST_PROCESS_FAILED')) })
      child.once('close', code => { activeChild = undefined; resolveExit(code ?? 1) })
    })
  },
  async readReport(path) { return JSON.parse(await readFile(path, 'utf8')) as unknown },
  async writeSummary(path, summary) { await writeFile(path, JSON.stringify(summary, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' }) },
  cancelled: () => interrupted,
}

/** The only accepted binding: an owned, disposable Redis on the loopback host. */
export function isolatedRedisUrl(source: NodeJS.ProcessEnv): string {
  const raw = source.REDIS_URL?.trim()
  if (!raw) throw new Error('ISOLATED_REDIS_URL_MISSING')
  try {
    const url = new URL(raw)
    // Credentials are rejected as well: a credentialed URL is how a managed or
    // shared instance is reached, and this launcher only writes keys into an
    // instance it may destroy.
    if ((url.protocol !== 'redis:' && url.protocol !== 'rediss:')
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\d+$/u.test(url.port) || !url.port
      || Number(url.port) < 1 || Number(url.port) > 65535 || url.search || url.hash || url.username || url.password) throw new Error('shared')
    return raw
  } catch { throw new Error('ISOLATED_REDIS_URL_NOT_OWNED') }
}

export async function runIsolatedRedisTests(args: readonly string[], source: NodeJS.ProcessEnv = process.env, runtime: IsolatedRedisRuntime = defaultRuntime) {
  const selectedFiles = selectIsolatedRedisTests(args)
  const redisUrl = isolatedRedisUrl(source)
  const evidenceDir = await runtime.createRunDirectory()
  const reportPath = join(evidenceDir, 'vitest.json')
  const startedAt = new Date().toISOString()
  let childExitCode: number | null = null
  const errors: string[] = []
  try {
    if (runtime.cancelled?.()) throw new Error('ISOLATED_REDIS_INTERRUPTED')
    const environment = {
      ...buildSafeTestEnvironment(source, join(evidenceDir, 'local-objects')),
      // The safe launcher strips ambient credentials by design; this launcher
      // re-injects only the validated owned binding.
      REDIS_URL: redisUrl,
      MERCHANT_ISOLATED_REDIS_RUN_ID: selectedFiles.length === ISOLATED_REDIS_TEST_FILES.length ? 'audited' : 'subset',
    }
    const vitestArgs = ['run', ...selectedFiles, '--config', join(projectRoot, 'vitest.redis.config.ts'), '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`, '--passWithNoTests=false']
    childExitCode = await runtime.runVitest(vitestArgs, environment)
    if (childExitCode !== 0) errors.push('ISOLATED_REDIS_TEST_PROCESS_NONZERO')
    try { errors.push(...validateIsolatedRedisReport(await runtime.readReport(reportPath), selectedFiles)) } catch { errors.push('REDIS_REPORT_MISSING_OR_INVALID') }
  } catch (error) {
    // Never serialize native errors or connection strings to the evidence file.
    errors.push(error instanceof Error && /^ISOLATED_REDIS_[A-Z_]+$/u.test(error.message) ? error.message : 'ISOLATED_REDIS_RUN_FAILED')
  }
  if (runtime.cancelled?.()) errors.push('ISOLATED_REDIS_INTERRUPTED')
  const exitCode = errors.length === 0 ? 0 : 1
  await runtime.writeSummary(join(evidenceDir, 'run-result.json'), {
    schemaVersion: 1, startedAt, endedAt: new Date().toISOString(),
    selectedFiles, childExitCode, status: exitCode === 0 ? 'passed' : 'failed', report: 'vitest.json', errors: [...new Set(errors)],
    runtime: 'owned-local-redis', inheritedBusinessEnvironment: false, sharedRuntimeTouched: false,
  })
  return { exitCode, reportPath, selectedFiles }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const interrupt = () => { interrupted = true; activeChild?.kill('SIGINT') }
  const terminate = () => { interrupted = true; activeChild?.kill('SIGTERM') }
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  try {
    const result = await runIsolatedRedisTests(process.argv.slice(2))
    console.log(`Isolated Redis acceptance ${result.exitCode === 0 ? 'passed' : 'failed'}; report: ${result.reportPath}`)
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(error instanceof Error && (error.message.startsWith('This entrypoint accepts only') || /^ISOLATED_REDIS_[A-Z_]+$/u.test(error.message)) ? `Isolated Redis entrypoint failed: ${error.message}` : 'Isolated Redis entrypoint failed; no external runtime configuration was used.')
    process.exitCode = 1
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
}
