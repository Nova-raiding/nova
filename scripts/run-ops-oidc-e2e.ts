import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLocalOidcGateway } from '../tests/local-oidc-gateway.js'
import { createIsolatedOpsFixture, type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'

// Own all persistence and identities; never copy a business container or .env.
export function opsChildEnvironment(source: NodeJS.ProcessEnv, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'CI', 'NO_COLOR']) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return { ...environment, ...additions }
}

export function validateOpsE2eArguments(args: readonly string[], source: NodeJS.ProcessEnv): string[] {
  if (source.OPS_E2E_SOURCE_CONTAINER?.trim()) throw new Error('OPS_E2E_SHARED_SOURCE_UNSUPPORTED: this runner only provisions isolated fixtures')
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (/^dogfood\/chatgpt-all-functions\/ops[a-z0-9-]*\.spec\.js$/u.test(argument) || argument === '--workers=1') continue
    if ((argument === '--grep' || argument === '-g') && args[index + 1]?.trim() && !/[\u0000-\u001f\u007f]/u.test(args[index + 1]!)) { index++; continue }
    throw new Error('OPS_E2E_OVERRIDE_NOT_ALLOWED')
  }
  if (args.length && !args.some(argument => argument.endsWith('.spec.js'))) throw new Error('OPS_E2E_EXPLICIT_SPEC_REQUIRED')
  return args.length ? [...args] : ['dogfood/chatgpt-all-functions/ops-jit-isolated.spec.js']
}

async function freeLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((ready, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', ready) })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('OPS_E2E_PORT_UNAVAILABLE')
  await new Promise<void>((closed, reject) => listener.close(error => error ? reject(error) : closed()))
  return address.port
}

async function exited(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return child.exitCode
  if (child.signalCode !== null) return 1
  return new Promise<number>((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)) })
}

export type OpsE2eContext = { fixture: IsolatedOpsFixture; baseUrl: string; username: string; password: string; evidenceDir: string; environment: NodeJS.ProcessEnv }

export async function runOpsE2e(requested: readonly string[], source: NodeJS.ProcessEnv = process.env, afterRun?: (context: OpsE2eContext) => Promise<void>): Promise<number> {
  // Validate before creating directories, containers, connections or processes.
  const args = validateOpsE2eArguments(requested, source)
  const evidenceDir = resolve('artifacts/ops-jit-isolation', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`)
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const children: ChildProcess[] = []
  let fixture: IsolatedOpsFixture | undefined
  let fixtureSetup: Promise<IsolatedOpsFixture> | undefined
  let gateway: ReturnType<typeof createLocalOidcGateway> | undefined
  let workspaceGateway: ReturnType<typeof createLocalOidcGateway> | undefined
  let cleanupPromise: Promise<void> | undefined
  let stopping = false
  const cleanup = () => cleanupPromise ??= (async () => {
    stopping = true
    // A signal can arrive while Docker/migrations are still provisioning. Do
    // not exit before that promise yields the exact resources we must dispose.
    if (!fixture && fixtureSetup) fixture = await fixtureSetup.catch(() => undefined)
    gateway?.closeAllConnections?.()
    workspaceGateway?.closeAllConnections?.()
    if (gateway?.listening) await new Promise<void>(closed => gateway!.close(() => closed()))
    if (workspaceGateway?.listening) await new Promise<void>(closed => workspaceGateway!.close(() => closed()))
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await Promise.race([exited(child).catch(() => 1), new Promise<void>(done => setTimeout(done, 5_000))])
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited(child).catch(() => 1) }
    }))
    if (fixture) {
      const disposed = await fixture.dispose()
      if (disposed.leftRunning.length) throw new Error('OPS_E2E_FIXTURE_CLEANUP_REQUIRES_REVIEW')
    }
  })()
  const onInterrupt = () => { void cleanup().finally(() => process.exit(130)) }
  const onTerminate = () => { void cleanup().finally(() => process.exit(143)) }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  const launch = (command: string, arguments_: string[], environment: NodeJS.ProcessEnv, name: string, inherit = false): ChildProcess => {
    const output = inherit ? undefined : openSync(resolve(evidenceDir, `${name}.log`), 'wx', 0o600)
    const errors = inherit ? undefined : openSync(resolve(evidenceDir, `${name}.error.log`), 'wx', 0o600)
    const child = spawn(command, arguments_, { env: environment, stdio: inherit ? 'inherit' : ['ignore', output!, errors!] })
    if (output !== undefined) closeSync(output)
    if (errors !== undefined) closeSync(errors)
    children.push(child)
    return child
  }
  const ready = async (url: string, child: ChildProcess) => {
    const deadline = Date.now() + 60_000
    while (!stopping && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('OPS_E2E_SERVICE_EXITED_BEFORE_READY')
      try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return } catch { /* startup */ }
      await new Promise(done => setTimeout(done, 300))
    }
    throw new Error('OPS_E2E_SERVICE_READINESS_TIMEOUT')
  }
  try {
    fixtureSetup = createIsolatedOpsFixture({ evidenceDir })
    fixture = await fixtureSetup
    if (stopping) throw new Error('OPS_E2E_INTERRUPTED_DURING_SETUP')
    const apiPort = await freeLoopbackPort()
    const uiPort = await freeLoopbackPort()
    const workspaceUiPort = await freeLoopbackPort()
    const gatewayPort = await freeLoopbackPort()
    const workspaceGatewayPort = await freeLoopbackPort()
    if (new Set([apiPort, uiPort, workspaceUiPort, gatewayPort, workspaceGatewayPort]).size !== 5) throw new Error('OPS_E2E_LISTENER_PORT_COLLISION')
    const baseUrl = `http://127.0.0.1:${gatewayPort}`
    const signingSecret = randomBytes(32).toString('hex')
    const username = 'ops-isolated-e2e'
    const password = randomBytes(24).toString('hex')
    gateway = createLocalOidcGateway({
      uiUpstream: `http://127.0.0.1:${uiPort}`, apiUpstream: `http://127.0.0.1:${apiPort}`,
      username, password, sessionSecret: randomBytes(32).toString('hex'), oidcSigningSecret: signingSecret,
      issuer: fixture.issuer, subject: fixture.actorSubject, workspaceId: fixture.workspaceId,
      roles: ['platform_admin', 'security_admin'], workbench: 'platform',
    })
    const workspacePassword = randomBytes(24).toString('hex')
    workspaceGateway = createLocalOidcGateway({
      uiUpstream: `http://127.0.0.1:${workspaceUiPort}`, apiUpstream: `http://127.0.0.1:${apiPort}`,
      username: 'ops-isolated-workspace-e2e', password: workspacePassword,
      sessionSecret: randomBytes(32).toString('hex'), oidcSigningSecret: signingSecret,
      issuer: fixture.issuer, subject: fixture.workspaceActorSubject, workspaceId: fixture.workspaceId,
      roles: ['merchant_admin'], workbench: 'workspace',
    })
    const apiEnvironment = opsChildEnvironment(source, {
      NODE_ENV: 'development', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres',
      PORT: String(apiPort), OPS_AUTH_MODE: 'oidc', OIDC_PROXY_SIGNING_SECRET: signingSecret,
      API_BIND_HOST: '127.0.0.1',
      SESSION_ID_HASH_SECRET: randomBytes(32).toString('hex'),
      DATABASE_URL: fixture.databaseUrl, OPS_DATABASE_URL: fixture.opsDatabaseUrl, REDIS_URL: fixture.redisUrl,
      RUN_MIGRATIONS_ON_STARTUP: 'false', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
      CONNECTOR_FIXTURE_MODE: 'false', REQUEST_OBSERVABILITY_LOGS: 'true',
      ALLOWED_ORIGINS: baseUrl, ASSET_STORAGE_ROOT: resolve(evidenceDir, 'local-objects'),
    })
    const api = launch(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], apiEnvironment, 'api')
    const uiEnvironment = opsChildEnvironment(source, {
      NODE_ENV: 'production', VITE_API_BASE: '/api', VITE_API_PROXY_TARGET: baseUrl,
      VITE_OPS_AUTH_MODE: 'oidc', VITE_OPS_BUILD_MODE: 'oidc', VITE_OPS_TRACE: 'true', VITE_OPS_E2E: 'true',
    })
    const uiOutput = resolve(evidenceDir, 'ui-dist')
    const build = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'apps/ops-console', '--config', 'apps/ops-console/vite.config.ts', '--outDir', uiOutput], uiEnvironment, 'ui-build')
    if (await exited(build) !== 0) throw new Error('OPS_E2E_UI_BUILD_FAILED')
    // Serve the already-built bundle for browser acceptance. Vite dev injects
    // an HMR WebSocket client even when the gateway cannot upgrade sockets,
    // which creates false console failures and does not represent production.
    const ui = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort', '--outDir', uiOutput], uiEnvironment, 'ui')
    const workspaceUiEnvironment = { ...uiEnvironment, VITE_API_PROXY_TARGET: `http://127.0.0.1:${workspaceGatewayPort}` }
    const workspaceUi = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(workspaceUiPort), '--strictPort', '--outDir', uiOutput], workspaceUiEnvironment, 'workspace-ui')
    await Promise.all([ready(`http://127.0.0.1:${apiPort}/healthz`, api), ready(`http://127.0.0.1:${uiPort}/`, ui), ready(`http://127.0.0.1:${workspaceUiPort}/`, workspaceUi)])
    const health = await (await fetch(`http://127.0.0.1:${apiPort}/healthz`)).json() as { data?: { persistence?: { mode?: string; ready?: boolean }; redis?: { ready?: boolean } } }
    if (health.data?.persistence?.mode !== 'postgres' || !health.data.persistence.ready || !health.data.redis?.ready) throw new Error('OPS_E2E_DURABLE_RUNTIME_REQUIRED')
    await new Promise<void>((done, reject) => { gateway!.once('error', reject); gateway!.listen(gatewayPort, '127.0.0.1', done) })
    const activeWorkspaceGateway = workspaceGateway
    if (!activeWorkspaceGateway) throw new Error('OPS_E2E_WORKSPACE_GATEWAY_NOT_READY')
    await new Promise<void>((done, reject) => { activeWorkspaceGateway.once('error', reject); activeWorkspaceGateway.listen(workspaceGatewayPort, '127.0.0.1', done) })
    const environment = opsChildEnvironment(source, {
      OPS_OIDC_BASE_URL: baseUrl, LOCAL_OIDC_TEST_USERNAME: username, LOCAL_OIDC_TEST_PASSWORD: password,
      OPS_WORKSPACE_OIDC_BASE_URL: `http://127.0.0.1:${workspaceGatewayPort}`,
      OPS_WORKSPACE_OIDC_USERNAME: 'ops-isolated-workspace-e2e', OPS_WORKSPACE_OIDC_PASSWORD: workspacePassword,
      OPS_NO_AUTH_BASE_URL: `http://127.0.0.1:${uiPort}/`,
      LOCAL_OIDC_SUBJECT: fixture.actorSubject, OPS_E2E_WORKSPACE_ID: fixture.workspaceId,
      OPS_E2E_SUBJECT_IDENTITY_ID: fixture.subjectIdentityId, OPS_E2E_APPROVER_ID: fixture.approverId,
      OPS_E2E_OUTPUT_DIR: evidenceDir, PLAYWRIGHT_JSON_OUTPUT_NAME: resolve(evidenceDir, 'playwright.json'),
    })
    writeFileSync(resolve(evidenceDir, 'runtime.json'), JSON.stringify({
      runId: fixture.runId, evidenceDir, baseUrl, apiPort, uiPort, gatewayPort,
      persistence: health.data.persistence, redis: health.data.redis,
      authorization: { mode: 'enforce', durableAssignmentsRequired: true, identityProvider: 'local signed OIDC fixture' },
      models: { configured: false, called: false }, sharedConfigurationRead: false,
    }, null, 2), { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ evidenceDir, runId: fixture.runId, isolated: true, persistence: 'postgres', testFiles: args.filter(argument => argument.endsWith('.spec.js')) }))
    const run = launch(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args, '--workers=1', '--reporter=line,json', '--output', resolve(evidenceDir, 'test-results')], environment, 'browser', true)
    const exitCode = await exited(run)
    if (afterRun) await afterRun({ fixture, baseUrl, username, password, evidenceDir, environment })
    return exitCode
  } finally {
    await cleanup()
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--help')) console.log('Usage: node --import tsx scripts/run-ops-oidc-e2e.ts [dogfood/chatgpt-all-functions/ops*.spec.js]\nAlways provisions isolated PG17/Redis and a fresh signed OIDC identity. Shared stack configuration is not accepted.')
  else runOpsE2e(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { console.error(error instanceof Error ? error.message : 'OPS_E2E_FAILED'); process.exitCode = 1 })
}
