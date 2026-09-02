import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresWorkspaceDataExportRepository } from './workspace-data-export-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string, user?: string, password?: string): string {
  const value = new URL(base)
  value.pathname = `/${name}`
  if (user) value.username = user
  if (password) value.password = password
  return value.toString()
}

describe('workspace data export PostgreSQL E2', () => {
  postgresIt('enforces tenant scope, request idempotency, and external delivery evidence', async () => {
    const base = new URL(databaseUrlValue!)
    const name = `workspace_export_e2_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-export-a','active'),('ws-export-b','active')")
      app = new Pool({ connectionString: databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only') })
      const repository = new PostgresWorkspaceDataExportRepository(app)
      const input = { workspaceId: 'ws-export-a', requestedBy: 'owner-a', reason: '迁移前完整导出', idempotencyKey: 'export-e2' }
      const requested = await repository.request(input)
      await expect(repository.request(input)).resolves.toEqual(requested)
      await expect(repository.request({ ...input, reason: '不同导出意图' })).rejects.toMatchObject({ code: 'WORKSPACE_DATA_EXPORT_IDEMPOTENCY_CONFLICT' })
      await expect(repository.get('ws-export-b', requested.id)).resolves.toBeUndefined()
      await repository.markProcessing({ workspaceId: 'ws-export-a', id: requested.id, workerId: 'export-worker' })
      await expect(repository.complete({ workspaceId: 'ws-export-a', id: requested.id, workerId: 'export-worker', artifactRef: 'workspace-export://ws-export-a/e2', artifactSha256: 'a'.repeat(64), artifactSizeBytes: 128, artifactExpiresAt: '2099-01-01T00:00:00.000Z', deliveryEvidenceRef: '' })).rejects.toThrow('WORKSPACE_DATA_EXPORT_DELIVERY_EVIDENCE_REQUIRED')
      await expect(repository.complete({ workspaceId: 'ws-export-a', id: requested.id, workerId: 'export-worker', artifactRef: 'workspace-export://ws-export-a/e2', artifactSha256: 'a'.repeat(64), artifactSizeBytes: 128, artifactExpiresAt: '2099-01-01T00:00:00.000Z', deliveryEvidenceRef: 'evidence://workspace-export/e2' })).resolves.toMatchObject({ status: 'ready', workspaceId: 'ws-export-a', artifactSizeBytes: 128 })
    } finally {
      await app?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.end()
    }
  }, 240_000)
})
