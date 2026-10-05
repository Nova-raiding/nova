import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresPasswordAuthRepository } from './password-auth-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
function connection(base: URL, database: string, role?: string) {
  const url = new URL(base); url.pathname = `/${database}`
  if (role) { url.username = role; url.password = `${role}_local_only` }
  return url.toString()
}

describe('merchant activation invitation real PostgreSQL and final role bootstrap', () => {
  postgresIt('creates identity/Workspace/member/invite atomically, consumes once and never creates payment/entitlement facts', async () => {
    const base = new URL(databaseUrl!), databaseName = `release_merchant_activation_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined, ops: Pool | undefined, merchant: Pool | undefined, created = false
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`); created = true
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations).run()
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops'), max: 4 })
      merchant = new Pool({ connectionString: connection(base, databaseName, 'merchant_app') })
      const repository = new PostgresPasswordAuthRepository(ops)
      const input = { login: 'invited@example.com', enterpriseName: '真实隔离验收企业', contactName: '客户本人', workspaceIds: [], createWorkspace: true,
        actorId: 'release-operator', reason: '隔离验收安全邀请开户', idempotencyKey: 'activation-release-1' }
      const results = await Promise.all([repository.createMerchantInvitation(input), repository.createMerchantInvitation(input)])
      expect(results[0]!.account.id).toBe(results[1]!.account.id)
      expect(results.filter(result => result.invitation.token)).toHaveLength(1)
      const first = results.find(result => result.invitation.token)!
      expect(first.account.status).toBe('merchant_pending')
      const workspaceId = first.account.workspaceIds[0]!
      expect((await database.query('SELECT status FROM workspace_members WHERE identity_id=$1', [first.account.identityId])).rows).toEqual([{ status: 'invited' }])
      expect((await database.query('SELECT terms_agreed_at FROM platform_password_accounts WHERE id=$1', [first.account.id])).rows[0].terms_agreed_at).toBeNull()
      expect((await database.query('SELECT count(*)::integer AS count FROM commercial_orders_v2 WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(0)
      await expect(repository.confirmPasswordReset(first.invitation.token!, 'CustomerPassword123')).rejects.toMatchObject({ code: 'AUTH_RESET_TOKEN_INVALID' })
      const second = await repository.createMerchantInvitation({ ...input, createWorkspace: false, workspaceIds: [workspaceId], action: 'reissue', idempotencyKey: 'activation-release-2' })
      await expect(repository.confirmMerchantInvitation({ token: first.invitation.token!, password: 'CustomerPassword123', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_TOKEN_INVALID' })
      const activated = await repository.confirmMerchantInvitation({ token: second.invitation.token!, password: 'CustomerPassword123', termsAgreed: true })
      expect(activated.status).toBe('active')
      expect((await repository.login({ login: input.login, password: 'CustomerPassword123' })).principal.account.identityId).toBe(activated.identityId)
      await expect(repository.confirmMerchantInvitation({ token: second.invitation.token!, password: 'AnotherPassword123', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_TOKEN_INVALID' })
      expect((await database.query('SELECT status FROM workspace_members WHERE identity_id=$1', [activated.identityId])).rows).toEqual([{ status: 'active' }])
      expect((await database.query('SELECT terms_agreed_at IS NOT NULL AS accepted FROM platform_password_accounts WHERE id=$1', [activated.id])).rows[0].accepted).toBe(true)
      expect((await database.query('SELECT count(*)::integer AS count FROM commercial_orders_v2 WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(0)
      expect((await database.query('SELECT count(*)::integer AS count FROM workspace_entitlement_snapshots_v2 WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(0)
      expect((await database.query('SELECT token_hash FROM platform_password_reset_tokens')).rows.every(row => /^[a-f0-9]{64}$/u.test(row.token_hash))).toBe(true)
      expect((await database.query("SELECT has_table_privilege('merchant_ops','workspaces','UPDATE') allowed")).rows[0].allowed).toBe(false)
      const colleague = await repository.createMerchantInvitation({ ...input, login: 'colleague@example.com', createWorkspace: false, workspaceIds: [workspaceId], idempotencyKey: 'activation-colleague-1' })
      expect(colleague.account).toMatchObject({ status: 'merchant_pending', workspaceIds: [workspaceId] })
      expect((await database.query('SELECT status FROM workspace_members WHERE identity_id=$1', [colleague.account.identityId])).rows).toEqual([{ status: 'invited' }])
      const activeColleague = await repository.confirmMerchantInvitation({ token: colleague.invitation.token!, password: 'ColleaguePassword123', termsAgreed: true })
      expect(activeColleague).toMatchObject({ status: 'active', workspaceIds: [workspaceId] })
      const suspended = await repository.createMerchantInvitation({ ...input, login: 'pending-colleague@example.com', createWorkspace: false, workspaceIds: [workspaceId], idempotencyKey: 'activation-colleague-2' })
      await database.query("UPDATE workspaces SET status='disabled' WHERE id=$1", [workspaceId])
      await expect(repository.confirmMerchantInvitation({ token: suspended.invitation.token!, password: 'ColleaguePassword123', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_MEMBERSHIP_CHANGED' })
      expect((await database.query('SELECT status FROM platform_password_accounts WHERE id=$1', [suspended.account.id])).rows[0].status).toBe('merchant_pending')
      await database.query("UPDATE workspaces SET status='active' WHERE id=$1", [workspaceId])
      await expect(merchant.query('SELECT * FROM platform_merchant_activation_invites')).rejects.toMatchObject({ code: '42501' })
      await expect(ops.query('SELECT * FROM platform_merchant_activation_invites')).resolves.toMatchObject({ rows: [] })
      expect((await database.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='platform_merchant_activation_invites'")).rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
    } finally {
      await merchant?.end(); await ops?.end(); await database?.end()
      try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`) } finally { await admin.end() }
    }
  }, 240_000)
})
