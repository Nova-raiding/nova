import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration 166 executable commercial catalog PostgreSQL release evidence', () => {
  postgresIt('publishes only resolved v2 offers and fixed point rates after the complete chain', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `commercial_catalog_166_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      const applied = await new MigrationRunner(database, await loadMigrations()).run()
      expect(applied.at(-1)).toBe(169)

      const versions = await database.query<{ total: number; executable: number; blocked: number }>(`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE version=2 AND executable)::int AS executable,
          count(*) FILTER (WHERE version=2 AND NOT executable)::int AS blocked
        FROM commercial_catalog_sku_versions
      `)
      expect(versions.rows[0]).toEqual({ total: 14, executable: 5, blocked: 2 })

      const rates = await database.query<{ rules: number; executable: number }>(`
        SELECT count(*)::int AS rules, count(*) FILTER (WHERE r.executable)::int AS executable
        FROM creative_point_rate_rules_v2 r
        JOIN creative_point_rate_card_versions_v2 v ON v.id=r.rate_card_version_id
        WHERE v.version=2
      `)
      expect(rates.rows[0]).toEqual({ rules: 4, executable: 4 })

      const events = await database.query<{ published: number; sourceImported: number }>(`
        SELECT count(*) FILTER (WHERE event_type='published')::int AS published,
          count(*) FILTER (WHERE event_type='source_imported')::int AS "sourceImported"
        FROM commercial_catalog_events_v2 WHERE actor_id='migration:166'
      `)
      expect(events.rows[0]).toEqual({ published: 6, sourceImported: 2 })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
