import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBusinessRepository } from './business-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string): string {
  const result = new URL(base)
  result.pathname = `/${databaseName}`
  return result.toString()
}

describe('PostgresBusinessRepository normalized projections', () => {
  postgresIt('projects task brand ids through real PostgreSQL for present, missing, and null brands', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `business_repository_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_business_repository','active')")
      await database.query(`INSERT INTO platform_accounts
        (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('account_business_repository','ws_business_repository','jd','remote-account','secret://test','connected')`)
      await database.query(`INSERT INTO brands (id,workspace_id,name)
        VALUES ('brand_business_repository','ws_business_repository','Regression brand')`)
      await database.query(`INSERT INTO products
        (id,workspace_id,platform,platform_account_id,store_name,remote_product_id,title,source)
        VALUES ('product_business_repository','ws_business_repository','jd','account_business_repository','Regression store','remote-product','Regression product','official_api')`)

      const repository = new PostgresBusinessRepository(database, { normalizedProjection: true })
      const task = (entityVersion: number, brandId?: string) => ({
        workspaceId: 'ws_business_repository',
        entityType: 'task' as const,
        entityId: 'task_business_repository',
        entityVersion,
        payload: {
          id: 'task_business_repository',
          workspaceId: 'ws_business_repository',
          productId: 'product_business_repository',
          platform: 'jd',
          accountId: 'account_business_repository',
          brandId,
          state: 'blocked_missing_facts',
        },
      })

      await repository.save(task(1, 'brand_business_repository'))
      await expect(database.query(`SELECT brand_id FROM tasks
        WHERE workspace_id='ws_business_repository' AND id='task_business_repository'`))
        .resolves.toMatchObject({ rows: [{ brand_id: 'brand_business_repository' }] })

      await repository.save(task(2, 'brand_does_not_exist'))
      await expect(database.query(`SELECT brand_id FROM tasks
        WHERE workspace_id='ws_business_repository' AND id='task_business_repository'`))
        .resolves.toMatchObject({ rows: [{ brand_id: null }] })

      await repository.save(task(3))
      await expect(database.query(`SELECT brand_id FROM tasks
        WHERE workspace_id='ws_business_repository' AND id='task_business_repository'`))
        .resolves.toMatchObject({ rows: [{ brand_id: null }] })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 120_000)
})
