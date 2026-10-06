import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { signPaymentCallback } from '../packages/billing/src/callback-envelope.mjs'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.js'
import { PostgresPasswordAuthRepository } from '../packages/persistence/src/password-auth-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from '../packages/persistence/src/postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const bridgePath = fileURLToPath(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url))
const callback = 'http://127.0.0.1:19093/merchant-mcp-callback'
const clientId = 'local-desktop'
const verifier = 'commercial-payment-pkce-verifier-0000000000000000000000000000000000'
const challenge = createHash('sha256').update(verifier).digest('base64url')

function databaseUrl(base: URL, databaseName: string, user?: string, password?: string) {
  const value = new URL(base)
  value.pathname = `/${databaseName}`
  if (user) value.username = user
  if (password) value.password = password
  return value.toString()
}

async function startApi(input: { databaseUrl: string; opsDatabaseUrl: string; callbackSecret: string; runtimeEvidencePath: string; runtimeEvidenceSha256: string; fleetObservationPath: string }) {
  const program = [
    "import { setPaymentProviderForTests } from './apps/api/src/server.ts'",
    "setPaymentProviderForTests({ createCheckout: async value => ({ paymentUrl: `https://fixture.invalid/alipay/${value.orderId}`, providerOrderId: `fixture-${value.orderId}` }), refund: async () => ({ providerRefundId: 'fixture-refund' }) })",
  ].join(';')
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      NODE_ENV: 'development',
      VITEST: 'true',
      PERSISTENCE_MODE: 'postgres',
      DATABASE_URL: input.databaseUrl,
      OPS_DATABASE_URL: input.opsDatabaseUrl,
      RUN_MIGRATIONS_ON_STARTUP: 'false',
      PORT: '0',
      API_BIND_HOST: '127.0.0.1',
      AUTH_ENFORCEMENT: 'strict',
      CONNECTOR_FIXTURE_MODE: 'true',
      MERCHANT_TEST_APPROVED_RATES: 'true',
      MCP_INTEGRATION_MODE: 'local_stdio',
      COMMERCIAL_PAYMENT_PROVIDER: 'alipay',
      PAYMENT_MODE: 'provider',
      PAYMENT_CALLBACK_BASE_URL: 'https://fixture.invalid/callbacks',
      PAYMENT_CALLBACK_SECRET: input.callbackSecret,
      COMMERCIAL_RUNTIME_EVIDENCE_PATH: input.runtimeEvidencePath,
      COMMERCIAL_RUNTIME_EVIDENCE_SHA256: input.runtimeEvidenceSha256,
      COMMERCIAL_RUNTIME_CANDIDATE_SHA256: 'a'.repeat(64),
      COMMERCIAL_RUNTIME_SCHEMA_SHA256: 'a'.repeat(64),
      COMMERCIAL_RUNTIME_FLEET_ATTESTER_REF: 'isolated-test-fleet',
      COMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH: input.fleetObservationPath,
      API_RATE_LIMIT_PER_MINUTE: '10000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return await new Promise<{ child: ChildProcessWithoutNullStreams; base: string; logs: () => { stdout: string; stderr: string } }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error(`API_START_TIMEOUT:${stderr.slice(-500)}`)), 30_000)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      const match = /merchant API listening on .*"port":(\d+)/u.exec(stdout)
      if (!match) return
      clearTimeout(timeout)
      resolve({ child, base: `http://127.0.0.1:${match[1]}`, logs: () => ({ stdout, stderr }) })
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`API_EXITED_BEFORE_LISTEN:${code}:${stderr.slice(-500)}`)) })
  })
}

async function stopApi(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
  })
}

function nextBridgeLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      stream.off('data', onData)
      stream.off('error', onError)
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    const onError = (error: Error) => {
      stream.off('data', onData)
      reject(error)
    }
    stream.on('data', onData)
    stream.once('error', onError)
  })
}

function startBridge(base: string, workspaceId: string, token: string) {
  return spawn(process.execPath, [bridgePath], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      NODE_ENV: 'test',
      DEPLOY_ENV: 'test',
      MERCHANT_MCP_BASE_URL: base,
      MERCHANT_WORKSPACE_ID: workspaceId,
      MERCHANT_MCP_TOKEN: token,
      MERCHANT_STRICT_AUTH: 'true',
      // The isolated fixture represents the operator-approved checkout path;
      // the bridge still forwards the real authenticated OAuth token.
      MERCHANT_MCP_WRITE_ENABLED: 'true',
      MERCHANT_MCP_TIMEOUT_MS: '30000',
      MERCHANT_MCP_RETRY_ATTEMPTS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function bridgeCall(child: ChildProcessWithoutNullStreams, id: number, name: string, arguments_: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })}\n`)
  return await nextBridgeLine(child.stdout) as { result?: { isError?: boolean; structuredContent?: Record<string, any> }; error?: Record<string, unknown> }
}

describe('local stdio plugin commercial point-pack payment PostgreSQL vertical', () => {
  it('grants one point pack to the canonical buyer exactly once and camouflages it from another workspace member', async () => {
    if (!databaseUrlValue) throw new Error('PERSISTENCE_RELEASE_DATABASE_URL_REQUIRED')
    const baseDatabase = new URL(databaseUrlValue)
    const suffix = randomUUID().replaceAll('-', '')
    const databaseName = `oauth_commercial_${suffix}`
    const admin = new Pool({ connectionString: baseDatabase.toString() })
    let database: Pool | undefined
    let application: Pool | undefined
    let operations: Pool | undefined
    let api: ChildProcessWithoutNullStreams | undefined
    let runtimeEvidenceDir: string | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolatedAdminUrl = databaseUrl(baseDatabase, databaseName)
      database = new Pool({ connectionString: isolatedAdminUrl })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(await readFile(new URL('../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      const workspaceId = `ws_oauth_commercial_${suffix}`
      const otherWorkspaceId = `ws_oauth_commercial_other_${suffix}`
      await database.query('INSERT INTO workspaces(id,status) VALUES ($1,\'active\'),($2,\'active\')', [workspaceId, otherWorkspaceId])
      // This vertical test starts after onboarding. The prerequisite is a
      // durable, explicitly test-owned qualification fixture; the point-pack
      // order and payment remain exercised through the real OAuth/MCP path.
      const onboardingSku = (await database.query<{ skuId: string; versionId: string }>(
        `SELECT s.id AS "skuId", v.id AS "versionId"
           FROM commercial_catalog_skus s
           JOIN commercial_catalog_sku_versions v ON v.sku_id=s.id
          WHERE s.code='onboarding_once' AND v.lifecycle='approved' AND v.executable
          ORDER BY v.version DESC LIMIT 1`,
      )).rows[0]!
      const fixtureOnboardingOrderId = `fixture-onboarding-${suffix}`
      await database.query(
        `INSERT INTO commercial_orders_v2
          (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at,paid_at)
         VALUES ($1,$2,$3,$4,500000,'CNY','fixture','paid',$5,$6,'isolated-test-operator',now(),now())`,
        [fixtureOnboardingOrderId, workspaceId, onboardingSku.skuId, onboardingSku.versionId, `fixture-onboarding-key-${suffix}`, 'a'.repeat(64)],
      )
      await database.query(
        `INSERT INTO workspace_commercial_onboarding_v3(workspace_id,onboarding_order_id,status,activated_at)
         VALUES ($1,$2,'active',now())`,
        [workspaceId, fixtureOnboardingOrderId],
      )
      const otherExternalSubject = `other-${suffix}@example.test`
      await database.query(
        `INSERT INTO workspace_members (id, workspace_id, external_subject, display_name, role, status, invited_by)
         VALUES ($1,$2,$3,'Other workspace owner','workspace_owner','active','isolated-oauth-e2e')`,
        [randomUUID(), otherWorkspaceId, otherExternalSubject],
      )

      const appUrl = databaseUrl(baseDatabase, databaseName, 'merchant_app', 'merchant_app_local_only')
      const opsUrl = databaseUrl(baseDatabase, databaseName, 'merchant_ops', 'merchant_ops_local_only')
      application = new Pool({ connectionString: appUrl })
      operations = new Pool({ connectionString: opsUrl })
      const tenantClient = await application.connect()
      try {
        await tenantClient.query('BEGIN')
        await tenantClient.query(`SELECT set_config('app.platform_scope','platform_ops',true)`)
        await expect(tenantClient.query('SELECT id FROM mcp_oauth_tokens LIMIT 1')).rejects.toMatchObject({ code: '42501' })
        await tenantClient.query('ROLLBACK')
        await tenantClient.query('BEGIN')
        await tenantClient.query(`SELECT set_config('app.workspace_id',$1,true)`, [workspaceId])
        const crossWorkspaceWrite = await tenantClient.query(
          'UPDATE workspace_members SET display_name=\'tampered\' WHERE workspace_id=$1 AND external_subject=$2',
          [otherWorkspaceId, otherExternalSubject],
        )
        expect(crossWorkspaceWrite.rowCount).toBe(0)
        await tenantClient.query('ROLLBACK')
      } finally {
        await tenantClient.query('ROLLBACK').catch(() => undefined)
        tenantClient.release()
      }
      await expect(database.query('SELECT display_name FROM workspace_members WHERE workspace_id=$1 AND external_subject=$2', [otherWorkspaceId, otherExternalSubject]))
        .resolves.toMatchObject({ rows: [{ display_name: 'Other workspace owner' }] })
      const accounts = new PostgresPasswordAuthRepository(operations)
      const merchants = await Promise.all(['a', 'b'].map(async label => {
        const login = `point-${label}-${suffix}@example.test`
        const password = `PointPack${label.toUpperCase()}1234!`
        const account = await accounts.createMerchantAccount({ login, password, enterpriseName: `Point pack ${label}`, contactName: `Buyer ${label}`, workspaceIds: [workspaceId], actorId: 'isolated-test-operator', reason: 'isolated OAuth point pack acceptance' })
        await database!.query(
          `INSERT INTO workspace_members (id, workspace_id, external_subject, display_name, role, status, invited_by)
           VALUES ($1,$2,$3,$4,'workspace_owner','active','isolated-oauth-e2e')`,
          [randomUUID(), workspaceId, login, `Buyer ${label}`],
        )
        return { account, login, password }
      }))

      const callbackSecret = `isolated-commercial-callback-${suffix}`
      runtimeEvidenceDir = mkdtempSync(join(tmpdir(), 'merchant-commercial-runtime-'))
      const runtimeEvidencePath = join(runtimeEvidenceDir, 'lease.json')
      const fleetObservationPath = join(runtimeEvidenceDir, 'fleet.json')
      const candidateSha256 = 'a'.repeat(64)
      const schemaSha256 = 'a'.repeat(64)
      const instance = { instanceId: hostname(), salesProtocol: 'commercial.sales.v3', candidateSha256, schemaSha256 }
      const now = Date.now()
      const fleet = { schema: 'commercial.fleet.observation.v1', attesterRef: 'isolated-test-fleet', capturedAt: new Date(now).toISOString(), completeInventory: true, inventory: [instance.instanceId], instances: [instance] }
      writeFileSync(fleetObservationPath, JSON.stringify(fleet), { mode: 0o600 })
      const runtimeEvidence = { schema: 'commercial.runtime.evidence.v1', issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), fleetAttesterRef: 'isolated-test-fleet', policy: { mode: 'sale', policyRevision: 'isolated-commercial-payment-test', approvedEvidenceRef: 'isolated-test-approval', catalogManualAuditRef: 'isolated-test-catalog-audit', runtimeAcceptanceRef: 'isolated-test-runtime-acceptance', catalogAuditSha256: 'a'.repeat(64), candidateSha256, schemaSha256, fleetEvidenceRef: 'isolated-test-fleet-evidence', deploymentEvidenceVerified: true, activeInstances: [instance] } }
      const evidenceRaw = JSON.stringify(runtimeEvidence)
      writeFileSync(runtimeEvidencePath, evidenceRaw, { mode: 0o600 })
      const running = await startApi({ databaseUrl: appUrl, opsDatabaseUrl: opsUrl, callbackSecret, runtimeEvidencePath, runtimeEvidenceSha256: createHash('sha256').update(evidenceRaw).digest('hex'), fleetObservationPath })
      api = running.child
      const resource = `${running.base}/mcp`
      const authorizeAndExchange = async (merchant: (typeof merchants)[number]) => {
        const issued = await accounts.issueMcpAuthorizationCode({
          account: merchant.account, clientId, redirectUri: callback, codeChallenge: challenge,
          issuer: running.base, audience: resource, resource, scope: ['merchant'], workspaceId,
        })
        const exchanged = await fetch(`${running.base}/v1/auth/local-plugin/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code: issued.code, code_verifier: verifier, resource, workspace_id: workspaceId }) })
        expect(exchanged.status).toBe(200)
        return ((await exchanged.json() as { data: { access_token: string } }).data).access_token
      }
      const [tokenA, tokenB] = await Promise.all([authorizeAndExchange(merchants[0]!), authorizeAndExchange(merchants[1]!)])
      // These are real local-plugin PKCE-issued merchant tokens. The session
      // endpoint reports their workspace identity but cannot promote them to
      // the platform operations workbench.
      for (const token of [tokenA, tokenB]) {
        const opsSession = await fetch(`${running.base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'merchant-oauth-ops-session-denied', method: 'ops.session', params: {} }),
        })
        expect(opsSession.status).toBe(200)
        expect(await opsSession.json()).toMatchObject({ data: { result: { workbench: 'workspace', workspace_id: workspaceId } } })
        const platformUsers = await fetch(`${running.base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'merchant-oauth-platform-users-denied', method: 'ops.users.list', params: {} }),
        })
        expect(platformUsers.status).toBe(403)
        expect(await platformUsers.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: '商家 OAuth 会话不能访问平台运营工作台' } })
      }
      const bridgeA = startBridge(running.base, workspaceId, tokenA)
      const bridgeB = startBridge(running.base, workspaceId, tokenB)
      const stopBridge = (child: ChildProcessWithoutNullStreams) => { if (child.exitCode === null) child.kill('SIGTERM') }

      const createdViaBridge = await bridgeCall(bridgeA, 1, 'commercial.order.create', { purchase_kind: 'point_pack', sku_code: 'points_500', idempotency_key: `oauth-point-pack-${suffix}`, reason: '购买 500 创意点测试包' })
      expect(createdViaBridge.result).toMatchObject({ isError: false })
      const created = { status: 200, body: { result: createdViaBridge.result } }
      expect(created.status, JSON.stringify({ body: created.body, logs: running.logs() })).toBe(200)
      const order = created.body.result?.structuredContent as { order_id: string; status: string; amount_fen: number; payment_provider: string; payment_url: string | null; created_at: string }
      expect(order).toMatchObject({ status: 'pending', amount_fen: 30000, payment_provider: 'alipay' })
      const paymentViaBridge = await bridgeCall(bridgeA, 2, 'commercial.order.payment.create', { order_id: order.order_id, idempotency_key: `oauth-point-pack-payment-${suffix}` })
      expect(paymentViaBridge.result).toMatchObject({ isError: false })
      const payment = paymentViaBridge.result?.structuredContent as { payment_url: string; provider_order_id: string }
      expect(payment.payment_url).toMatch(/^https:\/\/fixture\.invalid\/alipay\//u)

      const providerTradeId = payment.provider_order_id
      const callbackPayload = { workspace_id: workspaceId, order_id: order.order_id, provider_trade_id: providerTradeId, amount_fen: 30000, currency: 'CNY' as const, state: 'paid' as const }
      const timestampSeconds = Math.floor(Date.parse(order.created_at) / 1000) + 1
      const waitForSignedAt = timestampSeconds * 1000 - Date.now()
      if (waitForSignedAt > 0) await new Promise(resolve => setTimeout(resolve, waitForSignedAt))
      const timestamp = String(timestampSeconds)
      const nonce = `commercial-${randomUUID().replaceAll('-', '')}`
      const signature = signPaymentCallback({ secret: callbackSecret, channel: 'alipay', workspaceId, orderId: order.order_id, providerTradeId, amountFen: 30000, currency: 'CNY', state: 'paid', timestamp, nonce })
      const callbackHeaders = { 'content-type': 'application/json', 'x-payment-signature': signature, 'x-payment-timestamp': timestamp, 'x-payment-nonce': nonce }
      for (const replayed of [false, true]) {
        const response = await fetch(`${running.base}/v1/commercial/callback/alipay`, { method: 'POST', headers: callbackHeaders, body: JSON.stringify(callbackPayload) })
        const callbackResult = await response.json()
        expect(response.status, JSON.stringify({ callbackResult, logs: running.logs() })).toBe(200)
        expect(callbackResult).toMatchObject({ data: { state: 'paid', replayed }, error: null })
      }

      const paidViaBridge = await bridgeCall(bridgeA, 3, 'commercial.order.payment.get', { order_id: order.order_id })
      expect(paidViaBridge.result).toMatchObject({ isError: false, structuredContent: { order_id: order.order_id, status: 'paid', access_revision: 2 } })
      const balanceViaBridge = await bridgeCall(bridgeA, 4, 'creative-points.balance.get', {})
      // The merchant bridge exposes the authenticated wallet balance so the
      // user can decide whether another paid generation is affordable.
      expect(balanceViaBridge.result).toMatchObject({ isError: false, structuredContent: { balance_state: 'known', access_revision: '2', available_points: 10500 } })

      const hiddenFromB = await bridgeCall(bridgeB, 5, 'commercial.order.payment.get', { order_id: order.order_id })
      expect(hiddenFromB.result).toMatchObject({ isError: true, structuredContent: { code: 'COMMERCIAL_ORDER_NOT_FOUND' } })

      const evidence = await database.query(`
        SELECT g.id AS grant_id,g.points::int,o.created_by_actor_id,
          (SELECT count(*)::int FROM commercial_payment_events_v2 e WHERE e.workspace_id=o.workspace_id AND e.order_id=o.id) AS payment_events,
          (SELECT count(*)::int FROM creative_point_ledger_events l WHERE l.workspace_id=g.workspace_id AND l.operation_id=g.operation_id AND l.event_type='granted') AS ledger_events
        FROM creative_point_grants g JOIN commercial_orders_v2 o ON o.workspace_id=g.workspace_id AND o.id=g.source_id
        WHERE g.workspace_id=$1 AND g.source_type='commercial_order_v2' AND g.source_id=$2`, [workspaceId, order.order_id])
      expect(evidence.rows).toEqual([{ grant_id: expect.stringMatching(/^cpg_/u), points: 500, created_by_actor_id: merchants[0]!.account.identityId, payment_events: 1, ledger_events: 1 }])
      const identityBindings = await database.query(
        'SELECT external_subject,identity_id::text FROM workspace_members WHERE workspace_id=$1 ORDER BY external_subject',
        [workspaceId],
      )
      expect(identityBindings.rows).toEqual([
        { external_subject: merchants[0]!.login, identity_id: merchants[0]!.account.identityId },
        { external_subject: merchants[1]!.login, identity_id: merchants[1]!.account.identityId },
      ].sort((a, b) => a.external_subject.localeCompare(b.external_subject)))
      stopBridge(bridgeA)
      stopBridge(bridgeB)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        if (api) await stopApi(api)
        await application?.end()
        await operations?.end()
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
        if (runtimeEvidenceDir) rmSync(runtimeEvidenceDir, { recursive: true, force: true })
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
