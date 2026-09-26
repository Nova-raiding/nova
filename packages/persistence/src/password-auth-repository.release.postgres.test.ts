import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import argon2 from 'argon2'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPasswordAuthRepository } from './password-auth-repository.js'
import { runFirstInstall } from '../../../scripts/bootstrap-first-install.js'
import { PostgresWorkspaceBootstrapRepository } from './workspace-bootstrap-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('password registration and enterprise projection PostgreSQL acceptance', () => {
  postgresIt('keeps the enterprise projection least-privileged and completes registration review', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_password_auth_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString(), max: 3 })
    let database: Pool | undefined
    let ops: Pool | undefined
    let app: Pool | undefined

    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName), max: 3 })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      // This test creates its own database; role grants in the launcher's
      // template database do not follow CREATE DATABASE into this one.
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))

      const workspaceId = `registration_ws_${randomUUID().replaceAll('-', '')}`
      const untouchedWorkspaceId = `registration_other_${randomUUID().replaceAll('-', '')}`
      await database.query(
        `INSERT INTO workspaces (id, status) VALUES ($1, 'active'), ($2, 'active')`,
        [workspaceId, untouchedWorkspaceId],
      )
      const initialEnterprises = await database.query<{ id: string; name: string }>(
        `SELECT id, name FROM enterprises WHERE id IN ($1, $2) ORDER BY id`,
        [workspaceId, untouchedWorkspaceId],
      )
      expect(initialEnterprises.rows).toHaveLength(2)

      const acl = await database.query<{ privilege: string; can: boolean }>(`
        SELECT privilege,
               has_table_privilege('merchant_ops', 'enterprises', privilege) AS can
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']::text[]) AS privileges(privilege)
        ORDER BY privilege`)
      expect(acl.rows).toEqual([
        { privilege: 'DELETE', can: false },
        { privilege: 'INSERT', can: false },
        { privilege: 'SELECT', can: true },
        { privilege: 'TRUNCATE', can: false },
        { privilege: 'UPDATE', can: false },
      ])
      await expect(database.query(`
        SELECT has_table_privilege('merchant_ops', 'workspace_members', 'SELECT') AS "canSelect",
               has_table_privilege('merchant_ops', 'workspace_members', 'DELETE') AS "canDelete",
               has_table_privilege('merchant_ops', 'workspace_members', 'TRUNCATE') AS "canTruncate",
               has_column_privilege('merchant_ops', 'workspace_members', 'identity_id', 'UPDATE') AS "canBindIdentity",
               has_column_privilege('merchant_ops', 'workspace_members', 'revision', 'UPDATE') AS "canBumpRevision",
               has_column_privilege('merchant_ops', 'workspace_members', 'updated_at', 'UPDATE') AS "canSetUpdatedAt",
               has_column_privilege('merchant_ops', 'workspace_members', 'display_name', 'UPDATE') AS "canRewriteDisplayName"`))
        .resolves.toMatchObject({ rows: [{
          canSelect: true,
          canDelete: false,
          canTruncate: false,
          canBindIdentity: true,
          canBumpRevision: true,
          canSetUpdatedAt: true,
          canRewriteDisplayName: false,
        }] })
      const functionAcl = await database.query<{ executable: boolean; publicExecutable: boolean; securityDefiner: boolean }>(`
        SELECT has_function_privilege('merchant_ops', 'public.sync_enterprise_name_for_workspaces(text[],text)', 'EXECUTE') AS executable,
               has_function_privilege('public', 'public.sync_enterprise_name_for_workspaces(text[],text)', 'EXECUTE') AS "publicExecutable",
               p.prosecdef AS "securityDefiner"
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'sync_enterprise_name_for_workspaces'`)
      expect(functionAcl.rows).toEqual([{ executable: true, publicExecutable: false, securityDefiner: true }])

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 2 })
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      const directClient = await ops.connect()
      try {
        await directClient.query('BEGIN')
        await directClient.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
        await expect(directClient.query(`UPDATE enterprises SET name = '越权写入' WHERE id = $1`, [workspaceId])).rejects.toMatchObject({ code: '42501' })
        await directClient.query('ROLLBACK')
      } finally {
        directClient.release()
      }

      const repository = new PostgresPasswordAuthRepository(ops)
      const bootstrapHash = await argon2.hash('BootstrapPass123', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
      const bootstrapLogin = `first-admin-${randomUUID().replaceAll('-', '')}@example.com`
      const concurrentBootstraps = await Promise.all([
        repository.bootstrapFirstPlatformAdmin({ login: bootstrapLogin, passwordHash: bootstrapHash }),
        new PostgresPasswordAuthRepository(ops).bootstrapFirstPlatformAdmin({ login: bootstrapLogin, passwordHash: bootstrapHash }),
      ])
      expect(concurrentBootstraps.map(result => result.status).sort()).toEqual(['created', 'existing'])
      const bootstrap = concurrentBootstraps.find(result => result.status === 'created')!
      const retry = await repository.bootstrapFirstPlatformAdmin({ login: bootstrapLogin, passwordHash: bootstrapHash })
      expect(retry).toEqual({ identityId: bootstrap.identityId, status: 'existing' })
      await expect(repository.bootstrapFirstPlatformAdmin({ login: `other-admin-${randomUUID().replaceAll('-', '')}@example.com`, passwordHash: bootstrapHash })).rejects.toThrow('PLATFORM_ADMIN_BOOTSTRAP_CONFLICT')
      const durableAdmin = await ops.connect()
      try {
        await durableAdmin.query('BEGIN READ ONLY')
        await durableAdmin.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
        const assignments = await durableAdmin.query<{ role: string; authorization_revision: string }>(`SELECT role,authorization_revision FROM platform_role_assignments WHERE subject_identity_id=$1`, [bootstrap.identityId])
        const revisions = await durableAdmin.query<{ revision: string }>(`SELECT revision FROM authorization_revisions WHERE subject_identity_id=$1`, [bootstrap.identityId])
        const events = await durableAdmin.query<{ event_type: string; authorization_revision: string }>(`SELECT event_type,authorization_revision FROM platform_role_assignment_events WHERE subject_identity_id=$1`, [bootstrap.identityId])
        expect(assignments.rows).toEqual([{ role: 'platform_admin', authorization_revision: '1' }])
        expect(revisions.rows).toEqual([{ revision: '1' }])
        expect(events.rows).toEqual([{ event_type: 'assigned', authorization_revision: '1' }])
        await durableAdmin.query('COMMIT')
      } catch (error) {
        await durableAdmin.query('ROLLBACK')
        throw error
      } finally {
        durableAdmin.release()
      }
      const firstInstallEnv = {
        FIRST_INSTALL_WORKSPACE_ID: 'ws_guirenniaoniao',
        FIRST_INSTALL_PLATFORM_LOGIN: bootstrapLogin,
        FIRST_INSTALL_PLATFORM_PASSWORD_HASH: bootstrapHash,
        FIRST_INSTALL_MERCHANT_LOGIN: `first-owner-${randomUUID().replaceAll('-', '')}@example.com`,
        FIRST_INSTALL_MERCHANT_PASSWORD: 'MerchantPass123',
        FIRST_INSTALL_MERCHANT_TERMS_AGREED: 'true',
        FIRST_INSTALL_ENTERPRISE_NAME: 'Initial Merchant',
        FIRST_INSTALL_MERCHANT_DISPLAY_NAME: 'Initial Owner',
        FIRST_INSTALL_REASON: 'Verified first workspace installation',
        FIRST_INSTALL_OPS_DATABASE_URL: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'),
        FIRST_INSTALL_ADMIN_DATABASE_URL: connection(base, databaseName),
      }
      const installed = await runFirstInstall(firstInstallEnv)
      expect(installed).toMatchObject({ platformIdentityId: bootstrap.identityId, platformStatus: 'existing', workspaceId: 'ws_guirenniaoniao', workspaceCreated: true })
      await expect(runFirstInstall(firstInstallEnv)).resolves.toMatchObject({ platformIdentityId: bootstrap.identityId, merchantIdentityId: installed.merchantIdentityId, workspaceCreated: false })
      const installedRows = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM workspace_members WHERE workspace_id='ws_guirenniaoniao' AND identity_id=$1 AND role='workspace_owner' AND status='active'`, [installed.merchantIdentityId])
      expect(installedRows.rows).toEqual([{ count: '1' }])
      const login = `registration-${randomUUID().replaceAll('-', '')}@example.com`
      const registered = await repository.register({
        login,
        password: 'CorrectHorse123',
        enterpriseName: '真实注册企业',
        contactName: '注册联系人',
        termsAgreed: true,
      })
      expect(registered.account).toMatchObject({ login, status: 'merchant_pending', workspaceIds: [] })

      // The helper must restore a caller-provided local workspace scope.
      const scopedClient = await ops.connect()
      try {
        await scopedClient.query('BEGIN')
        await scopedClient.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
        await scopedClient.query("SELECT set_config('app.workspace_id', 'caller_scope', true)")
        await scopedClient.query(
          'SELECT public.sync_enterprise_name_for_workspaces($1::text[], $2::text)',
          [[workspaceId], '事务范围企业'],
        )
        await expect(scopedClient.query("SELECT current_setting('app.workspace_id', true) AS workspace_id")).resolves.toMatchObject({ rows: [{ workspace_id: 'caller_scope' }] })
        await scopedClient.query('ROLLBACK')
      } finally {
        scopedClient.release()
      }

      const unsetScopeClient = await ops.connect()
      try {
        await unsetScopeClient.query('BEGIN')
        await unsetScopeClient.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
        await unsetScopeClient.query(
          'SELECT public.sync_enterprise_name_for_workspaces($1::text[], $2::text)',
          [[workspaceId], '恢复未设置范围'],
        )
        // PostgreSQL materializes an assigned custom GUC with an empty
        // default after RESET; the empty value is the fail-closed equivalent
        // of an unset workspace scope for every RLS policy.
        await expect(unsetScopeClient.query("SELECT current_setting('app.workspace_id', true) AS workspace_id")).resolves.toMatchObject({ rows: [{ workspace_id: '' }] })
        await unsetScopeClient.query('ROLLBACK')
      } finally {
        unsetScopeClient.release()
      }

      const reviewed = await repository.reviewMerchantRegistration({
        login,
        decision: 'approved',
        workspaceIds: [workspaceId],
        actorId: 'platform-reviewer-e2e',
        reason: '通过真实注册审核并绑定企业工作区',
      })
      expect(reviewed).toMatchObject({ login, status: 'active', workspaceIds: [workspaceId], revision: 2 })
      await expect(repository.login({ login, password: 'CorrectHorse123' })).resolves.toMatchObject({ principal: { account: { login, status: 'active', workspaceIds: [workspaceId] } } })

      const names = await database.query<{ id: string; name: string }>(
        `SELECT id, name FROM enterprises WHERE id IN ($1, $2) ORDER BY id`,
        [workspaceId, untouchedWorkspaceId],
      )
      expect(names.rows).toEqual([
        { id: untouchedWorkspaceId, name: `Enterprise ${untouchedWorkspaceId}` },
        { id: workspaceId, name: '真实注册企业' },
      ].sort((left, right) => left.id.localeCompare(right.id)))

      // The tenant role retains legacy workspace UPDATE capability for
      // unrelated fields, but it cannot move the workspace to another
      // enterprise.  This prevents a tenant-side rebind from changing which
      // enterprise the review projection updates.
      const appClient = await app.connect()
      try {
        await appClient.query('BEGIN')
        await appClient.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId])
        await expect(appClient.query(
          'UPDATE workspaces SET enterprise_id = $2 WHERE id = $1',
          [workspaceId, untouchedWorkspaceId],
        )).rejects.toMatchObject({ code: '42501' })
        await appClient.query('ROLLBACK')
      } finally {
        appClient.release()
      }
      const events = await database.query<{ eventType: string; actorId: string; reason: string }>(`
        SELECT event_type AS "eventType", actor_id AS "actorId", reason
        FROM platform_identity_events
        WHERE identity_id = $1
        ORDER BY created_at, id`, [registered.account.identityId])
      expect(events.rows).toEqual([
        { eventType: 'auth.registered', actorId: login, reason: 'merchant registration' },
        { eventType: 'auth.merchant_activated', actorId: 'platform-reviewer-e2e', reason: '通过真实注册审核并绑定企业工作区' },
        { eventType: 'auth.login_succeeded', actorId: login, reason: 'password authentication succeeded' },
      ])

      // A deliberately provisioned workspace-less merchant gets exactly one
      // identity-bound workspace before any workspace-scoped token is possible.
      const merchantBootstrapLogin = `bootstrap-${randomUUID().replaceAll('-', '')}@example.com`
      const bootstrapAccount = await repository.createMerchantAccount({
        login: merchantBootstrapLogin, password: 'CorrectHorse123', enterpriseName: '专用测试企业',
        contactName: '首个工作区用户', workspaceIds: [], bootstrapWorkspace: true,
        actorId: 'platform-reviewer-e2e', reason: '核验首次工作区引导',
      })
      expect(bootstrapAccount.workspaceIds).toEqual([])
      await database.query(`UPDATE platform_identities SET risk_decision='block' WHERE id=$1`, [bootstrapAccount.identityId])
      await expect(repository.assertBootstrapEligible({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId })).rejects.toMatchObject({ code: 'AUTH_BOOTSTRAP_PRINCIPAL_INVALID' })
      expect((await database.query(`SELECT count(*)::int AS count FROM workspace_identity_bindings WHERE identity_id=$1`, [bootstrapAccount.identityId])).rows[0]?.count).toBe(0)
      await database.query(`UPDATE platform_identities SET risk_decision='allow' WHERE id=$1`, [bootstrapAccount.identityId])
      await repository.assertBootstrapEligible({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId })
      const bootstrapRepository = new PostgresWorkspaceBootstrapRepository(app, ops)
      const first = await bootstrapRepository.bootstrap({
        issuer: 'damai-password', externalSubject: merchantBootstrapLogin, identityId: bootstrapAccount.identityId,
        candidateWorkspaceId: `bootstrap_ws_${randomUUID().replaceAll('-', '')}`,
        displayName: '专用测试工作区', actorId: bootstrapAccount.identityId, allowCreate: true,
      })
      expect(first.created).toBe(true)
      await database.query(`UPDATE platform_identities SET access_status='suspended', suspended_at=now(), suspended_by='security-e2e', suspension_reason='first workspace gate test' WHERE id=$1`, [bootstrapAccount.identityId])
      await expect(repository.bindBootstrappedWorkspace({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId, workspaceId: first.workspaceId })).rejects.toMatchObject({ code: 'AUTH_BOOTSTRAP_PRINCIPAL_INVALID' })
      expect((await repository.listAccounts()).find(account => account.login === merchantBootstrapLogin)?.workspaceIds).toEqual([])
      await database.query(`UPDATE platform_identities SET access_status='active', suspended_at=NULL, suspended_by=NULL, suspension_reason=NULL, risk_decision='block' WHERE id=$1`, [bootstrapAccount.identityId])
      await expect(repository.bindBootstrappedWorkspace({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId, workspaceId: first.workspaceId })).rejects.toMatchObject({ code: 'AUTH_BOOTSTRAP_PRINCIPAL_INVALID' })
      await database.query(`UPDATE platform_identities SET risk_decision='allow' WHERE id=$1`, [bootstrapAccount.identityId])
      const bound = await repository.bindBootstrappedWorkspace({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId, workspaceId: first.workspaceId })
      expect(bound.workspaceIds).toEqual([first.workspaceId])
      expect((await repository.bindBootstrappedWorkspace({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId, workspaceId: first.workspaceId })).workspaceIds).toEqual([first.workspaceId])
      await expect(repository.bindBootstrappedWorkspace({ login: merchantBootstrapLogin, identityId: bootstrapAccount.identityId, workspaceId: untouchedWorkspaceId })).rejects.toMatchObject({ code: 'AUTH_BOOTSTRAP_ACCOUNT_CHANGED' })
      const again = await bootstrapRepository.bootstrap({
        issuer: 'damai-password', externalSubject: merchantBootstrapLogin, identityId: bootstrapAccount.identityId,
        candidateWorkspaceId: `bootstrap_ws_${randomUUID().replaceAll('-', '')}`,
        displayName: '不应创建第二个工作区', actorId: bootstrapAccount.identityId,
      })
      expect(again).toMatchObject({ workspaceId: first.workspaceId, created: false })

      // Exercise the OAuth row locks through two independent repository
      // instances. This is deliberately PostgreSQL-only evidence: the memory
      // adapter cannot prove that concurrent workers serialize on the same
      // authorization code or refresh token.
      await database.query(
        `INSERT INTO workspace_members
          (id, workspace_id, external_subject, display_name, role, status, invited_by)
         VALUES ($1,$2,$3,'OAuth concurrency owner','workspace_owner','active','postgres-oauth-concurrency')`,
        [randomUUID(), workspaceId, login],
      )
      const oauthA = new PostgresPasswordAuthRepository(ops)
      const oauthB = new PostgresPasswordAuthRepository(ops)
      const passwordSession = await oauthA.login({ login, password: 'CorrectHorse123' })
      const passwordRefreshes = await Promise.allSettled([
        oauthA.refresh(passwordSession.token),
        oauthB.refresh(passwordSession.token),
      ])
      const passwordRefreshWinners = passwordRefreshes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof oauthA.refresh>>> => result.status === 'fulfilled')
      const passwordRefreshLosers = passwordRefreshes.filter(result => result.status === 'rejected')
      expect(passwordRefreshWinners).toHaveLength(1)
      expect(passwordRefreshLosers).toHaveLength(1)
      expect(passwordRefreshLosers[0]).toMatchObject({ reason: { code: 'AUTH_SESSION_INVALID' } })
      await expect(oauthA.authenticate(passwordRefreshWinners[0]!.value.token)).resolves.toBeDefined()
      const verifier = 'postgres-oauth-concurrency-verifier-0123456789abcdef'
      const context = {
        clientId: 'chatgpt-postgres-concurrency-client',
        issuer: 'https://oauth.store-nova.example',
        audience: 'https://mcp.store-nova.example/mcp',
        resource: 'https://mcp.store-nova.example/mcp',
        scope: ['merchant'],
      }
      const redirectUri = 'https://chatgpt.com/aip/oauth/callback'
      const issuedCode = await oauthA.issueMcpAuthorizationCode({
        ...context,
        account: reviewed,
        redirectUri,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      })
      await expect(database.query<{ identityId: string }>(
        `SELECT identity_id AS "identityId" FROM workspace_members WHERE workspace_id=$1 AND external_subject=$2`,
        [workspaceId, login],
      )).resolves.toMatchObject({ rows: [{ identityId: registered.account.identityId }] })
      const exchanges = await Promise.allSettled([
        oauthA.exchangeMcpAuthorizationCode({ ...context, redirectUri, code: issuedCode.code, codeVerifier: verifier }),
        oauthB.exchangeMcpAuthorizationCode({ ...context, redirectUri, code: issuedCode.code, codeVerifier: verifier }),
      ])
      const exchanged = exchanges.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof oauthA.exchangeMcpAuthorizationCode>>> => result.status === 'fulfilled')
      const rejectedExchanges = exchanges.filter(result => result.status === 'rejected')
      expect(exchanged).toHaveLength(1)
      expect(rejectedExchanges).toHaveLength(1)
      expect(rejectedExchanges[0]).toMatchObject({ reason: { code: 'MCP_OAUTH_INVALID_GRANT' } })

      const refreshes = await Promise.allSettled([
        oauthA.refreshMcpOAuthToken({ ...context, refreshToken: exchanged[0]!.value.refreshToken }),
        oauthB.refreshMcpOAuthToken({ ...context, refreshToken: exchanged[0]!.value.refreshToken }),
      ])
      const refreshed = refreshes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof oauthA.refreshMcpOAuthToken>>> => result.status === 'fulfilled')
      const rejectedRefreshes = refreshes.filter(result => result.status === 'rejected')
      expect(refreshed).toHaveLength(1)
      expect(rejectedRefreshes).toHaveLength(1)
      expect(rejectedRefreshes[0]).toMatchObject({ reason: { code: 'MCP_OAUTH_INVALID_GRANT' } })

      // The losing concurrent refresh observes the rotated token and is a
      // replay. It must revoke the complete family, including the access token
      // returned by the winning worker. A subsequent replay remains closed.
      await expect(oauthA.authenticateMcpAccessToken({ ...context, accessToken: exchanged[0]!.value.accessToken })).resolves.toBeUndefined()
      await expect(oauthB.authenticateMcpAccessToken({ ...context, accessToken: refreshed[0]!.value.accessToken })).resolves.toBeUndefined()
      await expect(oauthA.refreshMcpOAuthToken({ ...context, refreshToken: exchanged[0]!.value.refreshToken })).rejects.toMatchObject({ code: 'MCP_OAUTH_INVALID_GRANT' })
      await expect(oauthA.authenticateMcpAccessToken({ ...context, accessToken: refreshed[0]!.value.accessToken })).resolves.toBeUndefined()

      // Explicit selection must be checked again for every token operation,
      // including after the account loses one of several workspace bindings.
      await database.query(`INSERT INTO workspace_members (id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,$2,$3,'Second workspace owner','workspace_owner','active','postgres-multi-workspace')`, [randomUUID(), untouchedWorkspaceId, login])
      const multiAccount = await repository.activateMerchantAccount({ login, workspaceIds: [workspaceId, untouchedWorkspaceId], actorId: 'platform-reviewer-e2e', reason: 'add second workspace' })
      await expect(oauthA.issueMcpAuthorizationCode({ ...context, account: multiAccount, redirectUri, codeChallenge: createHash('sha256').update(verifier).digest('base64url') })).rejects.toMatchObject({ code: 'MCP_OAUTH_WORKSPACE_AMBIGUOUS' })
      const selectedCode = await oauthA.issueMcpAuthorizationCode({ ...context, account: multiAccount, workspaceId: untouchedWorkspaceId, redirectUri, codeChallenge: createHash('sha256').update(verifier).digest('base64url') })
      const selectedPair = await oauthA.exchangeMcpAuthorizationCode({ ...context, redirectUri, code: selectedCode.code, codeVerifier: verifier })
      await expect(oauthA.authenticateMcpAccessToken({ ...context, accessToken: selectedPair.accessToken })).resolves.toMatchObject({ workspaceId: untouchedWorkspaceId })
      await repository.activateMerchantAccount({ login, workspaceIds: [workspaceId], actorId: 'platform-reviewer-e2e', reason: 'remove second workspace' })
      await expect(oauthA.authenticateMcpAccessToken({ ...context, accessToken: selectedPair.accessToken })).resolves.toBeUndefined()
      await expect(oauthA.refreshMcpOAuthToken({ ...context, refreshToken: selectedPair.refreshToken })).rejects.toMatchObject({ code: 'MCP_OAUTH_INVALID_GRANT' })

      // Scope and target validation are fail-closed and leave the committed
      // projection untouched.
      const negativeClient = await ops.connect()
      try {
        await negativeClient.query('BEGIN')
        await expect(negativeClient.query(
          'SELECT public.sync_enterprise_name_for_workspaces($1::text[], $2::text)',
          [[workspaceId], '无平台范围'],
        )).rejects.toMatchObject({ code: '42501' })
        await negativeClient.query('ROLLBACK')
        await negativeClient.query('BEGIN')
        await negativeClient.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
        await expect(negativeClient.query(
          'SELECT public.sync_enterprise_name_for_workspaces($1::text[], $2::text)',
          [['missing-registration-workspace'], '不存在'],
        )).rejects.toMatchObject({ code: 'P0001' })
        await negativeClient.query('ROLLBACK')
      } finally {
        negativeClient.release()
      }
      await expect(repository.reviewMerchantRegistration({ login, decision: 'approved', workspaceIds: [workspaceId], actorId: 'platform-reviewer-e2e', reason: '重复审核应拒绝' })).rejects.toMatchObject({ code: 'AUTH_REGISTRATION_STATE_INVALID' })
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await ops?.end()
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 240_000)
})
