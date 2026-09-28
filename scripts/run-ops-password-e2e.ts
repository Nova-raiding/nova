import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { Pool } from 'pg'
import { createIsolatedOpsFixture, type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'
import { PostgresCreativePointRepository } from '../packages/persistence/src/creative-point-repository.js'
import { PostgresCommercialContractRepository, monthlyAnniversary } from '../packages/persistence/src/commercial-contract-repository.js'
import type { CommercialCatalogSkuSnapshot } from '../packages/persistence/src/commercial-catalog-repository.js'
import { customerDeliveryScanTimeout, startCustomerDeliveryScanFixture, prepareCustomerDeliveryScanEnvironment, type CustomerDeliveryScanFixture } from './customer-delivery-scan-fixture.js'
import { collectCustomerDeliveryScanEvidence } from './customer-delivery-scan-evidence.js'
import { collectProductImportScanEvidence } from './product-import-scan-evidence.js'
import { disposeOpsE2eChild, monitorOpsE2eChild } from './ops-e2e-child-monitor.js'

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

export function isolatedManualOperationsMode(source: NodeJS.ProcessEnv): boolean {
  const value = source.OPS_E2E_MANUAL_OPERATIONS
  if (value !== undefined && value !== 'true') throw new Error('OPS_E2E_MANUAL_OPERATIONS_INVALID')
  return value === 'true'
}

export function validateOpsE2eSpecIsolation(args: readonly string[], manualOperationsMode: boolean): 'hyp@sn.com' | undefined {
  const selectedSpecs = args.filter(argument => argument.endsWith('.spec.js'))
  const jitSpec = 'dogfood/chatgpt-all-functions/ops-jit-isolated.spec.js'
  const manualImportSpec = 'dogfood/chatgpt-all-functions/ops-manual-import-isolated.spec.js'
  const desktopMatrixSpec = 'dogfood/chatgpt-all-functions/ops-desktop-readonly-matrix.spec.js'
  const deliveryReadonlySpec = 'dogfood/chatgpt-all-functions/ops-delivery-readonly-isolated.spec.js'
  if (selectedSpecs.includes(jitSpec) && selectedSpecs.length !== 1) throw new Error('OPS_E2E_JIT_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
  if (selectedSpecs.includes(manualImportSpec) && (selectedSpecs.length !== 1 || !manualOperationsMode)) throw new Error('OPS_E2E_MANUAL_IMPORT_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
  if (selectedSpecs.includes(desktopMatrixSpec) && selectedSpecs.length !== 1) throw new Error('OPS_E2E_DESKTOP_MATRIX_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
  if (selectedSpecs.includes(deliveryReadonlySpec) && selectedSpecs.length !== 1) throw new Error('OPS_E2E_DELIVERY_READONLY_REQUIRES_DEDICATED_ISOLATED_FIXTURE')
  const designatedAdminSpecs = [jitSpec, manualImportSpec, desktopMatrixSpec, deliveryReadonlySpec, 'dogfood/chatgpt-all-functions/ops-members-global-isolated.spec.js']
  return designatedAdminSpecs.includes(selectedSpecs[0] ?? '') ? 'hyp@sn.com' : undefined
}

/** Parse even when scanning is disabled, so a bad explicit configuration never
 * reaches directory creation or any fixture provisioning. No numeric coercion
 * of blank, fractional, exponent, hexadecimal or whitespace-padded values. */
export function validateOpsE2eScannerStartupTimeout(source: NodeJS.ProcessEnv): number {
  const raw = source.OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS
  if (raw === undefined) return customerDeliveryScanTimeout()
  if (!/^[1-9]\d{0,5}$/u.test(raw)) throw new Error('OPS_E2E_SCANNER_STARTUP_TIMEOUT_INVALID')
  try { return customerDeliveryScanTimeout(Number(raw)) }
  catch { throw new Error('OPS_E2E_SCANNER_STARTUP_TIMEOUT_INVALID') }
}

export function opsE2eScanPurpose(args: readonly string[], source: NodeJS.ProcessEnv): 'customer_delivery' | 'product_import' | undefined {
  const purpose = source.OPS_E2E_SCAN_PURPOSE
  if (purpose !== undefined && purpose !== 'product_import') throw new Error('OPS_E2E_SCAN_PURPOSE_INVALID')
  if (purpose === 'product_import') {
    if (source.OPS_E2E_DELIVERY_SCAN !== 'true' || args.filter(argument => argument.endsWith('.spec.js')).join() !== 'dogfood/chatgpt-all-functions/ops-product-import-scan-isolated.spec.js')
      throw new Error('OPS_E2E_PRODUCT_IMPORT_REQUIRES_DEDICATED_SCANNER_FIXTURE')
    return 'product_import'
  }
  return source.OPS_E2E_DELIVERY_SCAN === 'true' ? 'customer_delivery' : undefined
}

export function productImportPointGrantInput(fixture: Pick<IsolatedOpsFixture, 'workspaceId' | 'runId'>) {
  return { workspaceId: fixture.workspaceId, idempotencyKey: `product-import-scan:${fixture.runId}`,
    sourceType: 'test_fixture', sourceId: fixture.runId, points: 1,
    metadata: { isolated: true, purpose: 'product_import_scan', actor: 'isolated_fixture', reason: 'Admit one no-charge asset scan in this disposable workspace' } }
}

export function productImportSyntheticSku(runId: string, now: string): CommercialCatalogSkuSnapshot {
  const key = runId.replaceAll('-', '')
  const benefit = (code: string, quantity: number) => ({ code, quantity, rawValue: null, rawUnit: null, normalizedValue: null, policyRef: null, metadata: { isolated: true } })
  return { id: `sku_product_scan_${key}`, code: `product_scan_${key}`, kind: 'monthly', visibility: 'public', requiredCapability: null,
    versionId: `sku_product_scan_${key}_v1`, version: 1, lifecycle: 'approved', executable: true,
    priceFen: 0, currency: 'CNY', priceMode: 'fixed', durationDays: null,
    payload: { blockers: [], synthetic: true, purpose: 'product_import_scan' }, checksum: createHash('sha256').update(`product-import-synthetic-sku:${runId}`).digest('hex'),
    effectiveAt: now, benefits: [benefit('max_brands', 1), benefit('max_stores', 1), benefit('monthly_creative_points', 1)] }
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

/** One deadline covers both headers and body; never preserve a native fetch error. */
export async function fetchOpsE2eHealth(url: string): Promise<{ data?: { persistence?: { mode?: string; ready?: boolean }; redis?: { ready?: boolean } } }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error('OPS_E2E_HEALTH_CHECK_FAILED')
    return await response.json()
  } catch { throw new Error('OPS_E2E_HEALTH_CHECK_FAILED') }
  finally { clearTimeout(timer) }
}

/** Fixed error codes only; one failed disposer must not skip other owned data. */
export async function disposeOpsE2eResources(
  scanner?: { stop(): Promise<{ leftRunning: unknown[] }> },
  fixture?: { dispose(): Promise<{ leftRunning: unknown[] }> },
): Promise<string[]> {
  const errors: string[] = []
  try { if (scanner && (await scanner.stop()).leftRunning.length) errors.push('OPS_E2E_SCANNER_CLEANUP_REQUIRES_REVIEW') }
  catch { errors.push('OPS_E2E_SCANNER_CLEANUP_FAILED') }
  try { if (fixture && (await fixture.dispose()).leftRunning.length) errors.push('OPS_E2E_FIXTURE_CLEANUP_REQUIRES_REVIEW') }
  catch { errors.push('OPS_E2E_FIXTURE_CLEANUP_FAILED') }
  return errors
}

/** Readiness is not a lifetime guarantee. Never overlap probes or restart a failed scanner. */
export function monitorOpsE2eScanner(scanner: { checkRuntime(): Promise<void> }, intervalMs = 5_000) {
  let stopped = false
  let fault: Error | undefined
  let releasePause: (() => void) | undefined
  let rejectFailure!: (error: Error) => void
  let confirmFirstCheck!: () => void
  const firstCheck = new Promise<void>(resolveCheck => { confirmFirstCheck = resolveCheck })
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject })
  // The monitor can fail between guarded phases; keep the latched rejection handled.
  void failure.catch(() => undefined)
  const loop = (async () => {
    while (!stopped) {
      try { await scanner.checkRuntime(); confirmFirstCheck() }
      catch {
        fault = new Error('OPS_E2E_SCANNER_RUNTIME_FAILED'); rejectFailure(fault)
        return
      }
      if (stopped) return
      await new Promise<void>(resolvePause => {
        const timer = setTimeout(() => { releasePause = undefined; resolvePause() }, intervalMs)
        releasePause = () => { clearTimeout(timer); releasePause = undefined; resolvePause() }
      })
    }
  })()
  return {
    guard<T>(operation: Promise<T>): Promise<T> { return Promise.race([failure, Promise.all([firstCheck, operation]).then(([, result]) => result)]) },
    assertHealthy() { if (fault) throw fault },
    async stop() { stopped = true; releasePause?.(); await loop },
  }
}

export type OpsE2eContext = { fixture: IsolatedOpsFixture; baseUrl: string; username: string; password: string; evidenceDir: string; environment: NodeJS.ProcessEnv }

/** Same-origin static UI/API proxy. Authentication is handled by the real API password-session endpoints. */
export function createOpsPasswordProxy(uiUpstream: string, apiUpstream: string): HttpServer {
  return createHttpServer((incoming, outgoing) => {
    const apiRequest = incoming.url?.startsWith('/api/') || incoming.url === '/api'
    const upstreamUrl = new URL(incoming.url ?? '/', apiRequest ? apiUpstream : uiUpstream)
    if (apiRequest) upstreamUrl.pathname = upstreamUrl.pathname.replace(/^\/api(?=\/|$)/u, '') || '/'
    // Keep the browser-visible authority for API CSRF checks. Rewriting Host to
    // the private upstream makes a same-origin merchant token request appear
    // cross-origin even though the browser sent it through this loopback gate.
    const headers = { ...incoming.headers, host: apiRequest ? incoming.headers.host : upstreamUrl.host }
    const upstream = httpRequest(upstreamUrl, { method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(upstream)
  })
}

export async function runOpsE2e(requested: readonly string[], source: NodeJS.ProcessEnv = process.env, afterRun?: (context: OpsE2eContext) => Promise<void>): Promise<number> {
  // Validate before creating directories, containers, connections or processes.
  const args = validateOpsE2eArguments(requested, source)
  const scannerStartupTimeoutMs = validateOpsE2eScannerStartupTimeout(source)
  const scanPurpose = opsE2eScanPurpose(args, source)
  const manualOperationsMode = isolatedManualOperationsMode(source)
  const authorizationSuperAdminLogin = validateOpsE2eSpecIsolation(args, manualOperationsMode)
  const evidenceDir = resolve('artifacts/ops-jit-isolation', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`)
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const children: ChildProcess[] = []
  let fixture: IsolatedOpsFixture | undefined
  let fixtureSetup: Promise<IsolatedOpsFixture> | undefined
  let scanner: CustomerDeliveryScanFixture | undefined
  let scannerSetup: Promise<CustomerDeliveryScanFixture | undefined> | undefined
  let scannerMonitor: ReturnType<typeof monitorOpsE2eScanner> | undefined
  const serviceMonitors: ReturnType<typeof monitorOpsE2eChild>[] = []
  const guardRuntime = <T>(operation: Promise<T>): Promise<T> => {
    const guarded = serviceMonitors.reduce((pending, monitor) => monitor.guard(pending), operation)
    return scannerMonitor ? scannerMonitor.guard(guarded) : guarded
  }
  const assertRuntimeHealthy = () => {
    scannerMonitor?.assertHealthy()
    for (const monitor of serviceMonitors) monitor.assertHealthy()
  }
  let gateway: HttpServer | undefined
  let merchantGateway: HttpServer | undefined
  let cleanupPromise: Promise<void> | undefined
  let stopping = false
  let primaryError: unknown
  let browserExitCode: number | undefined
  let cleanupErrors: string[] = []
  const runtimeErrors: string[] = []
  const cleanup = () => cleanupPromise ??= (async () => {
    stopping = true
    // Detach before intentionally terminating services; latched failures remain observable.
    for (const monitor of serviceMonitors) monitor.stop()
    await scannerMonitor?.stop()
    // A signal can arrive while Docker/migrations are still provisioning. Do
    // not exit before that promise yields the exact resources we must dispose.
    if (!fixture && fixtureSetup) fixture = await fixtureSetup.catch(() => undefined)
    if (!scanner && scannerSetup) scanner = await scannerSetup.catch(() => undefined)
    try {
      gateway?.closeAllConnections?.()
      if (gateway?.listening) await new Promise<void>(closed => gateway!.close(() => closed()))
      merchantGateway?.closeAllConnections?.()
      if (merchantGateway?.listening) await new Promise<void>(closed => merchantGateway!.close(() => closed()))
    } catch { cleanupErrors.push('OPS_E2E_GATEWAY_CLEANUP_FAILED') }
    const childrenDisposed = await Promise.allSettled(children.map(disposeOpsE2eChild))
    if (childrenDisposed.some(result => result.status === 'rejected')) cleanupErrors.push('OPS_E2E_CHILD_CLEANUP_FAILED')
    cleanupErrors.push(...await disposeOpsE2eResources(scanner, fixture))
    if (cleanupErrors.length) throw new Error(cleanupErrors.join(':'))
  })()
  const onInterrupt = () => { void cleanup().finally(() => process.exit(130)) }
  const onTerminate = () => { void cleanup().finally(() => process.exit(143)) }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  const launch = (command: string, arguments_: string[], environment: NodeJS.ProcessEnv, name: string, inherit = false): ChildProcess => {
    const output = inherit ? undefined : openSync(resolve(evidenceDir, `${name}.log`), 'wx', 0o600)
    const errors = inherit ? undefined : openSync(resolve(evidenceDir, `${name}.error.log`), 'wx', 0o600)
    const child = spawn(command, arguments_, { env: environment, stdio: inherit ? 'inherit' : ['ignore', output!, errors!] })
    // Own an error observer for the child's whole lifetime, including the gap
    // after monitors detach and before individual disposers start.
    child.on('error', () => { if (stopping) cleanupErrors.push('OPS_E2E_CHILD_CLEANUP_FAILED') })
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
    fixtureSetup = createIsolatedOpsFixture({ evidenceDir, ...(authorizationSuperAdminLogin ? { authorizationSuperAdminLogin } : {}) })
    fixture = await fixtureSetup
    if (stopping) throw new Error('OPS_E2E_INTERRUPTED_DURING_SETUP')
    if (scanPurpose === 'product_import') {
      // A generic asset.uploaded scan has a no-charge commercial snapshot but
      // still requires a known positive balance. Provision one isolated test
      // point through the RLS-bound repository; no payment or model call occurs.
      const pointPool = new Pool({ connectionString: fixture.databaseUrl, max: 1 })
      try {
        const role = (await pointPool.query(`SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]
        if (role?.role !== 'merchant_app' || role.rolsuper !== false || role.rolbypassrls !== false) throw new Error('OPS_E2E_PRODUCT_IMPORT_POINT_ROLE_UNSAFE')
        const grant = await new PostgresCreativePointRepository(pointPool).grant(productImportPointGrantInput(fixture))
        if (grant.balance.availablePoints !== 1) throw new Error('OPS_E2E_PRODUCT_IMPORT_POINT_FIXTURE_FAILED')
        writeFileSync(resolve(evidenceDir, 'product-import-point-fixture.json'), JSON.stringify({ workspaceId: fixture.workspaceId,
          grantId: grant.value.id, availablePoints: grant.balance.availablePoints, isolated: true, modelCalls: 0,
          actor: 'isolated_fixture', reason: 'Admit one no-charge asset scan in this disposable workspace',
          databaseRole: role.role, bypassRls: false }), { mode: 0o600, flag: 'wx' })
      } finally { await pointPool.end() }
      if (!fixture.workspaceId.includes(fixture.runId.replaceAll('-', ''))) throw new Error('OPS_E2E_PRODUCT_IMPORT_FIXTURE_IDENTITY_INVALID')
      const now = new Date().toISOString()
      const sku = productImportSyntheticSku(fixture.runId, now)
      const adminPool = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1 })
      try {
        const admin = await adminPool.query('SELECT current_user AS role,current_database() AS database')
        if (admin.rows[0]?.role !== 'merchant' || admin.rows[0]?.database !== 'merchant') throw new Error('OPS_E2E_PRODUCT_IMPORT_CATALOG_FIXTURE_UNSAFE')
        await adminPool.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')`, [sku.id, sku.code])
        await adminPool.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at)
          VALUES ($1,$2,1,'approved',true,0,'CNY','fixed',$3::jsonb,$4,$5::timestamptz)`, [sku.versionId, sku.id, JSON.stringify(sku.payload), sku.checksum, now])
      } finally { await adminPool.end() }
      const contractPool = new Pool({ connectionString: fixture.databaseUrl, max: 1 })
      try {
        const contracts = new PostgresCommercialContractRepository(contractPool)
        const order = await contracts.createOrder({ workspaceId: fixture.workspaceId, sku, paymentProvider: 'synthetic_fixture',
          createdByActorId: 'isolated_fixture', idempotencyKey: `product-import-entitlement:${fixture.runId}`,
          reason: 'Disposable scanner browser acceptance; no payment provider called', now })
        const granted = await contracts.recordVerifiedPaymentAndGrant({ workspaceId: fixture.workspaceId, orderId: order.id,
          provider: 'synthetic_fixture', providerEventId: `synthetic:${fixture.runId}`, providerOrderId: `synthetic:${fixture.runId}`,
          nonce: `synthetic:${fixture.runId}`, payloadHash: createHash('sha256').update(`synthetic:${fixture.runId}`).digest('hex'),
          amountFen: 0, currency: 'CNY', paidAt: now, period: { start: now, end: monthlyAnniversary(now, 1) } })
        if (granted.order.status !== 'paid' || granted.availablePoints !== 2) throw new Error('OPS_E2E_PRODUCT_IMPORT_ENTITLEMENT_FIXTURE_FAILED')
        writeFileSync(resolve(evidenceDir, 'product-import-entitlement-fixture.json'), JSON.stringify({ workspaceId: fixture.workspaceId,
          skuId: sku.id, orderId: order.id, grantId: granted.grantId, availablePoints: granted.availablePoints,
          actor: 'isolated_fixture', reason: 'Disposable scanner browser acceptance; no payment provider called',
          synthetic: true, paidAmountFen: 0, providerCalled: false, modelCalls: 0,
          period: { start: now, end: monthlyAnniversary(now, 1) } }), { mode: 0o600, flag: 'wx' })
      } finally { await contractPool.end() }
    }
    const apiPort = await freeLoopbackPort()
    const uiPort = await freeLoopbackPort()
    const gatewayPort = await freeLoopbackPort()
    const merchantUiPort = scanPurpose === 'product_import' ? await freeLoopbackPort() : undefined
    const merchantGatewayPort = scanPurpose === 'product_import' ? await freeLoopbackPort() : undefined
    if (new Set([apiPort, uiPort, gatewayPort, merchantUiPort, merchantGatewayPort].filter(Boolean)).size !== (scanPurpose === 'product_import' ? 5 : 3)) throw new Error('OPS_E2E_LISTENER_PORT_COLLISION')
    const baseUrl = `http://127.0.0.1:${gatewayPort}`
    const merchantBaseUrl = merchantGatewayPort ? `http://127.0.0.1:${merchantGatewayPort}` : undefined
    if (scanPurpose) {
      scannerSetup = startCustomerDeliveryScanFixture({ enabled: true, evidenceDir, startupTimeoutMs: scannerStartupTimeoutMs,
        retainForDiagnostics: scanPurpose === 'product_import' })
      scanner = await scannerSetup
      if (stopping) throw new Error('OPS_E2E_INTERRUPTED_DURING_SCANNER_SETUP')
      if (scanner) scannerMonitor = monitorOpsE2eScanner(scanner)
    }
    const scanEnvironment = scanner ? prepareCustomerDeliveryScanEnvironment(scanner, { fixture, apiBaseUrl: `http://127.0.0.1:${apiPort}`, apiPort }) : undefined
    const username = fixture.platformLogin
    const password = fixture.platformPassword
    // Seed a run-unique approval credential in this isolated API only. The
    // desktop spec receives it for the approver form; it is never written to
    // runtime/evidence artifacts or inherited from ambient environment.
    const approvalToken = randomBytes(32).toString('base64url')
    const apiEnvironment = opsChildEnvironment(source, {
      NODE_ENV: 'development', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres',
      PORT: String(apiPort), OPS_AUTH_MODE: 'password',
      API_BIND_HOST: '127.0.0.1',
      SESSION_ID_HASH_SECRET: randomBytes(32).toString('hex'),
      AUTHORIZATION_APPROVAL_TOKENS: JSON.stringify({ [approvalToken]: { actor_id: fixture.approverId, workspaces: [fixture.workspaceId] } }),
      DATABASE_URL: fixture.databaseUrl, OPS_DATABASE_URL: fixture.opsDatabaseUrl, REDIS_URL: fixture.redisUrl,
      RUN_MIGRATIONS_ON_STARTUP: 'false', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
      CONNECTOR_FIXTURE_MODE: 'false', REQUEST_OBSERVABILITY_LOGS: 'true',
      ...(manualOperationsMode ? { PLATFORM_OPERATIONS_MODE: 'manual' } : {}),
      ALLOWED_ORIGINS: [baseUrl, merchantBaseUrl].filter(Boolean).join(','), PUBLIC_OPS_BASE_URL: baseUrl, ASSET_STORAGE_ROOT: resolve(evidenceDir, 'local-objects'),
      ...scanEnvironment?.apiEnvironment,
    })
    const api = launch(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], apiEnvironment, 'api')
    serviceMonitors.push(monitorOpsE2eChild(api))
    const uiEnvironment = opsChildEnvironment(source, {
      NODE_ENV: 'production', VITE_API_BASE: '/api', VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      VITE_OPS_AUTH_MODE: 'password', VITE_OPS_BUILD_MODE: 'password', VITE_OPS_TRACE: 'true', VITE_OPS_E2E: 'true',
    })
    const uiOutput = resolve(evidenceDir, 'ui-dist')
    const build = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'apps/ops-console', '--config', 'apps/ops-console/vite.config.ts', '--outDir', uiOutput], uiEnvironment, 'ui-build')
    if (await guardRuntime(exited(build)) !== 0) throw new Error('OPS_E2E_UI_BUILD_FAILED')
    // Serve the already-built bundle for browser acceptance. Vite dev injects
    // an HMR WebSocket client even when the gateway cannot upgrade sockets,
    // which creates false console failures and does not represent production.
    const ui = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort', '--outDir', uiOutput], uiEnvironment, 'ui')
    serviceMonitors.push(monitorOpsE2eChild(ui))
    if (scanPurpose === 'product_import' && merchantUiPort && merchantGatewayPort) {
      const merchantOutput = resolve(evidenceDir, 'merchant-ui-dist')
      const merchantEnvironment = opsChildEnvironment(source, { NODE_ENV: 'production', VITE_API_BASE_URL: '/api' })
      const merchantBuild = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'demo/merchant-studio', '--config', 'demo/merchant-studio/vite.config.ts', '--outDir', merchantOutput], merchantEnvironment, 'merchant-ui-build')
      if (await guardRuntime(exited(merchantBuild)) !== 0) throw new Error('OPS_E2E_MERCHANT_UI_BUILD_FAILED')
      const merchantUi = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(merchantUiPort), '--strictPort', '--outDir', merchantOutput], merchantEnvironment, 'merchant-ui')
      serviceMonitors.push(monitorOpsE2eChild(merchantUi))
      await guardRuntime(ready(`http://127.0.0.1:${merchantUiPort}/`, merchantUi))
      merchantGateway = createOpsPasswordProxy(`http://127.0.0.1:${merchantUiPort}`, `http://127.0.0.1:${apiPort}`)
      await new Promise<void>((done, reject) => { merchantGateway!.once('error', reject); merchantGateway!.listen(merchantGatewayPort, '127.0.0.1', done) })
    }
    await guardRuntime(Promise.all([ready(`http://127.0.0.1:${apiPort}/healthz`, api), ready(`http://127.0.0.1:${uiPort}/`, ui)]))
    const health = await guardRuntime(fetchOpsE2eHealth(`http://127.0.0.1:${apiPort}/healthz`))
    if (health.data?.persistence?.mode !== 'postgres' || !health.data.persistence.ready || !health.data.redis?.ready) throw new Error('OPS_E2E_DURABLE_RUNTIME_REQUIRED')
    if (scanEnvironment) serviceMonitors.push(monitorOpsE2eChild(launch(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], scanEnvironment.workerEnvironment, 'scan-worker')))
    gateway = createOpsPasswordProxy(`http://127.0.0.1:${uiPort}`, `http://127.0.0.1:${apiPort}`)
    await new Promise<void>((done, reject) => { gateway!.once('error', reject); gateway!.listen(gatewayPort, '127.0.0.1', done) })
    const environment = opsChildEnvironment(source, {
      OPS_BASE_URL: baseUrl, OPS_TEST_USERNAME: username, OPS_TEST_PASSWORD: password,
      OPS_NO_AUTH_BASE_URL: `http://127.0.0.1:${uiPort}/`,
      OPS_ACTOR_ID: fixture.actorSubject, OPS_E2E_WORKSPACE_ID: fixture.workspaceId,
      OPS_E2E_SUBJECT_IDENTITY_ID: fixture.subjectIdentityId, OPS_E2E_APPROVER_ID: fixture.approverId,
      OPS_E2E_APPROVAL_TOKEN: approvalToken,
      OPS_E2E_OUTPUT_DIR: evidenceDir, PLAYWRIGHT_JSON_OUTPUT_NAME: resolve(evidenceDir, 'playwright.json'),
      OPS_E2E_MERCHANT_USERNAME: fixture.merchantLogin, OPS_E2E_MERCHANT_PASSWORD: fixture.merchantPassword,
      OPS_E2E_MANUAL_OPERATIONS: manualOperationsMode ? 'true' : 'false',
      ...(scanPurpose ? { OPS_E2E_SCAN_PURPOSE: scanPurpose } : {}),
      ...(merchantBaseUrl ? { MERCHANT_STUDIO_URL: merchantBaseUrl } : {}),
      ...(scanner ? { OPS_E2E_REAL_DELIVERY_SCAN: 'true' } : {}),
    })
    writeFileSync(resolve(evidenceDir, 'runtime.json'), JSON.stringify({
      runId: fixture.runId, evidenceDir, baseUrl, apiPort, uiPort, gatewayPort,
      persistence: health.data.persistence, redis: health.data.redis,
      authorization: { mode: 'enforce', durableAssignmentsRequired: true, authentication: 'isolated PostgreSQL account/password sessions' },
      models: { configured: false, called: false }, sharedConfigurationRead: false,
      ...(scanner ? { scanner: { runId: scanner.runId, evidenceDir: scanner.evidenceDir, startupTimeoutMs: scannerStartupTimeoutMs, readiness: scanner.readiness, real: true, pointsGranted: false, purpose: scanPurpose } } : {}),
    }, null, 2), { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ evidenceDir, runId: fixture.runId, isolated: true, persistence: 'postgres', testFiles: args.filter(argument => argument.endsWith('.spec.js')) }))
    const run = launch(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args, '--workers=1', '--reporter=line,json', '--output', resolve(evidenceDir, 'test-results')], environment, 'browser', true)
    // Bound the browser child independently so a stuck Playwright test cannot
    // prevent fixture teardown or leave detached processes behind forever.
    // The bound is a hang guard, not a performance assertion: the ops suite is
    // ten serial full-browser flows, and the section walk alone sleeps five
    // seconds per section. 180s killed the run mid-suite (browserExitCode 124)
    // even when the assertions in front of it passed, so the gate could never
    // report a result. Give the suite room to finish while still bounding a hang.
    const browserTimeout = Number(source.OPS_E2E_BROWSER_TIMEOUT_MS ?? 900_000)
    let browserTimer: ReturnType<typeof setTimeout> | undefined
    const browserOutcome = Promise.race([
      exited(run),
      new Promise<number>(resolveTimeout => { browserTimer = setTimeout(() => {
        run.kill('SIGTERM')
        setTimeout(() => { if (run.exitCode === null && run.signalCode === null) run.kill('SIGKILL') }, 2_000).unref()
        resolveTimeout(124)
      }, Number.isFinite(browserTimeout) ? Math.max(10_000, browserTimeout) : 900_000) }),
    ]).finally(() => clearTimeout(browserTimer))
    const exitCode = await guardRuntime(browserOutcome)
    browserExitCode = exitCode
    assertRuntimeHealthy()
    // These hooks can hold database transactions. Drain them before cleanup;
    // do not race their effects against teardown on a background failure.
    if (scanner && exitCode === 0) {
      if (scanPurpose === 'product_import') await collectProductImportScanEvidence({ fixture, evidenceDir })
      else await collectCustomerDeliveryScanEvidence({ fixture, evidenceDir })
    }
    assertRuntimeHealthy()
    if (afterRun) await afterRun({ fixture, baseUrl, username, password, evidenceDir, environment })
    assertRuntimeHealthy()
    return exitCode
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await cleanup(); if (!primaryError) assertRuntimeHealthy() }
    catch (error) { if (!primaryError) { primaryError = error; throw error } }
    finally {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      // A transactional hook may reject before its post-check. Keep its error
      // AND every latched infrastructure failure after the hook has drained.
      try { scannerMonitor?.assertHealthy() } catch { runtimeErrors.push('OPS_E2E_SCANNER_RUNTIME_FAILED') }
      for (const monitor of serviceMonitors) {
        try { monitor.assertHealthy() } catch { runtimeErrors.push('OPS_E2E_SERVICE_RUNTIME_FAILED') }
      }
      if (primaryError || cleanupErrors.length || runtimeErrors.length || browserExitCode && browserExitCode !== 0) {
        const message = primaryError instanceof Error ? primaryError.message : ''
        const errorCode = /^(?:OPS_E2E_|CUSTOMER_DELIVERY_SCAN_|CUSTOMER_DELIVERY_OWNER_|OWNER_ACCEPTANCE_)[A-Z_:]+$/u.test(message)
          ? message : primaryError ? 'OPS_E2E_RUN_FAILED' : undefined
        try { writeFileSync(resolve(evidenceDir, 'run-failure.json'), JSON.stringify({ status: 'failed', errorCode, browserExitCode, cleanupErrors: [...new Set(cleanupErrors)], runtimeErrors: [...new Set(runtimeErrors)], sharedContainersTouched: false }, null, 2), { mode: 0o600, flag: 'wx' }) }
        catch { /* Preserve the original failure; never skip cleanup for a report write. */ }
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--help')) console.log('Usage: node --import tsx scripts/run-ops-password-e2e.ts [dogfood/chatgpt-all-functions/ops*.spec.js]\nAlways provisions isolated PG17/Redis and a fresh isolated password account. Shared stack configuration is not accepted.\nOptional OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: integer milliseconds, 1..300000; defaults to 120000. Does not enable scanning or relax scan readiness checks.')
  else runOpsE2e(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { console.error(error instanceof Error ? error.message : 'OPS_E2E_FAILED'); process.exitCode = 1 })
}
