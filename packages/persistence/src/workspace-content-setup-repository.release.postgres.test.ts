import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresModelUsageRepository } from './model-usage-repository.js'
import { PostgresWorkspaceContentSetupRepository } from './workspace-content-setup-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('workspace content setup PostgreSQL release acceptance', () => {
  postgresIt('migrates the table, isolates tenant rows, and commits settings with audit', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_content_setup_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      expect((await new MigrationRunner(database, await loadMigrations()).run()).at(-1)).toBe(217)
      const workspaceId = `content-setup-${randomUUID()}`
      const otherWorkspaceId = `content-setup-other-${randomUUID()}`
      await database.query("INSERT INTO workspaces (id,status) VALUES ($1,'active'),($2,'active')", [workspaceId, otherWorkspaceId])
      const modelUsage = new PostgresModelUsageRepository(database)
      await expect(modelUsage.reserveDailyBudget({ workspaceId, reservationKey: 'embedding-index-1', runKey: 'embedding-run-1', modality: 'embedding', model: 'embed-v1', estimateCny: 0.01, estimateVersion: 'pricing-v1', dailyLimitCny: 1, runLimitCny: 1 }))
        .resolves.toMatchObject({ reservation: { modality: 'embedding', model: 'embed-v1' } })
      await expect(modelUsage.record({ workspaceId, modality: 'embedding', model: 'embed-v1', providerRequestId: 'embedding-provider-1', costCny: 0.005 }))
        .resolves.toMatchObject({ modality: 'embedding', model: 'embed-v1' })
      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString() })
      const repository = new PostgresWorkspaceContentSetupRepository(app)
      expect(await repository.get(workspaceId)).toBeUndefined()
      const first = await repository.confirm({ workspaceId, displayName: '旗舰店内容工作区', platform: 'taobao', accountId: 'official-shop-1', actorId: 'owner-1' })
      expect(await repository.get(workspaceId)).toEqual(first)
      expect(await repository.get(otherWorkspaceId)).toBeUndefined()
      const changed = await repository.confirm({ workspaceId, displayName: '品牌内容工作区', platform: 'tmall', accountId: 'official-shop-2', actorId: 'owner-1' })
      expect(changed.displayName).toBe('品牌内容工作区')
      const audit = await database.query<{ before_json: Record<string, unknown>; after_json: Record<string, unknown> }>("SELECT before_json,after_json FROM workspace_operation_audit WHERE workspace_id=$1 AND action='workspace.content_setup.confirm' ORDER BY created_at DESC,id DESC", [workspaceId])
      expect(audit.rows).toHaveLength(2)
      expect(audit.rows[0]).toMatchObject({ before_json: { displayName: '旗舰店内容工作区' }, after_json: { displayName: '品牌内容工作区', platform: 'tmall' } })
      expect((await app.query('SELECT workspace_id FROM workspace_content_setup')).rows).toEqual([])
      expect((await database.query('SELECT count(*)::integer AS count FROM workspace_content_setup WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(1)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await Promise.all([app?.end(), database?.end()])
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
