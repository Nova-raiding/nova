import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPlatformAuthorizationAuditRepository } from './platform-authorization-audit-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('platform authorization audit PostgreSQL boundary', () => {
  postgresIt('keeps the platform audit sink append-only and isolated to merchant_ops', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_platform_audit_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      const acl = await database.query<{ privilege_type: string }>(`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='platform_authorization_audit'
          AND grantee='merchant_ops' ORDER BY privilege_type`)
      expect(acl.rows).toEqual([{ privilege_type: 'INSERT' }, { privilege_type: 'SELECT' }])

      ops = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      const repository = new PostgresPlatformAuthorizationAuditRepository(ops)
      const decisionId = `decision-${randomUUID()}`
      const input = {
        decisionId,
        policyVersion: 'platform-policy-v1',
        actorId: 'platform-operator',
        workbench: 'platform' as const,
        capability: 'merchant.content.read',
        method: 'GET',
        result: 'allow' as const,
        reasonCode: 'policy_allow',
        resourceType: 'workspace',
        resourceId: 'workspace-1',
        resourceScope: { workspaceId: 'workspace-1' },
        requestId: `request-${randomUUID()}`,
        traceId: `trace-${randomUUID()}`,
        evidence: { source: 'postgres-boundary-test' },
        createdAt: '2026-09-01T10:00:00.000Z',
      }
      const created = await repository.append(input)
      expect(created).toMatchObject(input)
      expect(await repository.append({ ...input, id: randomUUID(), result: 'deny' })).toEqual(created)
      expect(await repository.getByDecisionId(decisionId)).toEqual(created)
      expect(await repository.list({ actorId: input.actorId })).toEqual([created])

      app = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      await expect(app.query('SELECT * FROM platform_authorization_audit')).rejects.toMatchObject({ code: '42501' })
      await expect(ops.query(`UPDATE platform_authorization_audit SET reason_code='tampered' WHERE decision_id=$1`, [decisionId])).rejects.toThrow(/append-only/u)
      await expect(ops.query(`DELETE FROM platform_authorization_audit WHERE decision_id=$1`, [decisionId])).rejects.toThrow(/append-only/u)
      await expect(ops.query('TRUNCATE platform_authorization_audit')).rejects.toThrow(/append-only/u)
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
