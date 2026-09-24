import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { PostgresFirstWorkspaceProvisioningRepository } from './first-workspace-provisioning-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('first workspace provisioning on migrated PostgreSQL', () => {
  postgresIt('creates an audited owner binding once, rejects conflicts, and preserves runtime privilege boundaries', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `workspace_bootstrap_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const url = new URL(base)
      url.pathname = `/${databaseName}`
      database = new Pool({ connectionString: url.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      // Migrations define RLS; the deployment role-bootstrap supplies runtime ACLs.
      await database.query(`GRANT SELECT ON workspace_members TO merchant_app`)
      const actorId = randomUUID()
      const ownerId = randomUUID()
      const workspaceId = `ws_${randomUUID().replaceAll('-', '')}`
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject) VALUES ($1,'urn:platform','admin'),($2,'urn:local','merchant@example.com')`, [actorId, ownerId])
      await database.query(`INSERT INTO authorization_revisions (subject_identity_id,revision,updated_by,update_reason) VALUES ($1,1,'fixture','initial authorization')`, [actorId])
      await database.query(`INSERT INTO platform_role_assignments (id,subject_identity_id,role,assigned_by,reason,authorization_revision) VALUES ($1,$2,'platform_admin','fixture','verified administrator',1)`, [randomUUID(), actorId])

      const repository = new PostgresFirstWorkspaceProvisioningRepository(database)
      const input = { platformActorIdentityId: actorId, workspaceId, ownerIdentityId: ownerId, ownerIssuer: 'urn:local', ownerSubject: 'merchant@example.com', ownerDisplayName: 'Merchant', reason: 'Verified initial workspace assignment' }
      await expect(repository.provision(input)).resolves.toEqual({ workspaceId, created: true })
      await expect(repository.provision(input)).resolves.toEqual({ workspaceId, created: false })
      const rows = await database.query(`SELECT (SELECT count(*) FROM workspaces WHERE id=$1) AS workspaces, (SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND identity_id=$2 AND role='workspace_owner' AND status='active') AS members, (SELECT count(*) FROM workspace_identity_bindings WHERE workspace_id=$1 AND identity_id=$2) AS bindings, (SELECT count(*) FROM workspace_operation_audit WHERE workspace_id=$1 AND action='workspace.provision.first' AND actor_id=$3) AS audits`, [workspaceId, ownerId, actorId])
      expect(rows.rows[0]).toMatchObject({ workspaces: '1', members: '1', bindings: '1', audits: '1' })
      await expect(repository.provision({ ...input, workspaceId: `ws_${randomUUID().replaceAll('-', '')}` })).rejects.toMatchObject({ code: 'WORKSPACE_PROVISION_CONFLICT' })
      await expect(repository.provision({ ...input, ownerSubject: 'other@example.com' })).rejects.toMatchObject({ code: 'OWNER_IDENTITY_INACTIVE' })
      await database.query(`UPDATE platform_role_assignments SET revoked_at=now(),revoked_by='fixture',revocation_reason='End test access' WHERE subject_identity_id=$1`, [actorId])
      await expect(repository.provision(input)).rejects.toMatchObject({ code: 'PLATFORM_ACTOR_FORBIDDEN' })

      const tenant = await database.connect()
      try {
        await tenant.query('BEGIN')
        await tenant.query('SET LOCAL ROLE merchant_app')
        await tenant.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
        await expect(tenant.query(`SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1`, [workspaceId]))
          .resolves.toMatchObject({ rows: [{ count: 1 }] })
        await tenant.query(`SELECT set_config('app.workspace_id', 'ws_other', true)`)
        await expect(tenant.query(`SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1`, [workspaceId]))
          .resolves.toMatchObject({ rows: [{ count: 0 }] })
        await expect(tenant.query(`SELECT * FROM platform_role_assignments LIMIT 1`)).rejects.toMatchObject({ code: '42501' })
      } finally {
        await tenant.query('ROLLBACK')
        tenant.release()
      }
      const ops = await database.connect()
      try {
        await ops.query('BEGIN')
        await ops.query('SET LOCAL ROLE merchant_ops')
        await ops.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
        await expect(ops.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [`ws_${randomUUID().replaceAll('-', '')}`]))
          .rejects.toMatchObject({ code: '42501' })
      } finally {
        await ops.query('ROLLBACK')
        ops.release()
      }
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
