import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CI_POSTGRES_ACCEPTANCE_STEP,
  DEFAULT_SUITE_PENDING_ALLOWANCES,
  NON_HERMETIC_TEST_FILES,
  type DefaultSuitePendingAllowance,
} from './test-suite-isolation.js'
import { ALL_POSTGRES_TEST_FILES } from '../vitest.postgres.config.js'
import {
  buildPendingReport,
  normalizeReportPath,
  unobservedAllowances,
  validatePendingReport,
} from '../scripts/pending-assertion-gate.js'

const root = resolve(import.meta.dirname, '..')
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')

/** The explicit Vitest file list of the CI PostgreSQL acceptance step. */
function ciPostgresStepFiles(): string[] {
  const start = workflow.indexOf(CI_POSTGRES_ACCEPTANCE_STEP)
  expect(start, `the CI step "${CI_POSTGRES_ACCEPTANCE_STEP}" must exist`).toBeGreaterThan(-1)
  const end = workflow.indexOf('- name:', start)
  return [...workflow.slice(start, end).matchAll(/^\s{10}(\S+\.test\.ts)\s*$/gmu)].map(match => match[1]!)
}

/** Environment keys the same CI step binds. */
function ciPostgresStepBindings(): Set<string> {
  const start = workflow.indexOf(CI_POSTGRES_ACCEPTANCE_STEP)
  const end = workflow.indexOf('run: >-', start)
  const block = workflow.slice(start, end)
  return new Set([...block.matchAll(/^\s{10}([A-Z][A-Z0-9_]+):/gmu)].map(match => match[1]!))
}

function pendingReport(entries: readonly { name: string; statuses: string[] }[], overrides: Record<string, unknown> = {}) {
  const statuses = entries.flatMap(entry => entry.statuses)
  const count = (wanted: string) => statuses.filter(status => status === wanted).length
  return {
    success: true,
    numTotalTests: statuses.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: statuses.filter(status => status === 'pending' || status === 'skipped').length,
    numTodoTests: count('todo'),
    testResults: entries.map(entry => ({
      name: `${root}/${entry.name}`,
      status: 'passed',
      assertionResults: entry.statuses.map(status => ({ status })),
    })),
    ...overrides,
  }
}

const allowance: DefaultSuitePendingAllowance = {
  file: 'packages/persistence/src/example.test.ts',
  pending: 1,
  binding: 'PERSISTENCE_RELEASE_DATABASE_URL',
  executedBy: CI_POSTGRES_ACCEPTANCE_STEP,
}

describe('default suite pending-assertion gate', () => {
  it('normalizes absolute Vitest module paths to repository-relative ones', () => {
    expect(normalizeReportPath(`${root}/tests/a.test.ts`, root)).toBe('tests/a.test.ts')
    expect(normalizeReportPath('/elsewhere/tests/a.test.ts', root)).toBe('/elsewhere/tests/a.test.ts')
  })

  it('fails on a skipped assertion that no allowance declares', () => {
    const report = pendingReport([{ name: 'tests/unregistered.test.ts', statuses: ['passed', 'pending'] }])
    expect(validatePendingReport(report, root)).toEqual([
      'DEFAULT_SUITE_UNEXPECTED_PENDING_ASSERTIONS:tests/unregistered.test.ts (1)',
    ])
  })

  it('fails on a todo assertion, which is never an acceptable skip', () => {
    const report = pendingReport([{ name: 'tests/todo.test.ts', statuses: ['passed', 'todo'] }])
    expect(validatePendingReport(report, root)).toContain('DEFAULT_SUITE_TODO_ASSERTIONS')
  })

  it('fails on a collected file that executed no assertion at all', () => {
    const report = pendingReport([{ name: 'tests/empty.test.ts', statuses: [] }])
    expect(validatePendingReport(report, root)).toContain('DEFAULT_SUITE_EMPTY_FILE:tests/empty.test.ts')
  })

  it('fails when a declared allowance drifts from the observed pending count', () => {
    // Raising the number without a reason is the exact edit the gate must reject.
    const report = pendingReport([{ name: allowance.file, statuses: ['passed', 'pending', 'pending'] }])
    const errors = validatePendingReport(report, root, [allowance])
    expect(errors).toEqual(['DEFAULT_SUITE_PENDING_COUNT_DRIFT:packages/persistence/src/example.test.ts expected 1, observed 2'])
  })

  it('fails a declared allowance whose file ran without skipping, because the skip gate is gone', () => {
    // The file is collected and every assertion executes: the `postgresIt` block
    // it was granted an allowance for has been removed (or the binding is no
    // longer needed), so the entry now advertises an exemption that does not
    // exist. Nothing else in the report mentions it, which is exactly why the
    // pre-fix gate never looked at the entry again.
    const report = pendingReport([{ name: allowance.file, statuses: ['passed', 'passed'] }])
    const errors = validatePendingReport(report, root, [allowance], {})
    expect(errors).toHaveLength(1)
    const [message] = errors
    expect(message).toContain('DEFAULT_SUITE_STALE_PENDING_ALLOWANCE')
    expect(message, 'must name the file').toContain(allowance.file)
    expect(message, 'must state the declared count').toContain('declares 1')
    expect(message, 'must state the observed count').toContain('reported 0')
    expect(message, 'must name the missing binding').toContain(allowance.binding)
  })

  it('accepts an allowance whose file ran for real because this run supplied the binding', () => {
    // The CI PostgreSQL acceptance step binds the variable and runs these exact
    // files. There the assertions execute instead of skipping, and an allowance
    // that reports 0 pending is inert rather than stale. Punishing that would
    // make the gate fail the very run that proves the assertions did execute.
    const report = pendingReport([{ name: allowance.file, statuses: ['passed', 'passed'] }])
    expect(validatePendingReport(report, root, [allowance], { [allowance.binding]: 'postgres://merchant@127.0.0.1:5432/merchant' })).toEqual([])
    // A blank binding is not a supplied binding; the file still skips.
    expect(validatePendingReport(report, root, [allowance], { [allowance.binding]: '   ' })).toHaveLength(1)
  })

  it('does not confuse a partial run that never collected the file with a stale allowance', () => {
    // `npx vitest run <one file>` and each shard of run-safe-tests-sharded.ts
    // collect a subset of the suite. A file absent from the report says nothing
    // about whether its skip gate still exists, so it must not be reported here.
    const report = pendingReport([{ name: 'tests/collected-instead.test.ts', statuses: ['passed'] }])
    expect(validatePendingReport(report, root, [allowance], {})).toEqual([])
  })

  it('fails when a summary field disagrees with the assertion results', () => {
    const report = pendingReport([{ name: allowance.file, statuses: ['passed', 'pending'] }], { numPendingTests: 0 })
    expect(validatePendingReport(report, root, [allowance])).toContain('DEFAULT_SUITE_ASSERTION_COUNTS_MISMATCH')
  })

  it('fails for a malformed report instead of reporting success', () => {
    for (const value of [{}, null, { testResults: [] }, { testResults: [{ name: 'x' }] }]) {
      expect(validatePendingReport(value, root).length, JSON.stringify(value)).toBeGreaterThan(0)
    }
  })

  it('accepts an allowance that matches the observed count and binding exactly', () => {
    const report = pendingReport([{ name: allowance.file, statuses: ['passed', 'pending'] }])
    expect(validatePendingReport(report, root, [allowance])).toEqual([])
  })

  it('reports allowances that a whole-suite run never observed', () => {
    const report = pendingReport([{ name: 'tests/only.test.ts', statuses: ['passed'] }])
    expect(unobservedAllowances(report, root, [allowance])).toEqual([allowance.file])
    expect(unobservedAllowances(pendingReport([{ name: allowance.file, statuses: ['pending'] }]), root, [allowance])).toEqual([])
  })

  it('maps Vitest skip and todo task modes to pending and todo assertions', () => {
    const report = buildPendingReport([{
      filepath: `${root}/tests/module.test.ts`,
      task: {
        type: 'suite',
        tasks: [
          { type: 'test', mode: 'run', result: { state: 'pass' } },
          { type: 'test', mode: 'skip' },
          { type: 'test', mode: 'todo' },
          { type: 'test', mode: 'run', result: { state: 'fail' } },
        ],
      },
    }] as never)
    expect(report.numTotalTests).toBe(4)
    expect(report.numPassedTests).toBe(1)
    expect(report.numFailedTests).toBe(1)
    expect(report.numPendingTests).toBe(1)
    expect(report.numTodoTests).toBe(1)
    expect(report.testResults[0]?.name).toBe(`${root}/tests/module.test.ts`)
  })

  it('keeps every allowance unique, reasoned, and outside the isolated manifest', () => {
    const files = DEFAULT_SUITE_PENDING_ALLOWANCES.map(entry => entry.file)
    expect(new Set(files).size).toBe(files.length)
    expect(files.length).toBeGreaterThan(0)
    for (const entry of DEFAULT_SUITE_PENDING_ALLOWANCES) {
      expect(Number.isInteger(entry.pending) && entry.pending > 0, entry.file).toBe(true)
      expect(entry.binding, entry.file).toMatch(/^[A-Z][A-Z0-9_]+$/u)
      expect(entry.executedBy.trim().length, entry.file).toBeGreaterThan(0)
      // A manifest entry would be excluded from the default suite, so it could
      // never report a pending assertion there.
      expect(NON_HERMETIC_TEST_FILES as readonly string[], entry.file).not.toContain(entry.file)
    }
  })

  it('only allows a pending assertion whose source really contains a skip gate', () => {
    for (const entry of DEFAULT_SUITE_PENDING_ALLOWANCES) {
      const source = readFileSync(resolve(root, entry.file), 'utf8')
      expect(/it\.skip|skipIf|\? it : it\.skip|postgresIt/u.test(source), entry.file).toBe(true)
      expect(source, entry.file).toContain(entry.binding)
    }
  })

  it('binds every pending database allowance from a local entrypoint, not only CI', () => {
    // CI is one execution environment, not the only one that may certify these
    // assertions. Before this existed, a binding only CI set was a binding that
    // could never be exercised on a developer machine, so the file's whole
    // PostgreSQL half was unverifiable locally.
    const scripts = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['test:postgres:all-local']).toContain('scripts/run-isolated-postgres-tests.ts')
    expect(scripts['test:postgres:all-local']).toContain('--all')
    const runner = readFileSync(resolve(root, 'scripts/run-isolated-postgres-tests.ts'), 'utf8')
    for (const binding of new Set(DEFAULT_SUITE_PENDING_ALLOWANCES.map(entry => entry.binding))) {
      expect(runner, `the local full-surface launcher must bind ${binding}`).toContain(binding)
    }
    // And the local denominator must actually contain the files: a binding with
    // no file selected is as unverifiable as no binding at all.
    for (const entry of DEFAULT_SUITE_PENDING_ALLOWANCES) {
      expect(ALL_POSTGRES_TEST_FILES, `${entry.file} must be selected by --all`).toContain(entry.file)
    }
  })

  it('only allows a pending assertion that another entrypoint really executes', () => {
    const ciFiles = new Set(ciPostgresStepFiles())
    const ciBindings = ciPostgresStepBindings()
    const packageScripts = Object.values((JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts).join('\n')
    for (const entry of DEFAULT_SUITE_PENDING_ALLOWANCES) {
      if (entry.executedBy === CI_POSTGRES_ACCEPTANCE_STEP) {
        // Both halves matter: the step must bind the missing variable and must
        // actually name the file. An allowance pointing at a step that no longer
        // runs the file is a hidden skip, not a declared one.
        expect(ciBindings.has(entry.binding), `${entry.file} needs ${entry.binding} in the CI step`).toBe(true)
        expect(ciFiles.has(entry.file), `${entry.file} must be listed in the CI PostgreSQL acceptance step`).toBe(true)
        continue
      }
      expect(packageScripts, `${entry.file} executedBy ${entry.executedBy}`).toContain(entry.executedBy)
    }
  })
})
