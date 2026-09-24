/** Owner-run desktop + real password/local-plugin HTTP + PG/Redis/ClamAV acceptance.
 * node --import tsx scripts/verify-customer-delivery-account-access.ts
 * Importing is inert. Only the fresh runner-owned fixture may be mutated.
 * Synthetic checklist/payment documents are NOT commercial/provider evidence.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { downloadCustomerDeliveryContract } from '../apps/api/src/customer-delivery-contract-download.js'
import { contractLinkSourceFingerprint } from './verify-customer-delivery-contract-link.js'
import { disposeOpsE2eChild, monitorOpsE2eChild } from './ops-e2e-child-monitor.js'
import { runOpsE2e, type OpsE2eContext } from './run-ops-password-e2e.js'

type Json = Record<string, any>
type Actor = { label: string; login: string; password: string; accountId: string; identityId: string; cookie?: string; token?: string }
type Observation = { phase: string; actor: string; surface: string; method: string; status: number; code: string | null; dataPresent: boolean; requestId: string | null }
const scriptFile = fileURLToPath(import.meta.url), projectRoot = resolve(dirname(scriptFile), '..')
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const publicPdf = { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', sha256: '3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4', sizeBytes: 13264 }
const additionalSources = [
  'scripts/verify-customer-delivery-account-access.ts', 'dogfood/chatgpt-all-functions/ops-delivery-account-access.spec.js',
  'apps/api/src/customer-delivery-access.ts', 'apps/api/src/customer-delivery-access.test.ts', 'apps/api/src/customer-delivery-access.e2e.test.ts',
  'apps/api/src/customer-delivery-dispatch-recheck.test.ts', 'apps/api/src/customer-delivery-resource-recheck.test.ts',
  'apps/api/src/identity-mutation-role-contract.e2e.test.ts',
  'packages/contracts/src/customer-delivery-access.ts', 'packages/contracts/src/customer-delivery-access.test.ts', 'packages/contracts/src/http-authz.ts',
  'apps/ops-console/src/components/delivery/CustomerDeliveryAccountBinding.tsx', 'apps/ops-console/src/components/delivery/CustomerDeliveryAccountBinding.test.tsx',
  'packages/persistence/src/customer-delivery-account-binding.test.ts', 'packages/persistence/src/password-auth-repository.ts',
  'packages/persistence/src/identity-lifecycle-repository.ts', 'packages/persistence/src/members-repository.ts', 'packages/persistence/src/authorization-repository.ts',
  'packages/persistence/src/brand-unit-repository.ts', 'packages/persistence/src/image-generation-before-provider.release.postgres.test.ts',
  'packages/persistence/src/operations-repository.ts', 'packages/persistence/src/operations-repository.test.ts',
  'packages/persistence/src/image-generation-execution-repository.ts', 'packages/persistence/src/image-generation-execution-repository.test.ts',
  'packages/workers/src/execution-authorization.ts', 'packages/workers/src/execution-authorization.test.ts', 'apps/worker/src/final-provider-authorization.test.ts',
  'apps/worker/src/handler.ts', 'apps/api/src/worker-authorization-recheck.test.ts', 'packages/application/src/connector-runtime.ts',
  'packages/ai/src/provider-request.ts', 'packages/ai/src/generator.ts', 'packages/ai/src/image-editor.ts', 'packages/ai/src/image-facts.ts',
  'packages/ai/src/image-generator.ts', 'packages/ai/src/video-generator.ts', 'packages/ai/src/provider-dispatch-admission.test.ts',
  'packages/persistence/src/migration-212.test.ts', 'packages/persistence/src/migration-212-release.postgres.test.ts',
  'apps/ops-console/src/pages/CustomerDeliveryPage.test.tsx',
  'packages/connectors/src/index.ts', 'packages/connectors/src/http-connector.ts', 'packages/multimodal/src/index.ts',
  'packages/security/src/oauth.ts', 'packages/security/src/oauth.test.ts', 'apps/plugin/mcp/bridge.mjs', 'apps/plugin/mcp/bridge.test.ts',
]
export async function accountAccessSourceFingerprint() {
  const sources = { ...await contractLinkSourceFingerprint(), ...Object.fromEntries(await Promise.all(additionalSources.map(async file => [file, sha(await readFile(join(projectRoot, file)))]))) }
  assert(Object.keys(sources).some(file => file.endsWith('/212_customer_delivery_account_binding.sql')), 'ACCOUNT_ACCESS_BINDING_MIGRATION_MISSING')
  return Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))
}
function required(value: unknown, code: string): asserts value { if (!value) throw new Error(`ACCOUNT_ACCESS_${code}`) }
const safeError = (error: unknown) => error instanceof Error && /^(?:ACCOUNT_ACCESS_|OPS_E2E_|ISOLATED_FIXTURE_|CUSTOMER_DELIVERY_)[A-Z_]+$/u.test(error.message) ? error.message : 'ACCOUNT_ACCESS_RUNTIME_ASSERTION_FAILED'
const jsonFile = async (file: string): Promise<Json> => JSON.parse(await readFile(file, 'utf8'))
const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
function confined(parent: string, path: string) {
  const suffix = relative(parent, path)
  required(isAbsolute(path) && suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'EVIDENCE_PATH_OUTSIDE_RUN')
  return path
}
function ownBindings({ fixture }: OpsE2eContext) {
  const pg = fixture.containerEvidence.find(row => row.kind === 'postgres'), redis = fixture.containerEvidence.find(row => row.kind === 'redis')
  required(pg && redis && fixture.containerEvidence.length === 2 && [pg, redis].every(row => row.runId === fixture.runId && /^[a-f0-9]{64}$/u.test(row.id)), 'OWNED_CONTAINERS_REQUIRED')
  for (const [text, role] of [[fixture.adminDatabaseUrl, 'merchant'], [fixture.databaseUrl, 'merchant_app'], [fixture.opsDatabaseUrl, 'merchant_ops']]) {
    const url = new URL(text!)
    required(url.protocol === 'postgres:' && url.hostname === '127.0.0.1' && Number(url.port) === pg.hostPort && url.username === role
      && url.password && url.pathname === '/merchant' && !url.search && !url.hash, 'OWNED_DATABASE_REQUIRED')
  }
  const url = new URL(fixture.redisUrl)
  required(url.protocol === 'redis:' && url.hostname === '127.0.0.1' && Number(url.port) === redis.hostPort && url.password && url.pathname === '/0' && !url.search && !url.hash, 'OWNED_REDIS_REQUIRED')
}
async function apiChild() {
  required(process.send && process.env.ACCOUNT_ACCESS_CHILD === 'isolated-fixture', 'CHILD_NOT_OWNED')
  const api = await import('../apps/api/src/server.js'); await api.persistenceReady
  if (!api.server.listening) await once(api.server, 'listening')
  const address = api.server.address()
  required(address && typeof address !== 'string' && address.address === '127.0.0.1', 'CHILD_BINDING_INVALID')
  process.send!({ kind: 'ready', port: address.port })
}
async function platformCookie(context: OpsE2eContext) {
  const page = await request(new URL('/auth/login', context.baseUrl).toString())
  required(page.status === 200, 'PLATFORM_LOGIN_FORM_FAILED')
  const csrfCookie = page.headers.getSetCookie().find(value => value.startsWith('ops_local_oidc_login_csrf='))?.split(';')[0]
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/u)?.[1]
  required(csrfCookie && csrf, 'PLATFORM_CSRF_MISSING')
  const response = await request(new URL('/auth/login', context.baseUrl).toString(), { method: 'POST', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, username: context.username, password: context.password, return_to: '/ops/customer-delivery?workbench=platform' }) })
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('ops_local_oidc_session='))?.split(';')[0]
  required(response.status === 303 && cookie, 'PLATFORM_LOGIN_FAILED'); await response.body?.cancel(); return cookie
}

async function verifyRuntime(context: OpsE2eContext, report: Json) {
  ownBindings(context)
  const { fixture, evidenceDir } = context, workspaceId = fixture.workspaceId
  const browser = await jsonFile(join(evidenceDir, 'account-access/browser-result.json')), setup = await jsonFile(join(evidenceDir, 'contract-link/browser-result.json'))
  const scan = await jsonFile(join(evidenceDir, 'scan-result.json'))
  required(browser.status === 'passed' && browser.workspaceId === workspaceId && browser.fixtureRunId === fixture.runId && browser.browserMocks === false
    && browser.credentialsSaved === false && browser.providerCalls === false && browser.actors?.length === 2 && browser.effectiveAt, 'BROWSER_EVIDENCE_INCOMPLETE')
  required(setup.status === 'passed' && setup.deliveryId === browser.deliveryId && setup.browserMocks === false && setup.modelOrPaymentProviderCalls === false
    && setup.syntheticPaymentIsNotProviderEvidence === true && setup.syntheticChecklistsAreNotLiveIntegrationEvidence === true, 'REAL_SETUP_REQUIRED')
  required(scan.status === 'passed' && scan.runId === fixture.runId && scan.attachments?.length === 7 && scan.points?.noPointsGrantedOrConsumed === true
    && new Set(scan.attachments.map((row: Json) => row.assetId)).size === 7 && scan.attachments.every((row: Json) => row.objectBytesAndMetadataVerified === true), 'SEVEN_GENUINE_SCANS_REQUIRED')
  const training = scan.attachments.find((row: Json) => row.purpose === 'training')
  required(training?.assetId === setup.training.assetRef && training.deliveryId === browser.deliveryId, 'TRAINING_ASSET_MISMATCH')
  report.visual = []
  for (const file of ['account-selected.png', 'account-bound.png', 'account-reread.png', 'account-binding.webm']) {
    const path = join(evidenceDir, 'account-access', file), bytes = await readFile(path)
    required((await stat(path)).size > 0 && browser.visualEvidence.includes(file), 'BINDING_VISUAL_EVIDENCE_MISSING')
    report.visual.push({ file: `account-access/${file}`, sha256: sha(bytes), sizeBytes: bytes.length })
  }
  const actors: Actor[] = browser.actors.map((row: Json) => {
    required(['A', 'B'].includes(row.label) && row.login === `delivery-${row.label.toLowerCase()}-${sha(workspaceId).slice(0, 16)}@fixture.invalid`
      && /^[a-f0-9-]{36}$/iu.test(row.accountId) && /^[a-f0-9-]{36}$/iu.test(row.identityId), 'OWNED_ACCOUNT_BINDING_INVALID')
    return { label: row.label, login: row.login, accountId: row.accountId, identityId: row.identityId, password: `Fixture-${sha(`${context.password}\0${workspaceId}\0${row.label}`)}` }
  })
  const a = actors.find(actor => actor.label === 'A')!, b = actors.find(actor => actor.label === 'B')!
  required(a && b && a.identityId !== b.identityId && a.accountId !== b.accountId && browser.boundIdentityId === a.identityId, 'TWO_DISTINCT_ACTORS_REQUIRED')
  report.actors = browser.actors; report.browserObservations = browser.observations; report.observations = []; report.faultInjections = []
  report.initialScan = { status: scan.status, runId: scan.runId, attachments: scan.attachments, points: scan.points, syntheticDocumentsOnly: true }
  const admin = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000, query_timeout: 6000 })
  let child: ChildProcess | undefined, monitor: ReturnType<typeof monitorOpsE2eChild> | undefined
  try {
    report.stage = 'owned-account-persistence'
    for (const actor of actors) {
      const rows = (await admin.query(`SELECT a.id,a.identity_id,a.login_identifier,a.account_type,a.status,a.workspace_ids,m.identity_id AS member_identity,m.status AS member_status,m.role,i.issuer,i.external_subject,
        (SELECT count(*)::int FROM platform_identity_events e WHERE e.identity_id=a.identity_id AND e.event_type='auth.merchant_created' AND e.actor_id=$4) AS creation_audits,
        (SELECT count(*)::int FROM workspace_operation_audit e WHERE e.workspace_id=$3 AND e.resource_id=a.login_identifier AND e.action='merchant.account.provision' AND e.actor_id=$4) AS provision_audits
        FROM platform_password_accounts a JOIN platform_identities i ON i.id=a.identity_id JOIN workspace_members m ON m.identity_id=a.identity_id AND m.workspace_id=$3
        WHERE a.id=$1 AND a.identity_id=$2`, [actor.accountId, actor.identityId, workspaceId, fixture.actorSubject])).rows
      required(rows.length === 1, 'REAL_MEMBERSHIP_REQUIRED'); const row = rows[0]
      required(row.login_identifier === actor.login && row.account_type === 'merchant' && row.status === 'active' && row.member_status === 'active' && row.role === 'merchant_admin'
        && row.issuer === 'damai-password' && row.external_subject === actor.login && row.creation_audits === 1 && row.provision_audits === 1, 'PROVISIONING_AUDIT_OR_MEMBERSHIP_MISMATCH')
      assert.deepEqual(row.workspace_ids, [workspaceId], 'ACCOUNT_ACCESS_ACCOUNT_WORKSPACES_MISMATCH')
    }
    const delivery = async () => (await admin.query('SELECT target_account_id,target_identity_id,effective_at,revision FROM workspace_customer_deliveries WHERE workspace_id=$1 AND id=$2', [workspaceId, browser.deliveryId])).rows[0]
    const ready = await delivery()
    required(ready?.target_account_id === a.accountId && ready.target_identity_id === a.identityId && ready.effective_at && Number(ready.revision) === Number(browser.finalRevision), 'PERSISTED_BINDING_MISMATCH')
    const bindings = (await admin.query("SELECT count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='customer_delivery.account.bind' AND actor_id=$3", [workspaceId, browser.deliveryId, fixture.actorSubject])).rows[0]
    required(bindings.count === 1, 'REAL_BINDING_AUDIT_REQUIRED')
    const counts = (await admin.query(`SELECT
      (SELECT count(*)::int FROM workspace_customer_delivery_checklist_items WHERE workspace_id=$1 AND delivery_id=$2 AND completed=true) AS completed_items,
      (SELECT count(*)::int FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='customer_delivery.asset.upload' AND actor_id=$3) AS upload_audits`, [workspaceId, browser.deliveryId, fixture.actorSubject])).rows[0]
    required(counts.completed_items === 18 && counts.upload_audits === 7, 'EIGHTEEN_ITEMS_AND_SEVEN_UPLOAD_AUDITS_REQUIRED')
    const ledger = async () => {
      const counts: Json = {}
      for (const table of ['creative_point_grants', 'creative_point_operations', 'creative_point_ledger_events', 'creative_point_reservations']) counts[table] = (await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`, [workspaceId])).rows[0].count
      required(Object.values(counts).every(value => value === 0), 'POINTS_OR_PROVIDER_ACTIVITY_DETECTED'); return counts
    }
    const ledgerBefore = await ledger()
    report.stage = 'strict-local-plugin-sidecar'
    const environment: NodeJS.ProcessEnv = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', NODE_ENV: 'development',
      AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres', PORT: '0', API_BIND_HOST: '127.0.0.1', DATABASE_URL: fixture.databaseUrl, OPS_DATABASE_URL: fixture.opsDatabaseUrl,
      REDIS_URL: fixture.redisUrl, RUN_MIGRATIONS_ON_STARTUP: 'false', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true', CONNECTOR_FIXTURE_MODE: 'false',
      REQUEST_OBSERVABILITY_LOGS: 'false', SESSION_ID_HASH_SECRET: randomBytes(32).toString('hex'), ASSET_STORAGE_ROOT: join(evidenceDir, 'local-objects'),
      MCP_INTEGRATION_MODE: 'local_stdio', ACCOUNT_ACCESS_CHILD: 'isolated-fixture' }
    child = spawn(process.execPath, ['--import', 'tsx', scriptFile, '--api-child'], { cwd: projectRoot, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    monitor = monitorOpsE2eChild(child)
    const port = await monitor.guard(new Promise<number>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('ACCOUNT_ACCESS_API_STARTUP_TIMEOUT')), 60_000)
      child!.on('message', value => {
        const message = value as Json
        if (message?.kind === 'failure') { clearTimeout(timer); report.childErrorCode = /^[A-Z][A-Z0-9_]+$/u.test(message.code) ? message.code : 'ACCOUNT_ACCESS_CHILD_FAILED'; reject(new Error('ACCOUNT_ACCESS_CHILD_FAILED')) }
        if (message?.kind === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) { clearTimeout(timer); done(message.port) }
      })
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('ACCOUNT_ACCESS_CHILD_EXITED')) })
      child!.once('error', () => { clearTimeout(timer); reject(new Error('ACCOUNT_ACCESS_CHILD_FAILED')) })
    }))
    const base = `http://127.0.0.1:${port}`
    const fetchOwn = (path: string, init?: RequestInit) => monitor!.guard(request(`${base}${path}`, init))
    const healthResponse = await fetchOwn('/healthz'), health = await healthResponse.json() as Json
    required(healthResponse.status === 200 && health.data?.persistence?.mode === 'postgres' && health.data.persistence.ready === true && health.data.redis?.ready === true, 'SIDECAR_HEALTH_FAILED')
    const login = async (actor: Actor) => {
      const response = await fetchOwn('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: actor.login, password: actor.password, account_type: 'merchant' }) })
      const body = await response.json() as Json
      required(response.status === 200 && body.data?.account?.identityId === actor.identityId && body.data.account.id === actor.accountId, 'PASSWORD_IDENTITY_MISMATCH')
      actor.cookie = response.headers.getSetCookie().find(value => value.startsWith('damai_session='))?.split(';')[0]; required(actor.cookie, 'PASSWORD_COOKIE_MISSING')
      const exchange = await fetchOwn('/v1/auth/mcp-token', { method: 'POST', headers: { 'content-type': 'application/json', cookie: actor.cookie! }, body: JSON.stringify({ workspace_id: workspaceId }) })
      const token = await exchange.json() as Json
      required(exchange.status === 200 && typeof token.data?.access_token === 'string' && token.data.access_token.length > 20, 'LOCAL_PLUGIN_TOKEN_ISSUE_FAILED'); actor.token = token.data.access_token
      const persisted = (await admin.query("SELECT account_id,identity_id,workspace_id FROM mcp_oauth_tokens WHERE token_hash=$1 AND token_kind='access'", [sha(actor.token!)])).rows
      assert.deepEqual(persisted, [{ account_id: actor.accountId, identity_id: actor.identityId, workspace_id: workspaceId }], 'ACCOUNT_ACCESS_LOCAL_PLUGIN_IDENTITY_MISMATCH')
    }
    const observe = async (actor: Actor, phase: string, surface: 'http' | 'native-mcp', method = 'catalog.search'): Promise<Observation> => {
      const response = await fetchOwn(surface === 'http' ? '/v1/products?scope=workspace' : '/mcp', { method: surface === 'http' ? 'GET' : 'POST',
        headers: { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace', 'content-type': 'application/json', ...(surface === 'http' ? { cookie: actor.cookie! } : { authorization: `Bearer ${actor.token}` }) },
        ...(surface === 'native-mcp' ? { body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: method, arguments: method === 'catalog.search' ? { scope: 'workspace' } : {} } }) } : {}) })
      const body = await response.json() as Json, error = body.error?.data ?? body.error, data = surface === 'http' ? body.data : body.result?.structuredContent
      if (surface === 'native-mcp' && data) assert.deepEqual(JSON.parse(body.result.content[0].text), data, 'ACCOUNT_ACCESS_NATIVE_CONTENT_MISMATCH')
      const row = { phase, actor: actor.label, surface, method: surface === 'http' ? 'http.products' : method, status: response.status, code: error?.code ?? null,
        dataPresent: Boolean(data), requestId: error?.request_id ?? body.request_id ?? response.headers.get('x-request-id') }
      report.observations.push(row); return row
    }
    const baseline = new Map<string, Observation>()
    const oldGates = async (phase: string) => {
      for (const surface of ['http', 'native-mcp'] as const) {
        const other = await observe(b, `${phase}-B`, surface), current = await observe(a, phase, surface)
        required(other.code !== 'CUSTOMER_DELIVERY_REQUIRED' && current.code !== 'CUSTOMER_DELIVERY_REQUIRED', 'READY_STILL_DELIVERY_BLOCKED')
        required([null, 'STORE_ONBOARDING_REQUIRED', 'COMMERCIAL_ENTITLEMENT_REQUIRED', 'CREATIVE_POINTS_UNAVAILABLE', 'AUTHZ_CAPABILITY_MISSING'].includes(other.code)
          && (other.code === null ? other.status === 200 && other.dataPresent : surface === 'native-mcp' ? other.status === 200 : [402, 403, 428, 503].includes(other.status)), 'ORIGINAL_GATE_NOT_RECOGNIZED')
        assert.deepEqual([current.status, current.code], [other.status, other.code], 'ACCOUNT_ACCESS_READY_NOT_ORIGINAL_GATE')
        const previous = baseline.get(surface)
        if (previous) assert.deepEqual([other.status, other.code], [previous.status, previous.code], 'ACCOUNT_ACCESS_COLLEAGUE_CHANGED')
        else baseline.set(surface, other)
      }
    }
    const recoveryBaseline = new Map<string, Observation>()
    const recover = async (phase: string) => {
      for (const actor of actors) for (const method of ['workspace.health', 'commercial.access.get', 'platform.store.list']) {
        const row = await observe(actor, phase, 'native-mcp', method), key = `${actor.label}:${method}`
        // Native MCP uses HTTP 200 for this business denial. Only the exact
        // pre-existing store-list points gate is accepted, not any 503/error.
        const pointsDenied = method === 'platform.store.list' && row.code === 'CREATIVE_POINTS_UNAVAILABLE'
        required(row.status === 200 && (pointsDenied ? !row.dataPresent : row.code === null && row.dataPresent), 'RECOVERY_ORIGINAL_GATE_MISMATCH')
        const initial = browser.observations.find((item: Json) => item.actor === actor.label && item.phase === 'unbound-recovery-baseline' && item.method === method)
        required(initial, 'RECOVERY_BROWSER_BASELINE_MISSING')
        assert.deepEqual([row.code, row.dataPresent], [initial.code, initial.dataPresent], 'ACCOUNT_ACCESS_RECOVERY_PASSWORD_OAUTH_MISMATCH')
        required(initial.status === (pointsDenied ? 503 : 200), 'RECOVERY_BROWSER_STATUS_MISMATCH')
        const previous = recoveryBaseline.get(key)
        if (previous) assert.deepEqual([row.status, row.code, row.dataPresent], [previous.status, previous.code, previous.dataPresent], 'ACCOUNT_ACCESS_RECOVERY_CHANGED')
        else recoveryBaseline.set(key, row)
        if (actor.label === 'B') {
          const other = recoveryBaseline.get(`A:${method}`)!
          assert.deepEqual([row.status, row.code, row.dataPresent], [other.status, other.code, other.dataPresent], 'ACCOUNT_ACCESS_RECOVERY_COLLEAGUE_CHANGED')
        }
      }
    }
    const disabled = async (phase: string) => {
      for (const surface of ['http', 'native-mcp'] as const) {
        const row = await observe(a, phase, surface)
        required([200, 401, 403].includes(row.status) && typeof row.code === 'string' && /^(AUTH_SESSION_INVALID|AUTH_ACCOUNT_NOT_ACTIVE|UNAUTHENTICATED|IDENTITY_SUSPENDED|MEMBER_SUSPENDED|WORKSPACE_MEMBERSHIP_REQUIRED)$/u.test(row.code) && !row.dataPresent, 'DISABLED_AUTHORITY_NOT_ENFORCED')
        const other = await observe(b, `${phase}-B`, surface), previous = baseline.get(surface)!
        assert.deepEqual([other.status, other.code], [previous.status, previous.code], 'ACCOUNT_ACCESS_COLLEAGUE_CHANGED')
      }
    }
    for (const actor of actors) await login(actor)
    report.passwordAndLocalPluginIdentityBindingVerified = true
    report.stage = 'ready-original-gates'; await oldGates('ready'); await recover('ready-recovery')
    const cookie = await platformCookie(context)
    const ops = async (method: string, params: Json) => {
      const response = await request(new URL('/api/mcp', context.baseUrl).toString(), { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })
      const body = await response.json() as Json, envelope = body.data ?? body
      const error = envelope.error?.data ?? envelope.error
      const requestId = error?.request_id ?? body.request_id ?? response.headers.get('x-request-id')
      ;(report.operationsRequests ??= []).push({ phase: report.stage, method, status: response.status,
        code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(error.code) ? error.code : error ? 'UNRECOGNIZED_ERROR' : null,
        requestId: typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(requestId) ? requestId : null,
        resultPresent: Boolean(envelope.result) })
      required(response.status === 200 && !envelope.error && envelope.result, 'REAL_OPERATIONS_REQUEST_FAILED'); return envelope.result as Json
    }
    report.stage = 'ready-account-status-fault'
    // Owner-authorized fault injection, never an operations audit or activation.
    const accountStatus = async (from: string, to: string) => {
      const changed = await admin.query(`UPDATE platform_password_accounts SET status=$4,revision=revision+1,updated_at=now()
        WHERE id=$1 AND identity_id=$2 AND status=$3 AND account_type='merchant' AND workspace_ids=ARRAY[$5]::text[] RETURNING id`, [a.accountId, a.identityId, from, to, workspaceId])
      required(changed.rowCount === 1, 'OWNED_ACCOUNT_FAULT_CAS_FAILED')
      report.faultInjections.push({ kind: 'password-account-status', accountId: a.accountId, from, to, observedAt: new Date().toISOString(), syntheticTestInjection: true, operationsAuditClaimed: false })
    }
    await accountStatus('active', 'suspended'); required((await delivery()).effective_at, 'ACCOUNT_STOP_CHANGED_COMPLETION'); await disabled('ready-account-suspended')
    await accountStatus('suspended', 'active'); await login(a); await oldGates('account-restored')
    report.stage = 'ready-real-membership-suspension'
    for (const action of ['suspend', 'activate']) {
      const detail = await ops('ops.user.detail', { identity_id: a.identityId }), member = detail.memberships.find((row: Json) => row.workspaceId === workspaceId && row.identityId === a.identityId)
      required(member, 'OWNED_MEMBER_MISSING')
      await ops(`ops.user.${action}`, { scope: 'membership', workspace_id: workspaceId, external_subject: a.login, expected_revision: String(member.revision), reason: '隔离验收：交付完成不能覆盖成员停用；测试后按流程恢复' })
      required((await delivery()).effective_at, 'MEMBER_STOP_CHANGED_COMPLETION')
      if (action === 'suspend') await disabled('ready-member-suspended')
      else { await login(a); await oldGates('member-restored') }
    }
    report.stage = 'revoke-one-owned-genuine-asset'
    const receiptRows = async () => (await admin.query(`SELECT r.receipt_id,r.receipt_digest,r.canonical_payload,r.signature FROM asset_scan_receipts r
      JOIN business_entity_snapshots s ON s.workspace_id=r.workspace_id AND s.payload->>'scanReceiptId'=r.receipt_id
      WHERE s.workspace_id=$1 AND s.entity_type='asset' AND s.entity_id=$2`, [workspaceId, training.assetId])).rows
    const receiptsBefore = await receiptRows(); required(receiptsBefore.length === 1 && receiptsBefore[0].receipt_digest === sha(receiptsBefore[0].canonical_payload), 'GENUINE_RECEIPT_MISSING')
    const changed = await admin.query(`UPDATE business_entity_snapshots SET payload=jsonb_set(payload,'{scanStatus}','"blocked"'::jsonb,true)
      WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2 AND payload->>'scanStatus'='clean' AND payload->>'scanReceiptId'=$3
        AND payload->>'sha256'=$4 RETURNING entity_id`, [workspaceId, training.assetId, receiptsBefore[0].receipt_id, training.sha256])
    required(changed.rowCount === 1, 'OWNED_ASSET_REVOCATION_CAS_FAILED')
    report.faultInjections.push({ kind: 'asset-availability-revocation', assetId: training.assetId, from: 'clean', to: 'blocked', syntheticTestInjection: true,
      realReceiptChanged: false, operationsAuditClaimed: false, observedAt: new Date().toISOString() })
    assert.deepEqual(await receiptRows(), receiptsBefore, 'ACCOUNT_ACCESS_IMMUTABLE_RECEIPT_CHANGED')
    const revoked = await delivery()
    required(revoked.effective_at == null && Number(revoked.revision) > Number(ready.revision) && revoked.target_identity_id === a.identityId && revoked.target_account_id === a.accountId, 'REVOCATION_NOT_PROPAGATED')
    for (const surface of ['http', 'native-mcp'] as const) {
      const row = await observe(a, 'same-session-evidence-revoked', surface)
      required(row.status === (surface === 'http' ? 403 : 200) && row.code === 'CUSTOMER_DELIVERY_REQUIRED' && !row.dataPresent, 'REVOKED_DELIVERY_NOT_DENIED')
      const other = await observe(b, 'evidence-revoked-B', surface), previous = baseline.get(surface)!
      assert.deepEqual([other.status, other.code], [previous.status, previous.code], 'ACCOUNT_ACCESS_COLLEAGUE_CHANGED')
    }
    await recover('revoked-recovery')
    report.stage = 'real-identity-suspension-precedence'
    // Last: identity epoch revocation must not be undone by DB manipulation.
    const detail = await ops('ops.user.detail', { identity_id: a.identityId })
    await ops('ops.user.suspend', { scope: 'identity', identity_id: a.identityId, expected_revision: String(detail.identity.revision), idempotency_key: randomUUID(), reason: '隔离验收：身份停用始终优先于交付恢复入口' })
    await disabled('identity-suspended')
    const recoveryDenied = await observe(a, 'identity-suspended-recovery', 'native-mcp', 'workspace.health')
    required(recoveryDenied.status === 401 && recoveryDenied.code === 'UNAUTHENTICATED' && !recoveryDenied.dataPresent, 'IDENTITY_RECOVERY_OVERRIDE_DETECTED')
    const audits = (await admin.query(`SELECT action,count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id=$1
      AND ((resource_id=$2 AND action IN ('user.suspend','user.activate')) OR (resource_id=$3 AND action='customer_delivery.evidence.invalidated'
        AND actor_id='system:customer-delivery-evidence-guard' AND after_json->>'asset_id'=$4)) GROUP BY action ORDER BY action`, [workspaceId, a.login, browser.deliveryId, training.assetId])).rows
    assert.deepEqual(audits, [{ action: 'customer_delivery.evidence.invalidated', count: 1 }, { action: 'user.activate', count: 1 }, { action: 'user.suspend', count: 1 }], 'ACCOUNT_ACCESS_MUTATION_AUDIT_MISMATCH')
    const identityAudit = (await admin.query("SELECT count(*)::int AS count FROM platform_identity_events WHERE identity_id=$1 AND event_type='identity.suspended' AND actor_id=$2", [a.identityId, fixture.actorSubject])).rows[0]
    required(identityAudit.count === 1, 'IDENTITY_SUSPENSION_AUDIT_MISSING')
    const ledgerAfter = await ledger(); assert.deepEqual(ledgerAfter, ledgerBefore, 'ACCOUNT_ACCESS_LEDGER_CHANGED')
    report.persistence = { status: 'passed', accountMembershipsVerified: 2, bindingAuditCount: bindings.count, completedChecklistItems: counts.completed_items, uploadAudits: counts.upload_audits, mutationAudits: audits, identitySuspensionAudits: identityAudit.count,
      initialEffectiveAt: browser.effectiveAt, finalEffectiveAt: null, finalIdentityStatus: 'suspended', immutableScanReceiptPreserved: true, ledgerBefore, ledgerAfter,
      identityReactivationTested: false, identitySuspensionPhase: 'after-evidence-revocation', actualCustomerCommercialActivationClaimed: false }
    monitor.assertHealthy()
  } finally {
    monitor?.stop()
    try { if (child) { await disposeOpsE2eChild(child); report.localPluginSidecarCleanup = { stopped: child.exitCode !== null || child.signalCode !== null, ownProcessOnly: true } } }
    finally { await admin.end() }
  }
}

export async function verifyCustomerDeliveryAccountAccess() {
  required(resolve(process.cwd()) === projectRoot && process.argv.slice(2).length === 0, 'RUN_FROM_ROOT_WITHOUT_OVERRIDES')
  const startedAt = new Date().toISOString(), before = await accountAccessSourceFingerprint()
  const parent = join(projectRoot, 'artifacts/customer-delivery-account-access'); await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'run-'))
  const report: Json = { status: 'failed', startedAt, sourcesBefore: before, stage: 'public-pdf-preflight', sharedContainersTouched: false, providersCalled: false,
    rawReceiptsOrCredentialsSaved: false, realCustomerActivationClaimed: false, scope: 'explicit single-account delivery gating, not all release requirements' }
  let context: OpsE2eContext | undefined
  console.log(`Account-access owner evidence: ${directory}`)
  try {
    const downloaded = await downloadCustomerDeliveryContract(publicPdf.url)
    required(downloaded.sha256 === publicPdf.sha256 && downloaded.mime_type === 'application/pdf' && Buffer.from(downloaded.content_base64, 'base64').length === publicPdf.sizeBytes, 'PUBLIC_SAMPLE_CHANGED')
    report.publicSample = { ...publicPdf, observedAt: new Date().toISOString(), productionDownloaderUsed: true }
    report.stage = 'real-desktop-seven-scans-and-binding'
    const code = await runOpsE2e(['dogfood/chatgpt-all-functions/ops-delivery-account-access.spec.js'], { ...process.env, OPS_E2E_DELIVERY_SCAN: 'true', OPS_E2E_BROWSER_TIMEOUT_MS: '900000',
      OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS: process.env.OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS ?? '300000' }, async current => {
      context = current; report.fixtureEvidenceDir = current.evidenceDir
      assert.deepEqual(await accountAccessSourceFingerprint(), before, 'ACCOUNT_ACCESS_SOURCE_CHANGED')
      await verifyRuntime(current, report)
      assert.deepEqual(await accountAccessSourceFingerprint(), before, 'ACCOUNT_ACCESS_SOURCE_CHANGED')
    })
    required(code === 0 && context && report.persistence?.status === 'passed' && report.localPluginSidecarCleanup?.stopped === true, 'RUNNER_OR_RUNTIME_FAILED')
    report.stage = 'owned-container-cleanup'
    const disposal = await jsonFile(join(context.evidenceDir, `fixture-disposal-${context.fixture.runId}.json`)), runtime = await jsonFile(join(context.evidenceDir, 'runtime.json'))
    required(disposal.runId === context.fixture.runId && disposal.leftRunning.length === 0 && disposal.externalContainersTouched === false, 'FIXTURE_CLEANUP_FAILED')
    assert.deepEqual([...disposal.stopped].sort(), context.fixture.containerEvidence.map(row => row.id).sort(), 'ACCOUNT_ACCESS_CONTAINER_IDS_MISMATCH')
    const scannerDir = confined(context.evidenceDir, runtime.scanner.evidenceDir), scannerDisposal = await jsonFile(join(scannerDir, 'disposal.json')), readiness = await jsonFile(join(scannerDir, 'readiness.json'))
    required(scannerDisposal.runId === runtime.scanner.runId && scannerDisposal.leftRunning.length === 0 && scannerDisposal.sharedContainersTouched === false, 'SCANNER_CLEANUP_FAILED')
    assert.deepEqual(scannerDisposal.stopped, [readiness.container.id], 'ACCOUNT_ACCESS_SCANNER_ID_MISMATCH')
    report.cleanup = { fixture: disposal, scanner: scannerDisposal }
    assert.deepEqual(await accountAccessSourceFingerprint(), before, 'ACCOUNT_ACCESS_SOURCE_CHANGED')
    report.status = 'passed'; report.stage = 'complete'; return 0
  } catch (error) {
    report.errorCode = safeError(error)
    const sqlState = (error as { code?: unknown })?.code
    if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(sqlState)) report.sqlState = sqlState
    throw new Error(report.errorCode)
  }
  finally {
    report.finishedAt = new Date().toISOString(); report.sourcesAfter = await accountAccessSourceFingerprint()
    report.sourcesUnchanged = JSON.stringify(report.sourcesAfter) === JSON.stringify(before)
    if (!report.sourcesUnchanged) { report.status = 'failed'; report.errorCode = 'ACCOUNT_ACCESS_SOURCE_CHANGED' }
    await writeFile(join(directory, 'run-result.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
    if (!report.sourcesUnchanged) throw new Error('ACCOUNT_ACCESS_SOURCE_CHANGED')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  if (process.argv[2] === '--api-child') apiChild().catch(error => { process.send?.({ kind: 'failure', code: safeError(error) }); process.exitCode = 1 })
  else verifyCustomerDeliveryAccountAccess().then(code => { process.exitCode = code }, error => { console.error(safeError(error)); process.exitCode = 1 })
}
