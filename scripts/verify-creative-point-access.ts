/** Real API sockets, password sessions, PKCE tokens and disposable PG17/Redis.
 * Run: node --import tsx scripts/verify-creative-point-access.ts
 * No shared configuration, payment/model calls, deployment or existing data.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { PostgresCreativePointRepository } from '../packages/persistence/src/creative-point-repository.js'
import { PostgresBusinessRepository } from '../packages/persistence/src/business-repository.js'
import { PostgresPasswordAuthRepository } from '../packages/persistence/src/password-auth-repository.js'
import { createIsolatedOpsFixture, type IsolatedFixtureDisposal, type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'

const scriptFile = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(scriptFile), '..')
const clientId = 'isolated-creative-point-access'
const redirectUri = 'http://127.0.0.1:19093/oauth/callback'
const sourceFiles = [
  'apps/api/src/server.ts', 'packages/contracts/src/authz.ts', 'packages/contracts/src/mcp.ts',
  'packages/contracts/src/commercial-operation-registry.ts', 'packages/contracts/src/http-authz.ts',
  'packages/security/src/oauth.ts', 'packages/security/src/request-security.ts', 'packages/security/src/oidc-login-proof.ts',
  'packages/persistence/src/password-auth-repository.ts', 'packages/persistence/src/authorization-repository.ts',
  'packages/persistence/src/business-repository.ts', 'packages/persistence/src/migration.ts', 'infra/local/ensure-app-role.sql',
  'packages/persistence/src/members-repository.ts', 'packages/persistence/src/creative-point-repository.ts',
  'packages/persistence/src/repository.ts', 'apps/api/src/ops-rbac-http-mcp-creative-points.acceptance.test.ts',
  'apps/api/src/mcp-native-http.e2e.test.ts', 'apps/api/src/mcp-oauth-identity.e2e.test.ts',
  'packages/contracts/src/authz.test.ts', 'packages/security/src/oauth.test.ts', 'packages/security/src/request-security.test.ts',
  'apps/plugin/mcp/bridge.mjs', 'apps/plugin/mcp/bridge.test.ts',
  'tests/isolated-ops-fixture.ts', 'scripts/verify-creative-point-access.ts', 'release-metadata.json',
]
const fingerprint = async () => {
  const directory = 'packages/persistence/src/migrations'
  const migrations = (await readdir(join(projectRoot, directory))).filter(file => file.endsWith('.sql')).map(file => `${directory}/${file}`)
  return Object.fromEntries(await Promise.all([...sourceFiles, ...migrations].sort().map(async file =>
    [file, createHash('sha256').update(await readFile(join(projectRoot, file))).digest('hex')],
  )))
}
type Json = Record<string, any>
const object = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const safeChildCode = (value: unknown) => typeof value === 'string' && /^(?:[0-9A-Z]{5}|(?:AUTH|MCP|PERSISTENCE|ISOLATED|VERIFY|ERR)_[A-Z0-9_]+)$/u.test(value) ? value : 'VERIFY_POINTS_API_CHILD_FAILED'
type Actor = { role: string; workspaceId: string; login: string; password: string; identityId: string; cookie?: string; token?: string }
type Observation = { name: string; surface: string; requestWorkspaceId: string; responseWorkspaceId: string | null; actorId: string | null; tool: string; status: number; code: string | null; capability: string | null; reasonCode: string | null; requestId: string | null; result?: Json }

function assertOwnBindings(fixture: IsolatedOpsFixture) {
  const pg = fixture.containerEvidence.find(item => item.kind === 'postgres')
  const redis = fixture.containerEvidence.find(item => item.kind === 'redis')
  assert(pg && redis && fixture.containerEvidence.length === 2, 'VERIFY_POINTS_FIXTURE_CONTAINER_MISMATCH')
  for (const [value, role] of [[fixture.databaseUrl, 'merchant_app'], [fixture.opsDatabaseUrl, 'merchant_ops'], [fixture.adminDatabaseUrl, 'merchant']] as const) {
    const url = new URL(value)
    assert(url.protocol === 'postgres:' && url.hostname === '127.0.0.1' && url.username === role && url.password
      && url.pathname === '/merchant' && !url.search && !url.hash && Number(url.port) === pg.hostPort
      && pg.runId === fixture.runId, 'VERIFY_POINTS_DATABASE_BINDING_MISMATCH')
  }
  const url = new URL(fixture.redisUrl)
  assert(url.protocol === 'redis:' && url.hostname === '127.0.0.1' && url.password && url.pathname === '/0'
    && !url.search && !url.hash && Number(url.port) === redis.hostPort && redis.runId === fixture.runId, 'VERIFY_POINTS_REDIS_BINDING_MISMATCH')
}

async function apiChild() {
  assert(process.send && process.env.VERIFY_POINTS_CHILD === 'isolated-fixture', 'VERIFY_POINTS_CHILD_NOT_OWNED')
  const api = await import('../apps/api/src/server.js')
  await api.persistenceReady
  if (!api.server.listening) await once(api.server, 'listening')
  const address = api.server.address()
  assert(address && typeof address !== 'string' && address.address === '127.0.0.1', 'VERIFY_POINTS_API_BINDING_INVALID')
  process.send!({ kind: 'ready', port: address.port })
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = () => Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 4_000) })]).finally(() => clearTimeout(timer))
  child.kill('SIGTERM'); await wait()
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await wait() }
  assert(child.exitCode !== null || child.signalCode !== null, 'VERIFY_POINTS_API_CLEANUP_FAILED')
}

export async function verifyCreativePointAccess() {
  const parent = join(projectRoot, 'artifacts/creative-point-access')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidenceDir = await mkdtemp(join(parent, 'run-'))
  const startedAt = new Date().toISOString(), before = await fingerprint()
  const abort = new AbortController()
  const interrupt = () => abort.abort(new Error('VERIFY_POINTS_INTERRUPTED'))
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  const observations: Observation[] = [], children: ChildProcess[] = [], errors: string[] = []
  const childFailureCodes: { api: string; code: string }[] = []
  const denialAuditChecks: Json[] = []
  let fixture: IsolatedOpsFixture | undefined, admin: Pool | undefined, app: Pool | undefined, ops: Pool | undefined
  let disposal: IsolatedFixtureDisposal | undefined, stage = 'fixture', runtime: Json | undefined
  let stateBefore: Json | undefined, stateAfter: Json | undefined, audits: Json[] = [], after: Json | undefined
  let denialAuditsVerified = 0, revocationAuditVerified = false
  const request = async (url: string, init: RequestInit = {}) => {
    abort.signal.throwIfAborted()
    assert(children.every(child => child.exitCode === null && child.signalCode === null), 'VERIFY_POINTS_API_EXITED')
    return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) })
  }
  try {
    fixture = await createIsolatedOpsFixture({ evidenceDir }); assertOwnBindings(fixture); abort.signal.throwIfAborted()
    const options = { max: 2, connectionTimeoutMillis: 2_000, statement_timeout: 5_000, query_timeout: 6_000 }
    admin = new Pool({ ...options, connectionString: fixture.adminDatabaseUrl })
    app = new Pool({ ...options, connectionString: fixture.databaseUrl })
    ops = new Pool({ ...options, connectionString: fixture.opsDatabaseUrl })
    const flags = (await app.query('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    assert.deepEqual(flags, { role: 'merchant_app', rolsuper: false, rolbypassrls: false }, 'VERIFY_POINTS_APP_ROLE_UNSAFE')
    const workspaceA = fixture.workspaceId, workspaceB = `ws_points_other_${fixture.runId.replaceAll('-', '')}`
    await admin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [workspaceB])
    const accounts = new PostgresPasswordAuthRepository(ops), pointRepository = new PostgresCreativePointRepository(app)
    const actors: Actor[] = []
    for (const [index, role] of ['workspace_owner', 'merchant_admin', 'finance', 'operator', 'support', 'workspace_owner'].entries()) {
      const workspaceId = index === 5 ? workspaceB : workspaceA
      const login = `points-${index}-${fixture.runId}@fixture.invalid`, password = `FixtureA1!${randomBytes(24).toString('hex')}`
      const account = await accounts.createMerchantAccount({ login, password, enterpriseName: '隔离余额权限验收', contactName: role,
        workspaceIds: [workspaceId], actorId: 'isolated-points-seed', reason: 'synthetic isolated permission acceptance; no commercial grant' })
      await admin.query(`INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id)
        VALUES ($1,$2,$3,$4,$5,'active','isolated-points-seed',$6)`, [randomUUID(), workspaceId, login, role, role, account.identityId])
      actors.push({ role, workspaceId, login, password, identityId: account.identityId })
    }
    for (const [workspaceId, points] of [[workspaceA, 1_237], [workspaceB, 9_871]] as const) {
      await pointRepository.grant({ workspaceId, idempotencyKey: 'isolated-access-seed', sourceType: 'test_fixture', sourceId: fixture.runId,
        points, metadata: { synthetic: true, paymentExecuted: false, acceptanceOnly: true } })
      // Only a synthetic prerequisite, never proof of an official platform
      // authorization. No connector, remote account or credential is contacted.
      const id = `pa_points_${workspaceId}`, at = new Date().toISOString()
      await new PostgresBusinessRepository(app, { normalizedProjection: true }).save({ workspaceId, entityType: 'platform_account', entityId: id, entityVersion: 1,
        payload: { id, workspaceId, platform: 'taobao', remoteAccountId: `synthetic-${workspaceId}`, credentialRef: `vault://isolated-points/${workspaceId}`,
          tokenState: 'connected', storeAlias: '隔离合成店铺（未真实授权）', authRevision: 1, revision: 1, createdAt: at, updatedAt: at, synthetic: true } })
    }
    const ledgerState = async () => {
      const result: Json = {}
      for (const table of ['creative_point_grants', 'creative_point_operations', 'creative_point_ledger_events', 'creative_point_allocations', 'creative_point_reservations']) {
        result[table] = (await admin!.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=ANY($1::text[]) ORDER BY workspace_id,id`, [[workspaceA, workspaceB]])).rows.map(row => row.row)
      }
      // getBalance refreshes updated_at; that timestamp is not a ledger mutation.
      result.balances = (await admin!.query(`SELECT workspace_id,available_points::text,reserved_points::text,settled_points::text,revision::text
        FROM creative_point_access_state WHERE workspace_id=ANY($1::text[]) ORDER BY workspace_id`, [[workspaceA, workspaceB]])).rows
      return result
    }
    stateBefore = await ledgerState()
    const rls = await app.connect()
    try {
      await rls.query('BEGIN READ ONLY'); await rls.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceA])
      assert.equal((await rls.query('SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1', [workspaceB])).rowCount, 0, 'VERIFY_POINTS_RLS_LEAK')
      await rls.query('COMMIT')
    } finally { await rls.query('ROLLBACK').catch(() => undefined); rls.release() }
    stage = 'api_startup'
    const startApi = async (oauth: boolean) => {
      const environment: NodeJS.ProcessEnv = {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8',
        NODE_ENV: 'development', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres', PORT: '0', API_BIND_HOST: '127.0.0.1',
        DATABASE_URL: fixture!.databaseUrl, OPS_DATABASE_URL: fixture!.opsDatabaseUrl, REDIS_URL: fixture!.redisUrl,
        RUN_MIGRATIONS_ON_STARTUP: 'false', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
        CONNECTOR_FIXTURE_MODE: 'false', REQUEST_OBSERVABILITY_LOGS: 'false', SESSION_ID_HASH_SECRET: randomBytes(32).toString('hex'),
        ASSET_STORAGE_ROOT: join(evidenceDir, 'local-objects'), VERIFY_POINTS_CHILD: 'isolated-fixture',
        ...(oauth ? { MCP_OAUTH_REQUIRED: 'true', MCP_OAUTH_CLIENTS: JSON.stringify({ [clientId]: [redirectUri] }) } : {}),
      }
      // IPC exposes only the owned loopback port; never collect raw credentials/logs.
      const child = spawn(process.execPath, ['--import', 'tsx', scriptFile, '--api-child'], { cwd: projectRoot, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      children.push(child)
      const port = await new Promise<number>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('VERIFY_POINTS_API_STARTUP_TIMEOUT')), 60_000)
        child.once('error', () => { clearTimeout(timer); reject(new Error('VERIFY_POINTS_API_SPAWN_FAILED')) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('VERIFY_POINTS_API_EXITED')) })
        child.on('message', value => {
          if (object(value) && value.kind === 'failure') {
            childFailureCodes.push({ api: oauth ? 'merchant' : 'ops', code: safeChildCode(value.code) })
            clearTimeout(timer); reject(new Error('VERIFY_POINTS_API_CHILD_FAILED'))
          }
          if (object(value) && value.kind === 'ready' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) { clearTimeout(timer); done(value.port) }
        })
      })
      const base = `http://127.0.0.1:${port}`, response = await request(`${base}/healthz`), health = await response.json() as Json
      assert.equal(response.status, 200, 'VERIFY_POINTS_HEALTH_HTTP_FAILED')
      assert.equal(health.data?.persistence?.mode, 'postgres', 'VERIFY_POINTS_PERSISTENCE_NOT_POSTGRES')
      assert.equal(health.data?.persistence?.ready, true, 'VERIFY_POINTS_PERSISTENCE_NOT_READY')
      assert.equal(health.data?.redis?.ready, true, 'VERIFY_POINTS_REDIS_NOT_READY')
      return base
    }
    const merchantBase = await startApi(true), opsBase = await startApi(false)
    assert.notEqual(merchantBase, opsBase, 'VERIFY_POINTS_API_ORIGIN_COLLISION')
    runtime = { runId: fixture.runId, api: 'two-real-loopback-servers', persistence: 'postgres-17', redis: 'ready',
      authentication: ['password-session-cookie', 'OAuth-PKCE-S256'], authorization: 'strict-enforce-durable', runtimeRole: flags, rlsCrossTenantRows: 0 }
    stage = 'real_authentication'
    for (const actor of actors) {
      const login = await request(`${merchantBase}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: actor.login, password: actor.password, account_type: 'merchant' }) })
      assert.equal(login.status, 200, 'VERIFY_POINTS_PASSWORD_LOGIN_FAILED')
      actor.cookie = login.headers.getSetCookie().find(cookie => cookie.startsWith('damai_session='))?.split(';')[0]
      assert(actor.cookie, 'VERIFY_POINTS_PASSWORD_COOKIE_MISSING')
      await login.body?.cancel()
      const verifier = randomBytes(48).toString('base64url'), state = randomUUID(), resource = `${merchantBase}/mcp`
      const form = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'merchant', resource,
        login: actor.login, password: actor.password })
      const authorized = await request(`${merchantBase}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
      assert.equal(authorized.status, 302, 'VERIFY_POINTS_OAUTH_AUTHORIZE_FAILED')
      const location = new URL(authorized.headers.get('location') ?? '')
      assert.equal(`${location.origin}${location.pathname}`, redirectUri, 'VERIFY_POINTS_OAUTH_REDIRECT_MISMATCH')
      assert.equal(location.searchParams.get('state'), state, 'VERIFY_POINTS_OAUTH_STATE_MISMATCH')
      const code = location.searchParams.get('code'); assert(code, 'VERIFY_POINTS_OAUTH_CODE_MISSING'); await authorized.body?.cancel()
      const exchanged = await request(`${merchantBase}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier, resource }) })
      assert.equal(exchanged.status, 200, 'VERIFY_POINTS_OAUTH_EXCHANGE_FAILED')
      const token = await exchanged.json() as Json
      assert(typeof token.access_token === 'string' && token.access_token.length > 20, 'VERIFY_POINTS_OAUTH_TOKEN_MISSING')
      actor.token = token.access_token
    }
    const call = async (surface: 'http' | 'native-mcp', name: string, actor?: Actor, options: { workspace?: string; params?: Json; tool?: string; query?: string } = {}) => {
      const workspace = options.workspace ?? actor?.workspaceId ?? workspaceA
      const headers: Record<string, string> = { 'x-workspace-id': workspace, 'x-ops-workbench': 'workspace' }
      if (actor) { if (surface === 'http') headers.cookie = actor.cookie!; else headers.authorization = `Bearer ${actor.token}` }
      const response = await request(`${merchantBase}${surface === 'http' ? `/v1/creative-points/balance${options.query ?? ''}` : '/mcp'}`, {
        method: surface === 'http' ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' },
        ...(surface === 'native-mcp' ? { body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: options.tool ?? 'creative-points.balance.get', arguments: options.params ?? {} } }) } : {}),
      })
      const body = await response.json() as Json, error = body.error, nativeError = object(error?.data) ? error.data : error
      const data = surface === 'http' ? body.data : body.result?.structuredContent
      const observation: Observation = { name, surface, requestWorkspaceId: workspace, responseWorkspaceId: body.workspace_id ?? data?.workspace_id ?? null,
        actorId: actor?.identityId ?? null, tool: options.tool ?? 'creative-points.balance.get', status: response.status, code: nativeError?.code ?? null,
        capability: nativeError?.details?.capability ?? null, reasonCode: nativeError?.details?.reason_code ?? null,
        requestId: nativeError?.request_id ?? body.request_id ?? response.headers.get('x-request-id') }
      observations.push(observation)
      if (data && surface === 'native-mcp') assert.deepEqual(JSON.parse(body.result.content[0].text), data, 'VERIFY_POINTS_NATIVE_CONTENT_MISMATCH')
      return { response, body, data, observation }
    }
    const balanceFields = (data: Json) => Object.fromEntries(['schema_version', 'workspace_id', 'balance_state', 'available_points', 'reserved_points', 'settled_points', 'access_revision'].map(key => [key, data[key]]))
    const assertAllowed = (result: Awaited<ReturnType<typeof call>>, actor: Actor) => {
      assert.equal(result.response.status, 200, 'VERIFY_POINTS_EXPECTED_ALLOW_HTTP_FAILED'); assert(!result.body.error, 'VERIFY_POINTS_EXPECTED_ALLOW_ERROR')
      assert.deepEqual(balanceFields(result.data), { schema_version: 'creative-points.balance.v1', workspace_id: actor.workspaceId, balance_state: 'known',
        available_points: actor.workspaceId === workspaceA ? 1_237 : 9_871, reserved_points: 0, settled_points: 0, access_revision: '1' }, 'VERIFY_POINTS_BALANCE_MISMATCH')
      result.observation.result = balanceFields(result.data)
    }
    const assertCapabilityDenied = (result: Awaited<ReturnType<typeof call>>) => {
      assert.equal(result.response.status, result.observation.surface === 'http' ? 403 : 200, 'VERIFY_POINTS_EXPECTED_DENY_STATUS_MISMATCH')
      assert.equal(result.observation.code, 'FORBIDDEN', 'VERIFY_POINTS_EXPECTED_DENY_CODE_MISMATCH')
      assert.equal(result.observation.capability, 'billing.workspace.read', 'VERIFY_POINTS_DENIED_AT_WRONG_CAPABILITY')
      assert.equal(result.observation.reasonCode, 'AUTHZ_CAPABILITY_MISSING', 'VERIFY_POINTS_DENIED_FOR_WRONG_REASON')
      assert(!result.data && !result.body.result, 'VERIFY_POINTS_DENIED_BALANCE_DISCLOSED')
      assert(result.observation.requestId, 'VERIFY_POINTS_DENIAL_CORRELATION_MISSING')
    }
    stage = 'role_matrix'
    for (const actor of actors) for (const surface of ['http', 'native-mcp'] as const) {
      const result = await call(surface, `${actor.role}:${actor.workspaceId === workspaceB ? 'other-tenant' : 'current-tenant'}`, actor)
      if (['workspace_owner', 'merchant_admin', 'finance'].includes(actor.role)) assertAllowed(result, actor)
      else assertCapabilityDenied(result)
    }
    stage = 'missing_credentials_and_tenant_tampering'
    for (const surface of ['http', 'native-mcp'] as const) {
      const anonymous = await call(surface, 'anonymous')
      assert.equal(anonymous.response.status, 401, 'VERIFY_POINTS_ANONYMOUS_ACCEPTED'); assert(!anonymous.data, 'VERIFY_POINTS_ANONYMOUS_DISCLOSURE')
      const cross = await call(surface, 'forged-tenant-header', actors[0], { workspace: workspaceB })
      assert.equal(cross.response.status, 403, 'VERIFY_POINTS_CROSS_TENANT_ACCEPTED'); assert(!cross.data, 'VERIFY_POINTS_CROSS_TENANT_DISCLOSURE')
    }
    assertAllowed(await call('http', 'query-does-not-widen-scope', actors[0], { query: `?workspace_id=${encodeURIComponent(workspaceB)}` }), actors[0]!)
    const parameterCross = await call('native-mcp', 'forged-tenant-argument', actors[0], { params: { workspace_id: workspaceB } })
    assert.equal(parameterCross.response.status, 200, 'VERIFY_POINTS_NATIVE_TENANT_ERROR_STATUS_MISMATCH')
    assert(['FORBIDDEN', 'WORKSPACE_SCOPE_MISMATCH'].includes(parameterCross.observation.code ?? ''), 'VERIFY_POINTS_NATIVE_TENANT_ARGUMENT_NOT_REJECTED')
    assert(!parameterCross.data, 'VERIFY_POINTS_NATIVE_TENANT_ARGUMENT_DISCLOSURE')
    stage = 'adjacent_billing_status_observation'
    const status = await call('native-mcp', 'operator-billing-status-observation', actors[3], { tool: 'billing.status' })
    if (status.data) status.observation.result = Object.fromEntries(['schema_version', 'balance_state', 'available_points', 'reserved_points', 'settled_points', 'access_revision', 'next_actions', 'recovery_methods'].map(key => [key, status.data[key] ?? null]))
    // This records the adjacent contract; it deliberately makes no assertion
    // that denying balance.get hides all balances elsewhere in the system.
    assertCapabilityDenied(await call('native-mcp', 'operator-balance-recovery-action', actors[3]))
    stage = 'real_ops_revocation'
    const owner = actors[0]!, finance = actors[2]!
    const opsRpc = async (method: string, params: Json = {}) => {
      const response = await request(`${opsBase}/mcp`, { method: 'POST', headers: { cookie: owner.cookie!, 'x-workspace-id': workspaceA, 'x-ops-workbench': 'workspace', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })
      const body = await response.json() as Json
      assert.equal(response.status, 200, 'VERIFY_POINTS_OPS_MUTATION_HTTP_FAILED'); assert(!body.error, 'VERIFY_POINTS_OPS_MUTATION_FAILED')
      return body.data?.result as Json
    }
    const members = await opsRpc('ops.members.list') as unknown as Json[]
    const current = members.find(member => member.externalSubject === finance.login)
    assert(current?.role === 'finance' && Number.isInteger(current.revision), 'VERIFY_POINTS_REVOCATION_TARGET_INVALID')
    const revoked = await opsRpc('ops.member.upsert', { external_subject: finance.login, role: 'operator', status: 'active', expected_revision: String(current.revision), reason: 'isolated live finance capability revocation acceptance' })
    assert.equal(revoked.role, 'operator', 'VERIFY_POINTS_REVOCATION_NOT_DURABLE')
    // The original password cookie and PKCE token remain unchanged; no sleep,
    // re-login, server restart or manual cache invalidation may hide stale auth.
    for (const surface of ['http', 'native-mcp'] as const) assertCapabilityDenied(await call(surface, 'finance-revoked-same-session', finance))
    for (const surface of ['http', 'native-mcp'] as const) assertAllowed(await call(surface, 'owner-unaffected-after-revocation', owner), owner)
    stage = 'audit_and_ledger_verification'
    audits = (await admin.query(`SELECT workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason FROM workspace_operation_audit
      WHERE workspace_id=ANY($1::text[]) AND (action='authz.decision' OR action='member.upsert') ORDER BY created_at,id`, [[workspaceA, workspaceB]])).rows
    const deniedObservations = observations.filter(item => item.reasonCode === 'AUTHZ_CAPABILITY_MISSING')
    assert.equal(deniedObservations.length, 8, 'VERIFY_POINTS_EXPECTED_DENIAL_CASE_MISSING')
    for (const observation of deniedObservations) {
      const matches = audits.filter(audit => audit.action === 'authz.decision' && audit.after_json.request_id === observation.requestId)
      // Cross-tenant requests can be denied and audited in the requested
      // tenant. Inspect BOTH owned fixtures and verify that exact scope; never
      // omit the negative probe or relax the one-decision-per-request rule.
      const check = { name: observation.name, surface: observation.surface, requestId: observation.requestId,
        expectedWorkspaceId: observation.requestWorkspaceId, expectedActorId: observation.actorId, matchCount: matches.length, verified: false,
        matches: matches.map(audit => ({ workspaceId: audit.workspace_id, actorId: audit.actor_id, method: audit.resource_id,
          capability: audit.after_json.capability, result: audit.after_json.result, reasonCode: audit.after_json.reason_code })) }
      denialAuditChecks.push(check)
      assert.equal(matches.length, 1, 'VERIFY_POINTS_DENIAL_AUDIT_MISSING_OR_DUPLICATE')
      assert.equal(matches[0]!.workspace_id, observation.requestWorkspaceId, 'VERIFY_POINTS_DENIAL_AUDIT_WORKSPACE_MISMATCH')
      assert.equal(matches[0]!.after_json.capability, 'billing.workspace.read', 'VERIFY_POINTS_DENIAL_AUDIT_CAPABILITY_MISMATCH')
      assert.equal(matches[0]!.after_json.result, 'deny', 'VERIFY_POINTS_DENIAL_AUDIT_RESULT_MISMATCH')
      assert.equal(matches[0]!.actor_id, observation.actorId, 'VERIFY_POINTS_DENIAL_AUDIT_ACTOR_MISMATCH')
      assert.equal(matches[0]!.resource_type, 'mcp_method', 'VERIFY_POINTS_DENIAL_AUDIT_TYPE_MISMATCH')
      assert.equal(matches[0]!.resource_id, observation.tool, 'VERIFY_POINTS_DENIAL_AUDIT_METHOD_MISMATCH')
      assert.equal(matches[0]!.after_json.reason_code, observation.reasonCode, 'VERIFY_POINTS_DENIAL_AUDIT_REASON_MISMATCH')
      check.verified = true
      denialAuditsVerified += 1
    }
    const mutations = audits.filter(audit => audit.action === 'member.upsert' && audit.resource_id === finance.login)
    assert.equal(mutations.length, 1, 'VERIFY_POINTS_REVOCATION_AUDIT_MISSING_OR_DUPLICATE')
    assert.equal(mutations[0]!.workspace_id, workspaceA, 'VERIFY_POINTS_REVOCATION_AUDIT_WORKSPACE_MISMATCH')
    assert.equal(mutations[0]!.actor_id, owner.identityId, 'VERIFY_POINTS_REVOCATION_AUDIT_ACTOR_MISMATCH')
    assert.equal(mutations[0]!.before_json.role, 'finance', 'VERIFY_POINTS_REVOCATION_AUDIT_BEFORE_MISSING')
    assert.equal(mutations[0]!.after_json.role, 'operator', 'VERIFY_POINTS_REVOCATION_AUDIT_AFTER_MISSING')
    revocationAuditVerified = true
    stateAfter = await ledgerState(); assert.deepEqual(stateAfter, stateBefore, 'VERIFY_POINTS_LEDGER_CHANGED')
    after = await fingerprint(); assert.deepEqual(after, before, 'VERIFY_POINTS_SOURCE_CHANGED_DURING_ACCEPTANCE')
  } catch (error) {
    // Fixed codes only: native errors/stack traces can contain generated URLs,
    // cookie values, OAuth codes, or SQL parameters. Do not persist them.
    const message = error instanceof Error ? error.message.split('\n')[0]! : ''
    errors.push(/^VERIFY_POINTS_[A-Z_]+$/u.test(message) ? message : 'VERIFY_POINTS_ACCEPTANCE_FAILED')
  } finally {
    for (const child of children.reverse()) try { await stopChild(child) } catch { errors.push('VERIFY_POINTS_API_CLEANUP_FAILED') }
    // Capture fresh hashes even on an early runtime failure, never silently
    // reuse evidence for code another workspace changed while this was running.
    try { after = await fingerprint(); assert.deepEqual(after, before) } catch { errors.push('VERIFY_POINTS_SOURCE_CHANGED_DURING_ACCEPTANCE') }
    for (const pool of [app, ops, admin]) try { await pool?.end() } catch { errors.push('VERIFY_POINTS_POOL_CLEANUP_FAILED') }
    if (fixture) try { disposal = await fixture.dispose(); if (disposal.leftRunning.length) errors.push('VERIFY_POINTS_FIXTURE_CLEANUP_INCOMPLETE') } catch { errors.push('VERIFY_POINTS_FIXTURE_CLEANUP_FAILED') }
    if (abort.signal.aborted) errors.push('VERIFY_POINTS_INTERRUPTED')
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
  const result = { schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), status: errors.length ? 'failed' : 'passed', stage,
    errors: [...new Set(errors)], childFailureCodes, runtime, observations, sourceFingerprints: { before, after: after ?? null },
    ledgerUnchanged: Boolean(stateBefore && stateAfter && JSON.stringify(stateBefore) === JSON.stringify(stateAfter)),
    audit: { capabilityDenialsVerified: denialAuditsVerified, revocationAuditVerified, denialChecks: denialAuditChecks,
      memberMutations: audits.filter(item => item.action === 'member.upsert').map(item => ({ actorId: item.actor_id, beforeRole: item.before_json.role, afterRole: item.after_json.role })) },
    exclusions: ['viewer is not a persisted workspace member role', 'explicit deny has no password/OIDC durable configuration; covered separately by API token fixtures', 'billing.status observed only; no global balance-confidentiality assertion'],
    fixtureOnly: true, syntheticPointSeeds: true, syntheticStoreSeeds: true, realPlatformAuthorizations: 0, realPayments: 0, modelCalls: 0, sharedConfigurationRead: false, sharedContainersTouched: false,
    credentialsSaved: false, disposal: disposal ?? null }
  const report = join(evidenceDir, 'run-result.json')
  await writeFile(report, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ status: result.status, stage, errors: result.errors, report }))
  return result.status === 'passed' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  if (process.argv.length === 3 && process.argv[2] === '--api-child') void apiChild().catch(error => {
    const code = safeChildCode(object(error) ? error.code : undefined)
    if (process.send) process.send({ kind: 'failure', code }, () => process.exit(1))
    else process.exit(1)
  })
  else if (process.argv.length !== 2) { console.error('VERIFY_POINTS_ARGUMENTS_NOT_SUPPORTED'); process.exitCode = 1 }
  else void verifyCreativePointAccess().then(code => { process.exitCode = code }, () => { console.error('VERIFY_POINTS_RUN_FAILED'); process.exitCode = 1 })
}
