/**
 * Default-suite pending-assertion gate.
 *
 * The failure this exists for: a `const postgresIt = databaseUrl ? it : it.skip`
 * (or `describe.skipIf(!REDIS_URL)`) file is collected by the default suite,
 * reports every DB-backed assertion as `pending`, and the run still exits 0.
 * A green `npm test` therefore proved nothing about those assertions.
 *
 * This gate is wired in through `vitest.config.ts` (`test.reporters`) rather
 * than through the safe launcher's CLI arguments, because the launcher's
 * argument and environment contracts are themselves pinned by
 * `tests/safe-test-launcher.test.ts`. Running as a reporter means every
 * invocation of the default configuration is covered: `npm test`,
 * `npm run test:watch`, `npm run test:release-gates`, and a bare
 * `npx vitest run <file>`.
 *
 * Shape mirrors `validateIsolatedPostgresReport` / `validateIsolatedRedisReport`:
 * read a report, then assert that nothing was reported as pending or todo
 * unless an explicit, reasoned allowance covers the exact file and count.
 */
import type { TestModule } from 'vitest/node'
import { DEFAULT_SUITE_PENDING_ALLOWANCES, type DefaultSuitePendingAllowance } from '../tests/test-suite-isolation.js'

export const PENDING_GATE_ERROR_CODES = {
  reportMissing: 'DEFAULT_SUITE_REPORT_MISSING_OR_INVALID',
  unexpectedPending: 'DEFAULT_SUITE_UNEXPECTED_PENDING_ASSERTIONS',
  pendingCountDrift: 'DEFAULT_SUITE_PENDING_COUNT_DRIFT',
  staleAllowance: 'DEFAULT_SUITE_STALE_PENDING_ALLOWANCE',
  todo: 'DEFAULT_SUITE_TODO_ASSERTIONS',
  emptyFile: 'DEFAULT_SUITE_EMPTY_FILE',
  countMismatch: 'DEFAULT_SUITE_ASSERTION_COUNTS_MISMATCH',
} as const

export interface PendingReportFileResult {
  name: string
  status: string
  assertionResults: { status: string }[]
}

export interface PendingReport {
  success: boolean
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numPendingTests: number
  numTodoTests: number
  testResults: PendingReportFileResult[]
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A skipped assertion carries no `result` at all, so `mode` — not `result.state`
 * — is the only reliable signal: `it.skip`, `it.runIf(false)` and
 * `describe.skipIf(false)` all push `mode: 'skip'` onto every collected child,
 * while `it.todo` uses `mode: 'todo'`. Only those two are silent: neither turns
 * the run red, which is exactly the hole this gate closes.
 */
export function collectFileAssertions(task: unknown, collected: { status: string }[] = []): { status: string }[] {
  if (!object(task)) return collected
  if (task.type === 'test') {
    const state = object(task.result) && typeof task.result.state === 'string' ? task.result.state : undefined
    collected.push({ status: task.mode === 'todo' ? 'todo' : task.mode === 'skip' ? 'pending' : state === 'fail' ? 'failed' : 'passed' })
    return collected
  }
  const tasks = Array.isArray(task.tasks) ? task.tasks : []
  for (const child of tasks) collectFileAssertions(child, collected)
  return collected
}

/** Vitest's `TestModule[]` in the same JSON-report shape the isolated launchers validate. */
export function buildPendingReport(modules: ReadonlyArray<TestModule>): PendingReport {
  const testResults: PendingReportFileResult[] = modules.map(module => {
    // Vitest 4's TestModule nests the file suite under `task`; `tasks` on the
    // module itself is empty and would silently report zero assertions.
    const file = module as unknown as { filepath?: string; moduleId?: string; task?: unknown }
    const name = file.filepath ?? file.moduleId ?? '<unknown>'
    const assertionResults: { status: string }[] = []
    collectFileAssertions(file.task, assertionResults)
    const statuses = new Set(assertionResults.map(assertion => assertion.status))
    return {
      name,
      status: statuses.has('failed') ? 'failed' : 'passed',
      assertionResults,
    }
  })
  const statuses = testResults.flatMap(result => result.assertionResults.map(assertion => assertion.status))
  const count = (status: string) => statuses.filter(value => value === status).length
  return {
    success: testResults.every(result => result.status === 'passed'),
    numTotalTests: statuses.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    // Vitest's own `numPendingTests` folds skipped and pending together; the
    // isolated launchers assert on `numPendingTests === 0`, so keep parity.
    numPendingTests: statuses.filter(status => status === 'pending' || status === 'skipped').length,
    numTodoTests: count('todo'),
    testResults,
  }
}

export function normalizeReportPath(name: string, root: string): string {
  const normalized = name.replaceAll('\\', '/')
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/u, '')}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

const allowanceIndex = (allowances: readonly DefaultSuitePendingAllowance[]) => new Map(allowances.map(allowance => [allowance.file, allowance]))

/** A binding counts as provided only if it is set to something non-blank. */
function bindingProvided(environment: NodeJS.ProcessEnv, binding: string): boolean {
  const value = environment[binding]
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Fails closed on any pending or todo assertion that is not covered by an
 * explicit allowance with the exact declared count. Raising a number in
 * `DEFAULT_SUITE_PENDING_ALLOWANCES` is therefore a reviewed, reasoned change
 * rather than an edit that makes a red run green.
 *
 * It also fails closed in the other direction. An allowance is a claim with two
 * halves: "this file is skipped here" and "the assertion still exists". Only
 * checking the first half leaves a stale entry — the file keeps a skip-gated
 * assertion removed, its `pending` count drops to 0, and because the loop below
 * only walks files that *reported* pending, the entry is never inspected again.
 * It then advertises a reviewed exemption that no longer exists.
 *
 * A declared allowance is honoured only when the file it names reported exactly
 * `pending` pending assertions in this run. Three cases are therefore treated
 * differently:
 *   - file absent from the report: not a zombie. A partial run (`npx vitest run
 *     <file>`, one shard of `run-safe-tests-sharded.ts`) collects a subset, so
 *     absence says nothing about the entry; `unobservedAllowances` owns
 *     whole-suite scope.
 *   - file collected, 0 pending, the declared `binding` present in the
 *     environment: not a zombie either. The assertion did not skip — it ran for
 *     real because this run supplied the binding (the CI PostgreSQL acceptance
 *     step does exactly this), so the declared exemption is simply inactive
 *     here.
 *   - file collected, 0 pending, the declared `binding` absent: the file should
 *     have skipped and reported `pending`, and did not. The skip gate was
 *     removed; the allowance is dead.
 */
export function validatePendingReport(
  value: unknown,
  root: string,
  allowances: readonly DefaultSuitePendingAllowance[] = DEFAULT_SUITE_PENDING_ALLOWANCES,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const allowanceByFile = allowanceIndex(allowances)
  if (!object(value) || !Array.isArray(value.testResults)) return [PENDING_GATE_ERROR_CODES.reportMissing]
  // `success` is deliberately not re-checked: a failed assertion already fails
  // the run that produced the report. This gate owns only the silent signal.
  const errors: string[] = []
  if ((value.numTodoTests ?? 0) !== 0) errors.push(PENDING_GATE_ERROR_CODES.todo)

  let observedTotal = 0
  let observedPassed = 0
  const observedPending = new Map<string, number>()
  const collectedFiles = new Set<string>()
  for (const item of value.testResults) {
    if (!object(item) || typeof item.name !== 'string' || !Array.isArray(item.assertionResults)) {
      errors.push(PENDING_GATE_ERROR_CODES.reportMissing)
      continue
    }
    const file = normalizeReportPath(item.name, root)
    collectedFiles.add(file)
    const assertions = item.assertionResults as { status?: unknown }[]
    if (assertions.length === 0) errors.push(`${PENDING_GATE_ERROR_CODES.emptyFile}:${file}`)
    for (const assertion of assertions) {
      observedTotal += 1
      const status = object(assertion) ? assertion.status : undefined
      if (status === 'passed') observedPassed += 1
      if (status === 'pending' || status === 'skipped') observedPending.set(file, (observedPending.get(file) ?? 0) + 1)
    }
  }

  for (const [file, pending] of observedPending) {
    const allowance = allowanceByFile.get(file)
    if (!allowance) {
      errors.push(`${PENDING_GATE_ERROR_CODES.unexpectedPending}:${file} (${pending})`)
      continue
    }
    if (allowance.pending !== pending) {
      errors.push(`${PENDING_GATE_ERROR_CODES.pendingCountDrift}:${file} expected ${allowance.pending}, observed ${pending}`)
    }
  }

  // The reverse direction: an allowance whose file was collected but reported no
  // pending assertion at all while the binding it names is missing. See the
  // function comment for why an absent file and a present binding are excluded.
  for (const allowance of allowances) {
    if (!collectedFiles.has(allowance.file)) continue
    if ((observedPending.get(allowance.file) ?? 0) !== 0) continue
    if (bindingProvided(environment, allowance.binding)) continue
    errors.push(
      `${PENDING_GATE_ERROR_CODES.staleAllowance}:${allowance.file} declares ${allowance.pending} pending assertion(s) but reported 0 `
      + `while ${allowance.binding} is unset — the skip gate is gone, delete the allowance or restore the assertion`,
    )
  }

  // Self-consistency: the summary fields must describe the assertion results.
  const reportedPending = value.numPendingTests ?? 0
  const declaredPending = [...observedPending.values()].reduce((sum, pending) => sum + pending, 0)
  if (value.numTotalTests !== observedTotal || value.numPassedTests !== observedPassed || reportedPending !== declaredPending) {
    errors.push(PENDING_GATE_ERROR_CODES.countMismatch)
  }
  return [...new Set(errors)]
}

/** Allowances this report never observed; only meaningful for a whole-suite run. */
export function unobservedAllowances(
  value: unknown,
  root: string,
  allowances: readonly DefaultSuitePendingAllowance[] = DEFAULT_SUITE_PENDING_ALLOWANCES,
): string[] {
  if (!object(value) || !Array.isArray(value.testResults)) return []
  const observed = new Set(value.testResults
    .filter(item => object(item) && typeof item.name === 'string')
    .map(item => normalizeReportPath((item as { name: string }).name, root)))
  return allowances.map(allowance => allowance.file).filter(file => !observed.has(file))
}

export function formatPendingGateFailure(errors: readonly string[]): string {
  const lines = [
    'The default test suite reported assertions that never executed, or an allowance no longer matches reality.',
    'Each pending assertion must be declared in DEFAULT_SUITE_PENDING_ALLOWANCES (tests/test-suite-isolation.ts)',
    'with the exact count, the reason it cannot run here, and the entrypoint that does run it.',
    'An allowance whose file ran without skipping is stale and must be removed.',
    '  - <file> (n): pending assertion no allowance declares',
    '  - <file> expected N, observed M: declared count drift',
    '  - <file> declares N but reported 0: stale allowance',
  ]
  for (const error of errors) lines.push(`  - ${error}`)
  return lines.join('\n')
}

/**
 * Runs inside the Vitest main process. Throwing here fails the run, so a
 * silently skipped assertion can no longer be reported as green.
 */
export default class PendingAssertionGateReporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const root = process.cwd()
    const report = buildPendingReport(testModules)
    const errors = validatePendingReport(report, root)
    if (errors.length === 0) {
      const withPending = report.testResults.filter(file => file.assertionResults.some(assertion => assertion.status === 'pending'))
      if (withPending.length > 0) {
        console.error(`[pending-gate] ${report.numPendingTests} declared pending assertion(s) across ${withPending.length} allow-listed file(s)`)
      }
      return
    }
    console.error(formatPendingGateFailure(errors))
    throw new Error(PENDING_GATE_ERROR_CODES.unexpectedPending)
  }
}
