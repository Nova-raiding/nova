import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSafeTestEnvironment } from '../scripts/run-safe-tests.js'

type ProcessResult = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error'>
type SmokeSummary = { profile: string; transport: string; connectorMode: string; cloudGate: boolean; workspaces: number; requests: number; duplicatePublishRequests: number; acceptedPublishJobs: number; uniquePublishJobs: number; duplicateWrites: number; errors: unknown[] }
type EvidencePaths = { directory: string; vitestReport: string; vitestStdout: string; vitestStderr: string; smokeStdout: string; smokeStderr: string; summary: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const statuses = ['passed', 'failed', 'skipped', 'pending', 'todo'] as const
type Status = typeof statuses[number]

/** Counts assertion outcomes: Vitest's numPendingTests also includes skipped tests,
 * and its file status can be "passed" even when every assertion was skipped. */
export function summarizeVitestReport(report: unknown) {
  if (!object(report) || !Array.isArray(report.testResults) || report.testResults.length === 0) throw new Error('Vitest report has no test file results')
  const tests = { total: 0, executed: 0, passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0, notExecuted: 0 }
  const testFiles = { total: report.testResults.length, executed: 0, passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0, empty: 0 }
  for (const file of report.testResults) {
    if (!object(file) || !Array.isArray(file.assertionResults) || !['passed', 'failed'].includes(String(file.status))) throw new Error('Vitest report contains an invalid test file result')
    const outcomes: Status[] = file.assertionResults.map(assertion => {
      if (!object(assertion) || !statuses.includes(assertion.status as Status)) throw new Error('Vitest report contains an unknown assertion status')
      const status = assertion.status as Status
      tests[status] += 1
      tests.total += 1
      return status
    })
    const executed = outcomes.some(status => status === 'passed' || status === 'failed')
    if (executed || file.status === 'failed') testFiles.executed += 1
    if (file.status === 'failed' || outcomes.includes('failed')) testFiles.failed += 1
    else if (outcomes.includes('pending')) testFiles.pending += 1
    else if (executed) testFiles.passed += 1
    else if (outcomes.length === 0) testFiles.empty += 1
    else if (outcomes.every(status => status === 'todo')) testFiles.todo += 1
    else testFiles.skipped += 1
  }
  tests.executed = tests.passed + tests.failed
  tests.notExecuted = tests.skipped + tests.pending + tests.todo
  for (const [field, observed] of Object.entries({ numTotalTests: tests.total, numPassedTests: tests.passed, numFailedTests: tests.failed, numPendingTests: tests.skipped + tests.pending, numTodoTests: tests.todo })) {
    if (!count(report[field]) || report[field] !== observed) throw new Error(`Vitest report ${field} does not match assertion results`)
  }
  if (typeof report.success !== 'boolean') throw new Error('Vitest report success flag is missing')
  return { testFiles, tests, reportedSuccess: report.success }
}

function parseSmokeSummary(stdout: string): SmokeSummary {
  const lastLine = stdout.trim().split('\n').filter(Boolean).at(-1)
  if (!lastLine) throw new Error('HTTP smoke did not emit a summary')
  const value: unknown = JSON.parse(lastLine)
  if (!object(value)) throw new Error('HTTP smoke summary must be an object')
  for (const key of ['profile', 'transport', 'connectorMode']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`HTTP smoke summary ${key} is missing`)
  for (const key of ['workspaces', 'requests', 'duplicatePublishRequests', 'acceptedPublishJobs', 'uniquePublishJobs', 'duplicateWrites']) if (!count(value[key])) throw new Error(`HTTP smoke summary ${key} must be a non-negative integer`)
  if (typeof value.cloudGate !== 'boolean' || !Array.isArray(value.errors)) throw new Error('HTTP smoke summary evidence fields are invalid')
  if (value.workspaces === 0 || value.requests === 0) throw new Error('HTTP smoke did not exercise any workspaces or requests')
  return value as SmokeSummary
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function processErrors(name: string, result: ProcessResult): string[] {
  const errors: string[] = []
  if (result.error) errors.push(`${name} could not complete: ${message(result.error)}`)
  if (result.signal) errors.push(`${name} terminated by ${result.signal}`)
  if (result.status !== 0) errors.push(`${name} exit code: ${result.status ?? 'unavailable'}`)
  return errors
}

export function buildTestSummary(input: { reportText?: string; smokeStdout: string; testRun: ProcessResult; smokeRun: ProcessResult; evidence: EvidencePaths }) {
  const reportErrors: string[] = []
  let counts: ReturnType<typeof summarizeVitestReport> | undefined
  let load: SmokeSummary | undefined
  try {
    if (input.reportText === undefined) throw new Error('Vitest JSON report is missing or unreadable')
    counts = summarizeVitestReport(JSON.parse(input.reportText))
  } catch (error) { reportErrors.push(message(error)) }
  try { load = parseSmokeSummary(input.smokeStdout) } catch (error) { reportErrors.push(message(error)) }
  const childErrors = [...processErrors('Vitest', input.testRun), ...processErrors('HTTP smoke', input.smokeRun)]
  if (counts && counts.tests.executed === 0) reportErrors.push('No test assertions were executed')
  if (counts && counts.tests.pending > 0) reportErrors.push('Vitest reported pending assertions; execution is incomplete')
  const failed = reportErrors.length > 0 || childErrors.length > 0 || !counts?.reportedSuccess || !!counts?.testFiles.failed || !!counts?.tests.failed || !!load?.errors.length
  return {
    status: failed ? 'fail' : counts!.tests.notExecuted > 0 ? 'partial' : 'pass',
    testFiles: counts?.testFiles ?? null,
    tests: counts?.tests ?? null,
    executionComplete: !!counts && counts.tests.executed > 0 && counts.tests.notExecuted === 0,
    evidence: input.evidence,
    loadProfile: load ? { name: load.profile, transport: load.transport, connectorMode: load.connectorMode, cloudGate: load.cloudGate, workspaces: load.workspaces, requests: load.requests } : null,
    duplicateWrites: load ? { publishRequests: load.duplicatePublishRequests, acceptedResponses: load.acceptedPublishJobs, uniquePublishJobs: load.uniquePublishJobs, deduplicatedWrites: load.duplicateWrites } : null,
    errors: { vitestExitCode: input.testRun.status, smokeExitCode: input.smokeRun.status, testFailures: counts?.tests.failed ?? null, smokeErrors: load?.errors ?? null, reportErrors, childErrors },
  }
}

function runCaptured(root: string, args: string[], stdoutPath: string, stderrPath: string, environment: NodeJS.ProcessEnv): ProcessResult {
  const stdout = openSync(stdoutPath, 'w', 0o600)
  let stderr: number | undefined
  try {
    stderr = openSync(stderrPath, 'w', 0o600)
    // Direct logs to files so a large suite cannot exhaust spawnSync's buffer.
    return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: environment, stdio: ['ignore', stdout, stderr] })
  } finally {
    closeSync(stdout)
    if (stderr !== undefined) closeSync(stderr)
  }
}

function main() {
  const root = process.cwd()
  const evidenceBase = resolve(root, process.env.TEST_SUMMARY_ARTIFACT_DIR ?? 'artifacts/test-summary')
  mkdirSync(evidenceBase, { recursive: true })
  const directory = mkdtempSync(join(evidenceBase, 'run-'))
  const evidence: EvidencePaths = {
    directory, vitestReport: join(directory, 'vitest.json'), vitestStdout: join(directory, 'vitest.stdout.log'), vitestStderr: join(directory, 'vitest.stderr.log'),
    smokeStdout: join(directory, 'http-smoke.stdout.log'), smokeStderr: join(directory, 'http-smoke.stderr.log'), summary: join(directory, 'summary.json'),
  }
  // The safe Vitest launcher creates its own storage. The fixture HTTP smoke
  // also needs an owned directory and must never inherit runtime credentials.
  const smokeStorageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'merchant-test-summary-smoke-')))
  try {
    const environment = buildSafeTestEnvironment(process.env, smokeStorageRoot)
    const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs')
    const testRun = runCaptured(root, [tsx, resolve(root, 'scripts/run-safe-tests.ts'), '--reporter=json', `--outputFile=${evidence.vitestReport}`], evidence.vitestStdout, evidence.vitestStderr, environment)
    // Explicit synthetic rates match http-load-smoke.test.ts. This flag is
    // never inherited and is not passed to the ordinary Vitest child.
    const smokeRun = runCaptured(root, [tsx, resolve(root, 'tests/http-load-smoke.ts')], evidence.smokeStdout, evidence.smokeStderr, { ...environment, MERCHANT_TEST_APPROVED_RATES: 'true' })
    let reportText: string | undefined
    try { reportText = readFileSync(evidence.vitestReport, 'utf8') } catch { /* Missing evidence must fail in the summary. */ }
    const summary = buildTestSummary({ reportText, smokeStdout: readFileSync(evidence.smokeStdout, 'utf8'), testRun, smokeRun, evidence })
    const json = JSON.stringify(summary, null, 2)
    writeFileSync(evidence.summary, `${json}\n`, { mode: 0o600 })
    console.log(json)
    if (summary.status === 'fail') process.exitCode = 1
  } finally {
    // Only this invocation's mkdtemp path is eligible, never an env path or
    // the evidence directory. Preserve reports even when a child fails.
    rmSync(smokeStorageRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(JSON.stringify({ status: 'fail', error: message(error) }))
    process.exitCode = 1
  }
}
