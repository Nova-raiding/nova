import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPrivateTrialConversionRepository } from './private-trial-conversion-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('private trial invite PostgreSQL release evidence', () => {
  it('keeps raw codes one-time, customer-bound, single-use, tenant-scoped and append-only', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `private_trial_invites_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let application: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base); isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_invite_a','active'),('ws_invite_b','active')")

      const appUrl = new URL(isolated); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
      application = new Pool({ connectionString: appUrl.toString() })
      const repository = new PostgresPrivateTrialConversionRepository(application)
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
      const invite = await repository.createInvite({ workspaceId: 'ws_invite_a', customerRef: 'customer-a', expiresAt, actorId: 'ops-a', idempotencyKey: 'invite:create:a', reason: 'approved private trial invitation', evidence: { approval_ref: 'approval-a' } })
      expect(invite).toMatchObject({ workspaceId: 'ws_invite_a', customerRef: 'customer-a', status: 'active' })
      expect(invite.inviteCode).toMatch(/^ptinvite_[a-f0-9]{32}$/u)

      const replay = await repository.createInvite({ workspaceId: 'ws_invite_a', customerRef: 'customer-a', expiresAt, actorId: 'ops-a', idempotencyKey: 'invite:create:a', reason: 'approved private trial invitation', evidence: { approval_ref: 'approval-a' } })
      expect(replay.inviteCode).toBeNull()
      await expect(repository.createInvite({ workspaceId: 'ws_invite_a', customerRef: 'customer-b', expiresAt, actorId: 'ops-a', idempotencyKey: 'invite:create:a', reason: 'conflicting replay', evidence: { approval_ref: 'approval-b' } })).rejects.toMatchObject({ code: 'COMMERCIAL_IDEMPOTENCY_CONFLICT' })

      const stored = await database.query<{ invite_code_hash: string }>("SELECT invite_code_hash FROM private_trial_invites_v2 WHERE workspace_id='ws_invite_a' AND id=$1", [invite.id])
      expect(stored.rows[0]?.invite_code_hash).toBe(createHash('sha256').update(invite.inviteCode!).digest('hex'))
      const columns = await database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='private_trial_invites_v2'")
      expect(columns.rows.map(row => row.column_name)).not.toContain('invite_code')
      expect((await repository.listInvites('ws_invite_a'))[0]?.inviteCode).toBeNull()
      expect(await repository.listInvites('ws_invite_b')).toEqual([])

      await expect(repository.createEligibility({ workspaceId: 'ws_invite_a', customerRef: 'customer-b', inviteCode: invite.inviteCode!, actorId: 'ops-a', idempotencyKey: 'eligibility:wrong-customer', reason: 'must reject mismatched customer', evidence: { case_ref: 'case-b' } })).rejects.toMatchObject({ code: 'PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID' })
      const eligibility = await repository.createEligibility({ workspaceId: 'ws_invite_a', customerRef: 'customer-a', inviteCode: invite.inviteCode!, actorId: 'ops-a', idempotencyKey: 'eligibility:customer-a', reason: 'customer accepted private trial', evidence: { case_ref: 'case-a' } })
      expect(eligibility).toMatchObject({ customerRef: 'customer-a', status: 'pending_business_approval' })
      await expect(repository.createEligibility({ workspaceId: 'ws_invite_a', customerRef: 'customer-a', inviteCode: invite.inviteCode!, actorId: 'ops-a', idempotencyKey: 'eligibility:customer-a', reason: 'same request replay', evidence: { case_ref: 'case-a' } })).resolves.toEqual(eligibility)
      await expect(repository.createEligibility({ workspaceId: 'ws_invite_a', customerRef: 'customer-b', inviteCode: invite.inviteCode!, actorId: 'ops-a', idempotencyKey: 'eligibility:customer-a', reason: 'conflicting request replay', evidence: { case_ref: 'case-b' } })).rejects.toMatchObject({ code: 'COMMERCIAL_IDEMPOTENCY_CONFLICT' })
      expect((await repository.listInvites('ws_invite_a'))[0]).toMatchObject({ status: 'redeemed', redeemedEligibilityId: eligibility.id, inviteCode: null })
      await expect(repository.createEligibility({ workspaceId: 'ws_invite_a', customerRef: 'customer-a', inviteCode: invite.inviteCode!, actorId: 'ops-a', idempotencyKey: 'eligibility:reuse', reason: 'must reject reuse', evidence: { case_ref: 'case-reuse' } })).rejects.toMatchObject({ code: 'PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID' })

      const revocable = await repository.createInvite({ workspaceId: 'ws_invite_a', customerRef: 'customer-c', expiresAt, actorId: 'ops-a', idempotencyKey: 'invite:create:c', reason: 'approved second invitation', evidence: { approval_ref: 'approval-c' } })
      const revoked = await repository.revokeInvite({ workspaceId: 'ws_invite_a', inviteId: revocable.id, actorId: 'ops-a', idempotencyKey: 'invite:revoke:c', reason: 'customer withdrew', evidence: { case_ref: 'case-c' } })
      expect(revoked.status).toBe('revoked')
      await expect(repository.revokeInvite({ workspaceId: 'ws_invite_a', inviteId: revocable.id, actorId: 'ops-a', idempotencyKey: 'invite:revoke:c', reason: 'customer withdrew', evidence: { case_ref: 'case-c' } })).resolves.toEqual(revoked)

      await expect(database.query("UPDATE private_trial_invite_events_v2 SET reason='tamper' WHERE workspace_id='ws_invite_a'"))
        .rejects.toMatchObject({ code: '55000' })
    } finally {
      await application?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
