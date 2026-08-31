import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresWorkspaceBootstrapRepository } from './workspace-bootstrap-repository.js'

const postgresIt = process.env.WORKSPACE_BOOTSTRAP_DATABASE_URL ? it : it.skip

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
    const adminUrl = new URL(process.env.WORKSPACE_BOOTSTRAP_DATABASE_URL!)
    const databaseName = `workspace_bootstrap_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(adminUrl)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO merchant_app`)
      await database.query(`GRANT USAGE ON SCHEMA public TO merchant_app`)
      await database.query(`GRANT SELECT, INSERT, UPDATE ON workspaces, workspace_members, workspace_operation_audit, platform_identities, workspace_identity_bindings TO merchant_app`)

      const identityA = randomUUID()
      const identityB = randomUUID()
      await database.query(`INSERT INTO platform_identities (id, issuer, external_subject) VALUES ($1,$2,$3),($4,$5,$3)`, [identityA, 'https://issuer-a.example', 'same-subject', identityB, 'https://issuer-b.example'])

      const appUrl = new URL(databaseUrl)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      appA = new Pool({ connectionString: appUrl.toString(), max: 2 })
      appB = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const repositoryA = new PostgresWorkspaceBootstrapRepository(appA)
      const repositoryB = new PostgresWorkspaceBootstrapRepository(appB)
      const common = { issuer: 'https://issuer-a.example', externalSubject: 'same-subject', identityId: identityA, displayName: '可信身份工作区', actorId: 'same-subject' }

      const [first, concurrent] = await Promise.all([
        repositoryA.bootstrap({ ...common, candidateWorkspaceId: 'ws_process_a' }),
        repositoryB.bootstrap({ ...common, candidateWorkspaceId: 'ws_process_b' }),
      ])
      const restarted = await new PostgresWorkspaceBootstrapRepository(appB).bootstrap({ ...common, candidateWorkspaceId: 'ws_after_local_binding_loss', displayName: '不应覆盖原名称' })

      expect(new Set([first.workspaceId, concurrent.workspaceId, restarted.workspaceId]).size).toBe(1)
      expect([first.created, concurrent.created].filter(Boolean)).toHaveLength(1)
      expect(restarted).toMatchObject({ created: false, displayName: '可信身份工作区' })
      const canonicalWorkspaceId = first.workspaceId
      await expect(database.query(`SELECT id FROM workspaces WHERE id IN ('ws_process_a','ws_process_b','ws_after_local_binding_loss') ORDER BY id`)).resolves.toMatchObject({ rows: [{ id: canonicalWorkspaceId }] })
      await expect(database.query(`SELECT workspace_id, role, status, identity_id::text AS identity_id FROM workspace_members WHERE external_subject='same-subject' AND identity_id=$1`, [identityA])).resolves.toMatchObject({ rows: [{ workspace_id: canonicalWorkspaceId, role: 'workspace_owner', status: 'active', identity_id: identityA }] })

      const isolated = await repositoryB.bootstrap({ issuer: 'https://issuer-b.example', externalSubject: 'same-subject', identityId: identityB, candidateWorkspaceId: 'ws_issuer_b', displayName: '另一发行方', actorId: 'same-subject' })
      expect(isolated).toMatchObject({ workspaceId: 'ws_issuer_b', created: true })
      expect(isolated.workspaceId).not.toBe(canonicalWorkspaceId)
    } finally {
      await Promise.all([appA?.end(), appB?.end()])
      await database?.end()
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 120_000)
})
