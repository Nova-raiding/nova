import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// This audit-only harness requires the explicitly provisioned disposable
// container. It never falls back to the running merchant business database.
const container = 'merchant-audit-pg-20260907'
const inspected = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
if (inspected.Config.Labels?.['merchant.audit.run'] !== '2026-09-07') throw new Error('audit container label mismatch')
const port = inspected.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort
if (!port) throw new Error('audit PostgreSQL loopback port is unavailable')
const environment = Object.fromEntries(inspected.Config.Env.map(value => {
  const index = value.indexOf('=')
  return [value.slice(0, index), value.slice(index + 1)]
}))
execFileSync('docker', ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'merchant', '-d', 'merchant'], {
  input: readFileSync('infra/local/ensure-app-role.sql', 'utf8'), stdio: ['pipe', 'ignore', 'pipe'],
})
const connection = new URL(`postgres://127.0.0.1:${port}/merchant`)
connection.username = environment.POSTGRES_USER
connection.password = environment.POSTGRES_PASSWORD
const selected = process.argv.slice(2)
const files = selected.length ? selected : [
  'packages/persistence/src/billing-repository.postgres.test.ts',
  'packages/persistence/src/authorization-rls-boundary.postgres.test.ts',
  'packages/persistence/src/authorization-repository.release.postgres.test.ts',
  'packages/persistence/src/product-rls-tenant-boundary.postgres.test.ts',
  'tests/postgres-rls-attack-matrix.test.ts',
  'packages/persistence/src/migration-109-release.postgres.test.ts',
]
if (files.some(file => !/^(?:packages|apps|tests)\/[A-Za-z0-9_./-]+\.test\.ts$/u.test(file) || file.includes('..'))) throw new Error('invalid audit test path')
const report = resolve(`artifacts/audit-2026-09-07/runtime/postgres-${Date.now()}.json`)
console.log(JSON.stringify({ container, postgresVersion: inspected.Config.Image, tests: files, evidence: report, businessDatabaseAccess: false }))
const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', ...files, '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile=${report}`], {
  env: { ...process.env, PERSISTENCE_RELEASE_DATABASE_URL: connection.toString(), NODE_ENV: 'test' }, stdio: 'inherit',
})
const document = JSON.parse(readFileSync(report, 'utf8'))
const assertions = document.testResults.flatMap(file => file.assertionResults ?? [])
const notExecuted = assertions.filter(item => item.status !== 'passed' && item.status !== 'failed')
console.log(JSON.stringify({ files: document.testResults.length, passed: document.numPassedTests, failed: document.numFailedTests, notExecuted: notExecuted.length, expectedFiles: files.length }))
process.exitCode = result.status === 0 && document.testResults.length === files.length && assertions.length > 0 && notExecuted.length === 0 ? 0 : 1
