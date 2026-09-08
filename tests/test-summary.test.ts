import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildTestSummary, summarizeVitestReport } from './test-summary.js'

type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo'
function report(files: Status[][]) {
  const statuses = files.flat()
  return {
    success: !statuses.includes('failed'),
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter(status => status === 'passed').length,
    numFailedTests: statuses.filter(status => status === 'failed').length,
    numPendingTests: statuses.filter(status => status === 'skipped' || status === 'pending').length,
    numTodoTests: statuses.filter(status => status === 'todo').length,
    // Vitest JSON marks all-skipped and all-todo files as passed.
    testResults: files.map(statuses => ({ status: statuses.includes('failed') ? 'failed' : 'passed', assertionResults: statuses.map(status => ({ status })) })),
  }
}
const success = { status: 0, signal: null }
const evidence = { directory: '/evidence/run-unique', vitestReport: '/evidence/run-unique/vitest.json', vitestStdout: '/evidence/run-unique/vitest.stdout.log', vitestStderr: '/evidence/run-unique/vitest.stderr.log', smokeStdout: '/evidence/run-unique/http-smoke.stdout.log', smokeStderr: '/evidence/run-unique/http-smoke.stderr.log', summary: '/evidence/run-unique/summary.json' }
const smoke = { profile: 'pilot_50_http_fake', transport: 'real_http', connectorMode: 'fake', cloudGate: false, workspaces: 50, requests: 300, duplicatePublishRequests: 100, acceptedPublishJobs: 100, uniquePublishJobs: 50, duplicateWrites: 50, errors: [] }
const input = () => ({ reportText: JSON.stringify(report([['passed']])), smokeStdout: JSON.stringify(smoke), testRun: success, smokeRun: success, evidence })

// All children are temporary fixtures. These tests never start the real suite,
// smoke server, Docker, a database, or a provider connection.
function prepareCliFixtures(root: string, rawReport: string, smokeExitCode = 0) {
  mkdirSync(join(root, 'node_modules/vitest'), { recursive: true })
  mkdirSync(join(root, 'node_modules/tsx/dist'), { recursive: true })
  const capture = `import { existsSync, writeFileSync } from 'node:fs';
    function capture(kind) { writeFileSync(${JSON.stringify(join(root, 'child-'))} + kind + '.json', JSON.stringify({ args: process.argv.slice(2), env: process.env, storageExists: existsSync(process.env.ASSET_STORAGE_ROOT ?? '') })); }
    function report() { const output = process.argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length); writeFileSync(output, ${JSON.stringify(rawReport)}); console.log('vitest fixture output'); }`
  writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), `${capture}; capture('vitest'); report();`)
  writeFileSync(join(root, 'node_modules/tsx/dist/cli.mjs'), `${capture};
    if (process.argv[2]?.endsWith('/scripts/run-safe-tests.ts')) { capture('vitest'); report(); }
    else { capture('smoke'); console.log(${JSON.stringify(JSON.stringify(smoke))}); process.exitCode = ${smokeExitCode}; }`)
}

describe('test summary evidence', () => {
  it('separates executed, skipped, pending and todo assertions and does not label skipped files passed', () => {
    const counts = summarizeVitestReport(report([['passed', 'skipped'], ['skipped'], ['todo'], ['pending'], ['failed']]))
    expect(counts.tests).toEqual({ total: 6, executed: 2, passed: 1, failed: 1, skipped: 2, pending: 1, todo: 1, notExecuted: 4 })
    expect(counts.testFiles).toEqual({ total: 5, executed: 2, passed: 1, failed: 1, skipped: 1, pending: 1, todo: 1, empty: 0 })
  })

  it('retains failed file setup when its assertions never ran', () => {
    const value = report([['passed'], []])
    value.testResults[1]!.status = 'failed'
    value.success = false
    const result = buildTestSummary({ ...input(), reportText: JSON.stringify(value) })
    expect(result.status).toBe('fail')
    expect(result.testFiles).toMatchObject({ failed: 1, passed: 1 })
    expect(result.tests).toMatchObject({ executed: 1, failed: 0 })
  })

  it.each([undefined, '', '{bad json', '{}', 'null', JSON.stringify({ ...report([['passed']]), numTotalTests: 99 }), JSON.stringify({ ...report([['passed']]), numPassedTests: -1 })])('fails closed for missing or invalid report %s', reportText => {
    const result = buildTestSummary({ ...input(), reportText })
    expect(result.status).toBe('fail')
    expect(result.tests).toBeNull()
    expect(result.executionComplete).toBe(false)
    expect(result.errors.reportErrors.length).toBeGreaterThan(0)
  })

  it('rejects unknown assertion states instead of counting them as success', () => {
    const value = report([['passed']])
    expect(() => summarizeVitestReport({ ...value, testResults: [{ status: 'passed', assertionResults: [{ status: 'unknown' }] }] })).toThrow('unknown assertion status')
  })

  it('reports a partially executed suite with skips without claiming complete execution', () => {
    const result = buildTestSummary({ ...input(), reportText: JSON.stringify(report([['passed', 'skipped', 'todo']])) })
    expect(result.status).toBe('partial')
    expect(result.executionComplete).toBe(false)
    expect(result.tests).toMatchObject({ executed: 1, notExecuted: 2 })
  })

  it.each([{ files: [['skipped']] as Status[][] }, { files: [[]] as Status[][] }, { files: [['passed', 'pending']] as Status[][] }])('fails when no assertions executed or execution remains pending: $files', ({ files }) => {
    expect(buildTestSummary({ ...input(), reportText: JSON.stringify(report(files)) }).status).toBe('fail')
  })

  it.each(['', '{bad json', JSON.stringify({ ...smoke, requests: 0 }), JSON.stringify({ ...smoke, errors: null })])('fails closed on unavailable or malformed smoke evidence %s', smokeStdout => {
    const result = buildTestSummary({ ...input(), smokeStdout })
    expect(result.status).toBe('fail')
    expect(result.loadProfile).toBeNull()
    expect(result.errors.reportErrors.length).toBeGreaterThan(0)
  })

  it('preserves subprocess failures and termination even if report JSON looks successful', () => {
    const result = buildTestSummary({ ...input(), testRun: { status: null, signal: 'SIGTERM', error: new Error('spawn EACCES') }, smokeRun: { status: 2, signal: null } })
    expect(result.status).toBe('fail')
    expect(result.errors.childErrors).toEqual(expect.arrayContaining(['Vitest could not complete: spawn EACCES', 'Vitest terminated by SIGTERM', 'Vitest exit code: unavailable', 'HTTP smoke exit code: 2']))
  })

  it('retains the unique raw report and child log paths for traceable successful evidence', () => {
    const result = buildTestSummary({ ...input(), smokeStdout: `diagnostic line\n${JSON.stringify(smoke)}\n` })
    expect(result.status).toBe('pass')
    expect(result.executionComplete).toBe(true)
    expect(result.evidence).toEqual(evidence)
    expect(result.loadProfile).toMatchObject({ transport: 'real_http', connectorMode: 'fake', cloudGate: false })
  })

  it('runs the CLI with isolated child fixtures and preserves raw reports in distinct run directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-summary-cli-'))
    const rawReport = JSON.stringify(report([['passed', 'skipped']]))
    try {
      prepareCliFixtures(root, rawReport)
      const directories = new Set<string>()
      for (let attempt = 0; attempt < 2; attempt++) {
        const run = spawnSync(process.execPath, [resolve(import.meta.dirname, '../node_modules/tsx/dist/cli.mjs'), resolve(import.meta.dirname, 'test-summary.ts')], {
          cwd: root, encoding: 'utf8', env: { ...process.env, TEST_SUMMARY_ARTIFACT_DIR: join(root, 'evidence') }, timeout: 10_000,
        })
        expect(run.status, run.stderr).toBe(0)
        const summary = JSON.parse(run.stdout)
        expect(summary.status).toBe('partial')
        expect(summary.tests).toMatchObject({ executed: 1, skipped: 1 })
        directories.add(summary.evidence.directory)
        expect(readFileSync(summary.evidence.vitestReport, 'utf8')).toBe(rawReport)
        expect(readFileSync(summary.evidence.vitestStdout, 'utf8')).toContain('vitest fixture output')
        expect(JSON.parse(readFileSync(summary.evidence.summary, 'utf8'))).toEqual(summary)
      }
      expect(directories.size).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([0, 7])('routes Vitest through the safe launcher and isolates/cleans smoke storage even after child exit %s', smokeExitCode => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-summary-isolation-')))
    const inheritedStorage = join(root, 'inherited-business-assets')
    const rawReport = JSON.stringify(report([['passed', 'skipped']]))
    try {
      mkdirSync(inheritedStorage)
      writeFileSync(join(inheritedStorage, 'retain.txt'), 'untouched')
      prepareCliFixtures(root, rawReport, smokeExitCode)
      const run = spawnSync(process.execPath, [resolve(import.meta.dirname, '../node_modules/tsx/dist/cli.mjs'), resolve(import.meta.dirname, 'test-summary.ts')], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, NODE_ENV: 'production', TEST_SUMMARY_ARTIFACT_DIR: join(root, 'evidence'), ASSET_STORAGE_ROOT: inheritedStorage,
          EXECUTE: 'true', KUBECONFIG: '/fixture/shared-kube', DATABASE_URL: 'postgres://fixture.invalid/shared', REDIS_URL: 'redis://fixture.invalid',
          PERSISTENCE_RELEASE_DATABASE_URL: 'postgres://fixture.invalid/release', MODEL_RELAY_API_KEY: 'fixture-not-a-secret', OPS_BASE_URL: 'https://fixture.invalid', MERCHANT_TEST_APPROVED_RATES: 'inherited-value-must-not-pass' },
      })
      expect(run.status, run.stderr).toBe(smokeExitCode === 0 ? 0 : 1)
      const summary = JSON.parse(run.stdout)
      expect(summary.status).toBe(smokeExitCode === 0 ? 'partial' : 'fail')
      expect(summary.tests).toMatchObject({ total: 2, executed: 1, passed: 1, skipped: 1 })
      expect(summary.errors.smokeExitCode).toBe(smokeExitCode)
      const vitest = JSON.parse(readFileSync(join(root, 'child-vitest.json'), 'utf8'))
      expect(vitest.args[0]).toBe(join(root, 'scripts/run-safe-tests.ts'))
      expect(vitest.args).toContain(`--outputFile=${summary.evidence.vitestReport}`)
      for (const kind of ['vitest', 'smoke']) {
        const child = JSON.parse(readFileSync(join(root, `child-${kind}.json`), 'utf8'))
        expect(child.env.NODE_ENV).toBe('test')
        expect(child.env.MERCHANT_TEST_APPROVED_RATES).toBe(kind === 'smoke' ? 'true' : undefined)
        for (const key of ['EXECUTE', 'KUBECONFIG', 'DATABASE_URL', 'REDIS_URL', 'PERSISTENCE_RELEASE_DATABASE_URL', 'MODEL_RELAY_API_KEY', 'OPS_BASE_URL', 'TEST_SUMMARY_ARTIFACT_DIR', 'NODE_OPTIONS']) expect(child.env[key]).toBeUndefined()
        expect(child.env.ASSET_STORAGE_ROOT).not.toBe(inheritedStorage)
        expect(child.env.ASSET_STORAGE_ROOT).toMatch(/merchant-test-summary-smoke-/u)
        expect(child.storageExists).toBe(true)
        expect(existsSync(child.env.ASSET_STORAGE_ROOT)).toBe(false)
      }
      expect(readFileSync(join(inheritedStorage, 'retain.txt'), 'utf8')).toBe('untouched')
      expect(readFileSync(summary.evidence.vitestReport, 'utf8')).toBe(rawReport)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
