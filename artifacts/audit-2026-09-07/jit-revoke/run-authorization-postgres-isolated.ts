import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { buildSafeTestEnvironment } from '../../../scripts/run-safe-tests.js'
import { createIsolatedOpsFixture, ISOLATED_POSTGRES_IMAGE, type IsolatedOpsFixture, type IsolatedFixtureDisposal } from '../../../tests/isolated-ops-fixture.js'

// Audited, fixed selection. No connection URL, target, config, or test filter
// is accepted from the caller. migration109.each contributes two assertions.
const manifest = [
  { file: 'packages/persistence/src/authorization-repository.release.postgres.test.ts', count: 1 },
  { file: 'packages/persistence/src/authorization-rls-boundary.postgres.test.ts', count: 1 },
  { file: 'packages/persistence/src/authorization-event-scope-integrity.postgres.test.ts', count: 1 },
  { file: 'packages/persistence/src/authorization-grant-scope-integrity.postgres.test.ts', count: 2 },
  { file: 'packages/persistence/src/migration-105-release.postgres.test.ts', count: 1 },
  { file: 'packages/persistence/src/migration-109-release.postgres.test.ts', count: 2 },
] as const
const scriptPath = fileURLToPath(import.meta.url)
const artifactRoot = dirname(scriptPath)
const projectRoot = resolve(artifactRoot, '../../..')
const expectedTests = 8
type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export function validateReport(value: unknown): string[] {
  if (!object(value) || !Array.isArray(value.testResults)) return ['AUTH_PG_REPORT_INVALID']
  const errors: string[] = []
  if (value.success !== true || value.numFailedTests !== 0 || value.numPendingTests !== 0
    || (value.numTodoTests ?? 0) !== 0 || (value.numFailedTestSuites ?? 0) !== 0
    || (value.numRuntimeErrorTestSuites ?? 0) !== 0) errors.push('AUTH_PG_REPORT_NOT_ALL_PASSED')
  const observed = new Set<string>()
  let count = 0
  for (const result of value.testResults) {
    if (!object(result) || typeof result.name !== 'string' || !Array.isArray(result.assertionResults)) { errors.push('AUTH_PG_REPORT_INVALID_FILE'); continue }
    const expected = manifest.find(item => resolve(projectRoot, item.file) === result.name)
    if (!expected || observed.has(expected.file)) errors.push('AUTH_PG_REPORT_UNEXPECTED_OR_DUPLICATE_FILE')
    if (expected) observed.add(expected.file)
    if (result.status !== 'passed' || !expected || result.assertionResults.length !== expected.count) errors.push('AUTH_PG_REPORT_FILE_DENOMINATOR_MISMATCH')
    for (const assertion of result.assertionResults) {
      count += 1
      if (!object(assertion) || assertion.status !== 'passed') errors.push('AUTH_PG_REPORT_FAILED_OR_SKIPPED_ASSERTION')
    }
  }
  if (observed.size !== manifest.length || value.testResults.length !== manifest.length) errors.push('AUTH_PG_REPORT_FILE_DENOMINATOR_MISMATCH')
  if (count !== expectedTests || value.numTotalTests !== expectedTests || value.numPassedTests !== expectedTests) errors.push('AUTH_PG_REPORT_TEST_DENOMINATOR_MISMATCH')
  return [...new Set(errors)]
}

export function assertOwnAdminBinding(fixture: Pick<IsolatedOpsFixture, 'runId' | 'adminDatabaseUrl' | 'containerEvidence'>): void {
  const database = new URL(fixture.adminDatabaseUrl)
  const postgres = fixture.containerEvidence.filter(container => container.kind === 'postgres')
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(fixture.runId)
    || fixture.containerEvidence.length !== 2 || postgres.length !== 1
    || new Set(fixture.containerEvidence.map(container => container.id)).size !== 2
    || fixture.containerEvidence.some(container => !/^[a-f0-9]{64}$/u.test(container.id)
      || container.runId !== fixture.runId || container.autoRemove !== true || container.dataStorage !== 'tmpfs'
      || container.name !== `merchant-ops-fixture-${container.kind}-${fixture.runId}`
      || container.labels['merchant.fixture.run-id'] !== fixture.runId
      || container.labels['merchant.fixture.kind'] !== container.kind
      || container.labels['merchant.fixture.purpose'] !== 'isolated-ops-oidc-acceptance')
    || postgres[0]!.image !== ISOLATED_POSTGRES_IMAGE
    || !/^postgres(?:ql)?:$/u.test(database.protocol) || database.hostname !== '127.0.0.1'
    || database.username !== 'merchant' || !database.password || database.pathname !== '/merchant'
    || Number(database.port) !== postgres[0]!.hostPort || !Number.isInteger(postgres[0]!.hostPort)
    || postgres[0]!.hostPort < 1 || postgres[0]!.hostPort > 65535 || database.search || database.hash) {
    throw new Error('AUTH_PG_OWN_ADMIN_BINDING_MISMATCH')
  }
}

export function assertCleanLauncherEnvironment(source: NodeJS.ProcessEnv): void {
  // Fail before Docker/SQL. This also prevents PGOPTIONS/PGSERVICE/PGPASSFILE
  // from affecting the fixture's parent-process pg pools. Use env -i to launch.
  const allowed = buildSafeTestEnvironment(source, '')
  delete allowed.ASSET_STORAGE_ROOT
  // CoreFoundation injects this encoding tuple after env -i on macOS. It is
  // not a runtime setting, and the child whitelist still does not forward it.
  if (process.platform === 'darwin' && /^0x[0-9a-f]+:0x[0-9a-f]+:0x[0-9a-f]+$/iu.test(source.__CF_USER_TEXT_ENCODING ?? '')) allowed.__CF_USER_TEXT_ENCODING = source.__CF_USER_TEXT_ENCODING
  if (Object.keys(source).some(key => !Object.hasOwn(allowed, key)) || source.NODE_ENV !== 'test') {
    throw new Error('AUTH_PG_LAUNCH_WITH_EXPLICIT_SYSTEM_ENV_ONLY')
  }
}

let interrupted = false
let child: ChildProcess | undefined
function runVitest(args: string[], environment: NodeJS.ProcessEnv): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolveExit, reject) => {
    const processHandle = spawn(process.execPath, [join(projectRoot, 'node_modules/vitest/vitest.mjs'), ...args], {
      cwd: projectRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = processHandle
    const chunks: string[] = []
    let bytes = 0
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      processHandle.kill('SIGTERM')
      killTimer = setTimeout(() => processHandle.kill('SIGKILL'), 10_000)
    }, 360_000)
    const collect = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk.toString('utf8'))
      else { timedOut = true; processHandle.kill('SIGTERM') }
    }
    processHandle.stdout!.on('data', collect)
    processHandle.stderr!.on('data', collect)
    const detach = () => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); child = undefined }
    processHandle.once('error', () => { detach(); reject(new Error('AUTH_PG_VITEST_SPAWN_FAILED')) })
    processHandle.once('close', code => { detach(); resolveExit({ exitCode: code ?? 1, output: chunks.join(''), timedOut }) })
  })
}

async function runAcceptance(): Promise<number> {
  assertCleanLauncherEnvironment(process.env)
  const evidenceDir = await mkdtemp(join(artifactRoot, 'postgres-run-'))
  const storageRoot = join(evidenceDir, 'local-objects')
  await mkdir(storageRoot, { mode: 0o700 })
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  let fixture: IsolatedOpsFixture | undefined
  let disposal: IsolatedFixtureDisposal | undefined
  let childExitCode: number | null = null
  let serverVersion: string | null = null
  let report: unknown
  const sourceHashes: Record<string, string> = {}
  try {
    for (const file of [...manifest.map(item => item.file), 'tests/isolated-ops-fixture.ts', 'scripts/run-safe-tests.ts', 'vitest.config.ts']) {
      const source = await readFile(join(projectRoot, file), 'utf8')
      if (source.trim().length === 0) throw new Error('AUTH_PG_EMPTY_SOURCE_FILE')
      sourceHashes[file] = sha256(source)
    }
    // Await setup even after SIGINT/SIGTERM; helper owns its partial cleanup,
    // and a completed fixture must be disposed before this process can exit.
    fixture = await createIsolatedOpsFixture({ evidenceDir })
    assertOwnAdminBinding(fixture)
    if (interrupted) throw new Error('AUTH_PG_INTERRUPTED')
    const admin = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1, connectionTimeoutMillis: 1_000 })
    try {
      const identity = (await admin.query("SELECT current_database() AS database, current_user AS actor, current_setting('server_version') AS version")).rows[0]
      if (identity?.database !== 'merchant' || identity.actor !== 'merchant' || !/^17\./u.test(identity.version)) throw new Error('AUTH_PG_DATABASE_IDENTITY_MISMATCH')
      serverVersion = identity.version as string
      // Exact cluster identity was proven above. These legacy fixture passwords
      // are set ONLY on this run's newly-created tmpfs PostgreSQL container.
      await admin.query("ALTER ROLE merchant_app PASSWORD 'merchant_app_local_only'")
      await admin.query("ALTER ROLE merchant_ops PASSWORD 'merchant_ops_local_only'")
    } finally { await admin.end() }
    if (interrupted) throw new Error('AUTH_PG_INTERRUPTED')
    const environment = { ...buildSafeTestEnvironment(process.env, storageRoot), PERSISTENCE_RELEASE_DATABASE_URL: fixture.adminDatabaseUrl }
    const result = await runVitest(['run', ...manifest.map(item => item.file), '--config', join(projectRoot, 'vitest.config.ts'),
      '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile=${join(evidenceDir, 'vitest.json')}`, '--passWithNoTests=false'], environment)
    childExitCode = result.exitCode
    // Never persist fixture URLs or generated credentials, even if a native
    // dependency includes one in a failure diagnostic.
    const secretValues = [fixture.adminDatabaseUrl, fixture.databaseUrl, fixture.opsDatabaseUrl, fixture.redisUrl]
    const redact = (value: string) => secretValues.reduce((output, secret) => output.replaceAll(secret, '[REDACTED_FIXTURE_URL]').replaceAll(new URL(secret).password, '[REDACTED_FIXTURE_PASSWORD]'), value)
    await writeFile(join(evidenceDir, 'vitest.log'), redact(result.output), { mode: 0o600, flag: 'wx' })
    if (result.exitCode !== 0 || result.timedOut) errors.push('AUTH_PG_VITEST_PROCESS_FAILED')
    try {
      const reportPath = join(evidenceDir, 'vitest.json')
      const reportText = redact(await readFile(reportPath, 'utf8'))
      // This file was created only by our child in our private mkdtemp; never
      // overwrite a caller-supplied path. Keep retained diagnostics secret-free.
      await writeFile(reportPath, reportText, { mode: 0o600 })
      report = JSON.parse(reportText) as unknown
      errors.push(...validateReport(report))
    } catch { errors.push('AUTH_PG_REPORT_MISSING_OR_INVALID') }
  } catch (error) {
    errors.push(error instanceof Error && /^(?:AUTH_PG|ISOLATED_FIXTURE)_[A-Z_]+$/u.test(error.message) ? error.message : 'AUTH_PG_RUN_FAILED')
  } finally {
    if (fixture) {
      try {
        disposal = await fixture.dispose()
        if (disposal.leftRunning.length > 0 || disposal.stopped.length !== fixture.containerEvidence.length
          || new Set(disposal.stopped).size !== fixture.containerEvidence.length
          || disposal.stopped.some(id => !fixture!.containerEvidence.some(container => container.id === id))) errors.push('AUTH_PG_DISPOSAL_INCOMPLETE')
      }
      catch { errors.push('AUTH_PG_DISPOSAL_FAILED') }
    }
  }
  if (interrupted) errors.push('AUTH_PG_INTERRUPTED')
  const exitCode = errors.length === 0 ? 0 : 1
  await writeFile(join(evidenceDir, 'run-result.json'), JSON.stringify({
    schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), status: exitCode === 0 ? 'passed' : 'failed',
    scriptSha256: sha256(await readFile(scriptPath, 'utf8')), sourceHashes, manifest, expectedFiles: 6, expectedTests,
    observedFiles: object(report) && Array.isArray(report.testResults) ? report.testResults.length : null,
    observedTests: object(report) ? report.numTotalTests ?? null : null,
    observedPassed: object(report) ? report.numPassedTests ?? null : null,
    observedSkipped: object(report) ? report.numPendingTests ?? null : null,
    childExitCode, errors: [...new Set(errors)], runId: fixture?.runId ?? null, serverVersion,
    containers: fixture?.containerEvidence ?? [], disposal: disposal ?? null,
    databaseSource: 'newly-created-isolated-fixture', inheritedBusinessEnvironment: false,
    sharedContainersTouched: false, modelCalls: 0, evidenceRetained: true,
    legacyTestCleanup: 'some selected tests terminate connections and drop only their own UUID database inside this run-owned cluster',
  }, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ status: exitCode === 0 ? 'passed' : 'failed', evidenceDir, expectedFiles: 6, expectedTests, runId: fixture?.runId ?? null, containers: fixture?.containerEvidence.map(item => ({ id: item.id, kind: item.kind })) ?? [], disposal: disposal ?? null, errors: [...new Set(errors)] }))
  return exitCode
}

function selfTest(): void {
  const valid = { success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
    numRuntimeErrorTestSuites: 0, numTotalTests: 8, numPassedTests: 8,
    testResults: manifest.map(item => ({ name: resolve(projectRoot, item.file), status: 'passed', assertionResults: Array.from({ length: item.count }, () => ({ status: 'passed' })) })) }
  assert.deepEqual(validateReport(valid), [])
  const mutations: ((value: typeof valid) => void)[] = [
    value => { value.success = false }, value => { value.numPendingTests = 1 }, value => { value.numPassedTests = 7 },
    value => { value.testResults.pop() }, value => { value.testResults[0]!.assertionResults = [] },
    value => { value.testResults[0]!.assertionResults[0]!.status = 'skipped' },
    value => { value.testResults[0]!.name = value.testResults[1]!.name },
    value => { value.testResults[0]!.name = '/tmp/unexpected.test.ts' },
  ]
  for (const mutate of mutations) { const report = structuredClone(valid); mutate(report); assert.notDeepEqual(validateReport(report), []) }
  assert.doesNotThrow(() => assertCleanLauncherEnvironment({ PATH: '/usr/bin', NODE_ENV: 'test' }))
  if (process.platform === 'darwin') assert.doesNotThrow(() => assertCleanLauncherEnvironment({ PATH: '/usr/bin', NODE_ENV: 'test', __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' }))
  assert.throws(() => assertCleanLauncherEnvironment({ PATH: '/usr/bin', NODE_ENV: 'test', __CF_USER_TEXT_ENCODING: 'not-an-encoding-tuple' }), /AUTH_PG_LAUNCH/u)
  for (const key of ['DATABASE_URL', 'PERSISTENCE_RELEASE_DATABASE_URL', 'PGOPTIONS', 'PGSERVICE', 'PGPASSFILE', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'DOCKER_HOST', 'ASSET_STORAGE_ROOT']) {
    assert.throws(() => assertCleanLauncherEnvironment({ PATH: '/usr/bin', NODE_ENV: 'test', [key]: 'must-not-inherit' }), /AUTH_PG_LAUNCH/u)
  }
  console.log('Authorization PG runner self-test passed: 1 valid report, 8 malformed reports, clean system environments, 10 unsafe environments; no Docker/SQL executed.')
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--self-test') selfTest()
  else if (args.length !== 0) { console.error('No external targets or options are accepted.'); process.exitCode = 1 }
  else {
    const interrupt = () => { interrupted = true; child?.kill('SIGINT') }
    const terminate = () => { interrupted = true; child?.kill('SIGTERM') }
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    try { process.exitCode = await runAcceptance() }
    catch { console.error('Authorization PG launcher failed closed; use an explicit env -i system-only launch.'); process.exitCode = 1 }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
  }
}
