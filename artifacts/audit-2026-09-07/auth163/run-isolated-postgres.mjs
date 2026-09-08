import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// No fallback to any shared database. This container belongs only to this run.
const container = 'merchant-auth163-pg-20260907'
const inspected = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
if (inspected.Config.Labels?.['merchant.audit.run'] !== '2026-09-07'
  || inspected.Config.Labels?.['merchant.audit.phase'] !== 'auth163'
  || inspected.HostConfig.AutoRemove !== true) throw new Error('isolated container identity mismatch')
const binding = inspected.NetworkSettings.Ports['5432/tcp']?.[0]
if (!binding?.HostPort || binding.HostIp !== '127.0.0.1') throw new Error('isolated PostgreSQL loopback binding missing')
const environment = Object.fromEntries(inspected.Config.Env.map(value => {
  const index = value.indexOf('=')
  return [value.slice(0, index), value.slice(index + 1)]
}))
execFileSync('docker', ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'merchant', '-d', 'merchant'], {
  input: readFileSync('infra/local/ensure-app-role.sql', 'utf8'), stdio: ['pipe', 'ignore', 'pipe'],
})
const postgresVersion = execFileSync('docker', ['exec', container, 'psql', '-At', '-U', 'merchant', '-d', 'merchant', '-c', 'SHOW server_version'], { encoding: 'utf8' }).trim()
if (!postgresVersion.startsWith('17.')) throw new Error('PostgreSQL version does not match CI major 17')
const connection = new URL(`postgres://127.0.0.1:${binding.HostPort}/merchant`)
connection.username = environment.POSTGRES_USER
connection.password = environment.POSTGRES_PASSWORD
const files = process.argv.slice(2)
if (!files.length || new Set(files).size !== files.length
  || files.some(file => !/^(?:packages|apps|tests)\/[A-Za-z0-9_./-]+\.test\.ts$/u.test(file) || file.includes('..'))) throw new Error('explicit unique test paths required')
const report = resolve(`artifacts/audit-2026-09-07/auth163/postgres-${Date.now()}.json`)
console.log(JSON.stringify({ container, containerId: inspected.Id, image: inspected.Config.Image, postgresVersion, tests: files, report, businessDatabaseAccess: false }))
const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', ...files, '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile=${report}`], {
  env: { ...process.env, PERSISTENCE_RELEASE_DATABASE_URL: connection.toString(), NODE_ENV: 'test' }, stdio: 'inherit',
})
const document = JSON.parse(readFileSync(report, 'utf8'))
const expected = files.map(file => resolve(file)).sort()
const actual = document.testResults.map(file => resolve(file.name)).sort()
const assertions = document.testResults.flatMap(file => file.assertionResults ?? [])
const counts = assertions.reduce((values, item) => ({ ...values, [item.status]: (values[item.status] ?? 0) + 1 }), {})
const notExecuted = assertions.filter(item => item.status !== 'passed' && item.status !== 'failed')
const exactFiles = JSON.stringify(expected) === JSON.stringify(actual)
const allFilesExecuted = document.testResults.every(file => (file.assertionResults ?? []).some(item => item.status === 'passed' || item.status === 'failed'))
console.log(JSON.stringify({ exactFiles, allFilesExecuted, files: actual.length, counts, notExecuted: notExecuted.length, expectedFiles: expected.length }))
process.exitCode = result.status === 0 && exactFiles && allFilesExecuted && assertions.length > 0 && notExecuted.length === 0 ? 0 : 1
