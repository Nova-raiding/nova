import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'
import type { SqlClient, SqlPool } from './repository.js'
import { PostgresWorkspaceBootstrapRepository, WorkspaceBootstrapError } from './workspace-bootstrap-repository.js'

const postgresIt = process.env.WORKSPACE_BOOTSTRAP_DATABASE_URL || process.env.PERSISTENCE_RELEASE_DATABASE_URL ? it : it.skip

/**
 * Records the statements a repository sends to one pool, so a test can assert
 * which credential a read actually used instead of inferring it from the
 * result. Delegates to the real pool: the routing claim is only worth anything
 * if the statements really executed.
 */
class RecordingPool implements SqlPool {
  readonly statements: string[] = []
  constructor(private readonly inner: SqlPool) {}
  async connect() {
    const client = await this.inner.connect()
    return {
      query: <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        this.statements.push(text)
        return client.query<Row>(text, values)
      },
      release: (error?: Error) => { (client as SqlClient).release?.(error) },
    }
  }
}

/**
 * Applies the deployed role model to a fresh fixture database: migration 091's
 * control-plane grant plus `ensure-app-role.sql`'s blanket runtime grant and the
 * revocation that follows it (kept forward by migration 186). A fixture that
 * re-grants `platform_identities` to `merchant_app` cannot observe the failure
 * this file exists to pin, because the deployed role model never holds it.
 */
async function applyRuntimeRoleModel(database: Pool, databaseName: string) {
  await database.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO merchant_app, merchant_ops`)
  await database.query(`GRANT USAGE ON SCHEMA public TO merchant_app, merchant_ops`)
  await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_app`)
  await database.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchant_app`)
  await database.query(`REVOKE ALL ON platform_identities, platform_identity_events, platform_auth_sessions FROM merchant_app`)
  await database.query(`GRANT SELECT, INSERT, UPDATE ON platform_identities TO merchant_ops`)
}

describe('064 workspace identity bootstrap', () => {
  it('defines an identity-scoped unique binding and a non-destructive backfill', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 64)
    const sql = migration?.sql ?? ''
    expect(migration).toMatchObject({ name: 'workspace_identity_bootstrap' })
    expect(sql).toContain('PRIMARY KEY (issuer, external_subject)')
    expect(sql).toContain('workspace_identity_bindings_identity_scope')
    expect(sql).toContain("member.role = 'workspace_owner'")
    expect(sql).toContain("workspace.status = 'active'")
    expect(sql).not.toMatch(/DELETE\s+FROM|UPDATE\s+workspace_members/iu)
  })

  postgresIt('reuses one active owner workspace across repository instances and isolates issuers', async () => {
    const adminUrl = new URL(process.env.WORKSPACE_BOOTSTRAP_DATABASE_URL ?? process.env.PERSISTENCE_RELEASE_DATABASE_URL!)
    const databaseName = `workspace_bootstrap_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    let ops: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(adminUrl)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await applyRuntimeRoleModel(database, databaseName)

      const identityA = randomUUID()
      const identityB = randomUUID()
      await database.query(`INSERT INTO platform_identities (id, issuer, external_subject) VALUES ($1,$2,$3),($4,$5,$3)`, [identityA, 'https://issuer-a.example', 'same-subject', identityB, 'https://issuer-b.example'])

      const appUrl = new URL(databaseUrl)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      const opsUrl = new URL(databaseUrl)
      opsUrl.username = 'merchant_ops'
      opsUrl.password = 'merchant_ops_local_only'
      appA = new Pool({ connectionString: appUrl.toString(), max: 2 })
      appB = new Pool({ connectionString: appUrl.toString(), max: 2 })
      ops = new Pool({ connectionString: opsUrl.toString(), max: 4 })
      const repositoryA = new PostgresWorkspaceBootstrapRepository(appA, ops)
      const repositoryB = new PostgresWorkspaceBootstrapRepository(appB, ops)
      const common = { issuer: 'https://issuer-a.example', externalSubject: 'same-subject', identityId: identityA, displayName: '可信身份工作区', actorId: 'same-subject' }

      const [first, concurrent] = await Promise.all([
        repositoryA.bootstrap({ ...common, candidateWorkspaceId: 'ws_process_a' }),
        repositoryB.bootstrap({ ...common, candidateWorkspaceId: 'ws_process_b' }),
      ])
      const restarted = await new PostgresWorkspaceBootstrapRepository(appB, ops).bootstrap({ ...common, candidateWorkspaceId: 'ws_after_local_binding_loss', displayName: '不应覆盖原名称' })

      expect(new Set([first.workspaceId, concurrent.workspaceId, restarted.workspaceId]).size).toBe(1)
      expect([first.created, concurrent.created].filter(Boolean)).toHaveLength(1)
      expect(restarted).toMatchObject({ created: false, displayName: '可信身份工作区' })
      const canonicalWorkspaceId = first.workspaceId
      await expect(database.query(`SELECT id FROM workspaces WHERE id IN ('ws_process_a','ws_process_b','ws_after_local_binding_loss') ORDER BY id`)).resolves.toMatchObject({ rows: [{ id: canonicalWorkspaceId }] })
      await expect(database.query(`SELECT workspace_id, role, status, identity_id::text AS identity_id FROM workspace_members WHERE external_subject='same-subject' AND identity_id=$1`, [identityA])).resolves.toMatchObject({ rows: [{ workspace_id: canonicalWorkspaceId, role: 'workspace_owner', status: 'active', identity_id: identityA }] })

      const isolated = await repositoryB.bootstrap({ issuer: 'https://issuer-b.example', externalSubject: 'same-subject', identityId: identityB, candidateWorkspaceId: 'ws_issuer_b', displayName: '另一发行方', actorId: 'same-subject' })
      expect(isolated).toMatchObject({ workspaceId: 'ws_issuer_b', created: true })
      expect(isolated.workspaceId).not.toBe(canonicalWorkspaceId)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await Promise.all([appA?.end(), appB?.end(), ops?.end()])
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 120_000)

  /**
   * `workspace.bootstrap` is the first request a new session makes, so a
   * credential mistake here fails every strict-role deployment rather than one
   * feature. The identity check reads `platform_identities`, which the runtime
   * role does not own and cannot be granted: migration 186 keeps
   * `ensure-app-role.sql`'s `REVOKE ALL ... FROM merchant_app` while migration
   * 091 grants the same table to `merchant_ops`. The repository therefore takes
   * the control-plane pool for that one statement, and this test pins both
   * halves: the tenant pool alone must fail, and with the second pool the
   * tenant statements must still all run on the tenant connection.
   */
  postgresIt('reads the identity on the control-plane pool and keeps tenant statements on the tenant pool', async () => {
    const adminUrl = new URL(process.env.WORKSPACE_BOOTSTRAP_DATABASE_URL ?? process.env.PERSISTENCE_RELEASE_DATABASE_URL!)
    const databaseName = `workspace_bootstrap_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    let primaryFailure: unknown
    const issuer = 'https://issuer-roles.example'
    const externalSubject = 'role-boundary-subject'
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(adminUrl)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await applyRuntimeRoleModel(database, databaseName)

      // The fixture must keep its teeth. Without this the tenant-only call
      // below could pass for the wrong reason, which is how the defect survived
      // the previous fixture's `GRANT ... platform_identities ... TO merchant_app`.
      expect((await database.query<{ merchant_app: boolean; merchant_ops: boolean }>(
        `SELECT has_table_privilege('merchant_app','platform_identities','SELECT') AS merchant_app,
                has_table_privilege('merchant_ops','platform_identities','SELECT') AS merchant_ops`)).rows,
      ).toEqual([{ merchant_app: false, merchant_ops: true }])

      const appUrl = new URL(databaseUrl)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      const opsUrl = new URL(databaseUrl)
      opsUrl.username = 'merchant_ops'
      opsUrl.password = 'merchant_ops_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      ops = new Pool({ connectionString: opsUrl.toString(), max: 4 })

      // Seeded as the schema owner: `platform_identities` is RLS-scoped, so the
      // fixture row is created the way the sibling test creates its identities
      // rather than through the control-plane role the bootstrap is testing.
      const identityId = randomUUID()
      await database.query(`INSERT INTO platform_identities (id, issuer, external_subject) VALUES ($1,$2,$3)`, [identityId, issuer, externalSubject])

      const tenant = new RecordingPool(app as unknown as SqlPool)
      const control = new RecordingPool(ops as unknown as SqlPool)
      const input = { issuer, externalSubject, identityId, candidateWorkspaceId: 'ws_role_boundary_a', displayName: '角色边界工作区', actorId: externalSubject }

      // The observed local-stack failure, reproduced against the real role
      // model: the tenant runtime role cannot read the identity row at all.
      await expect(new PostgresWorkspaceBootstrapRepository(tenant).bootstrap(input)).rejects.toMatchObject({ code: '42501' })
      expect(tenant.statements.some(statement => statement.includes('platform_identities'))).toBe(true)

      tenant.statements.length = 0
      const repository = new PostgresWorkspaceBootstrapRepository(tenant, control)
      const created = await repository.bootstrap(input)
      expect(created).toMatchObject({ workspaceId: 'ws_role_boundary_a', created: true })
      // The identity is really bound, so the ops read is a check and not a
      // substitute for the tenant writes.
      await expect(database.query(`SELECT workspace_id, role, status, identity_id::text AS identity_id FROM workspace_members WHERE external_subject=$1`, [externalSubject]))
        .resolves.toMatchObject({ rows: [{ workspace_id: 'ws_role_boundary_a', role: 'workspace_owner', status: 'active', identity_id: identityId }] })
      await expect(database.query(`SELECT identity_id::text AS identity_id, workspace_id FROM workspace_identity_bindings WHERE issuer=$1 AND external_subject=$2`, [issuer, externalSubject]))
        .resolves.toMatchObject({ rows: [{ identity_id: identityId, workspace_id: 'ws_role_boundary_a' }] })
      // A second bootstrap reuses the binding, which is the path that re-reads
      // the workspace through the tenant pool only.
      await expect(repository.bootstrap({ ...input, candidateWorkspaceId: 'ws_role_boundary_b' })).resolves.toMatchObject({ workspaceId: 'ws_role_boundary_a', created: false })

      // Routing, asserted per pool: the control plane sees only the identity
      // read (one per bootstrap call) and the tenant pool never mentions the
      // platform table it is not allowed to read.
      expect(control.statements.filter(statement => statement.includes('platform_identities'))).toHaveLength(2)
      expect(control.statements.some(statement => statement.includes('workspaces') || statement.includes('workspace_members'))).toBe(false)
      expect(tenant.statements.filter(statement => statement.includes('platform_identities'))).toEqual([])
      for (const table of ['workspaces', 'workspace_members', 'workspace_identity_bindings', 'workspace_operation_audit']) {
        expect(tenant.statements.some(statement => statement.includes(table)), `${table} must stay on the tenant pool`).toBe(true)
      }

      // The extra pool does not soften the identity check: an identity that does
      // not belong to the observed subject is still refused, and nothing is
      // written on the tenant connection.
      await expect(repository.bootstrap({ ...input, externalSubject: 'someone-else', candidateWorkspaceId: 'ws_role_boundary_c' }))
        .rejects.toBeInstanceOf(WorkspaceBootstrapError)
      await expect(database.query(`SELECT id FROM workspaces WHERE id = 'ws_role_boundary_c'`)).resolves.toMatchObject({ rows: [] })
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await Promise.all([app?.end(), ops?.end()])
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 240_000)
})
