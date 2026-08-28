import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type VitestReport = { numTotalTestSuites?: number; numPassedTestSuites?: number; numFailedTestSuites?: number; numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; testResults?: Array<{ status?: string; assertionResults?: Array<{ status?: string }> }> }
type SmokeSummary = { profile: string; transport: string; connectorMode: string; cloudGate: boolean; workspaces: number; requests: number; duplicatePublishRequests: number; acceptedPublishJobs: number; uniquePublishJobs: number; duplicateWrites: number; errors: unknown[] }

const root = process.cwd()
const reportPath = join(tmpdir(), `merchant-vitest-${process.pid}.json`)
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const testRun = spawnSync(process.execPath, [vitest, 'run', '--reporter=json', `--outputFile=${reportPath}`], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } })
let report: VitestReport = {}
if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8')) as VitestReport

const smoke = spawnSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'tests/http-load-smoke.ts')], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } })
const smokeLines = smoke.stdout.trim().split('\n').filter(Boolean)
const load = (smokeLines.length ? JSON.parse(smokeLines.at(-1)!) : { profile: 'unavailable', transport: 'unknown', connectorMode: 'unknown', cloudGate: false, workspaces: 0, requests: 0, duplicatePublishRequests: 0, acceptedPublishJobs: 0, uniquePublishJobs: 0, duplicateWrites: 0, errors: ['smoke did not emit a summary'] }) as SmokeSummary
const failedAssertions = report.testResults?.reduce((sum, file) => sum + (file.assertionResults?.filter(assertion => assertion.status === 'failed').length ?? 0), 0) ?? report.numFailedTests ?? 0
const testFiles = report.testResults ?? []
const summary = {
  testFiles: { total: testFiles.length || report.numTotalTestSuites || 0, passed: testFiles.filter(file => file.status === 'passed').length, failed: testFiles.filter(file => file.status === 'failed').length },
  tests: { total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0, failed: failedAssertions },
  loadProfile: { name: load.profile, transport: load.transport, connectorMode: load.connectorMode, cloudGate: load.cloudGate, workspaces: load.workspaces, requests: load.requests },
  duplicateWrites: { publishRequests: load.duplicatePublishRequests, acceptedResponses: load.acceptedPublishJobs, uniquePublishJobs: load.uniquePublishJobs, deduplicatedWrites: load.duplicateWrites },
  errors: { vitestExitCode: testRun.status ?? 1, smokeExitCode: smoke.status ?? 1, testFailures: failedAssertions, smokeErrors: load.errors },
}
console.log(JSON.stringify(summary, null, 2))
rmSync(reportPath, { force: true })
if ((testRun.status ?? 1) !== 0 || (smoke.status ?? 1) !== 0) process.exitCode = 1
