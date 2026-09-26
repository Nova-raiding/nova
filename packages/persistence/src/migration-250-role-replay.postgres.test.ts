import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const claimSignature = 'public.claim_knowledge_generation(text,text,text,text,text,integer,text,text,text,text,text,text,jsonb)'
const settleSignature = 'public.settle_knowledge_generation_claim(text,text,text,text,text,text,text)'
const assertMutableSignature = 'public.knowledge_generation_assert_mutable(text,text)'
const lockProductsSignature = 'public.knowledge_generation_lock_products(text,text[])'

describe('migration 250 runtime role replay', () => {
  postgresIt('keeps only the tenant role able to execute knowledge claims after post-migration bootstrap', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `release_fresh_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await database.query(roleSql)
      const migrations = (await loadMigrations()).filter(migration => migration.version <= 250)
      expect(migrations.at(-1)?.version).toBe(250)
      await new MigrationRunner(database, migrations).run()
      // Production migrate runs the bootstrap again after the migration chain.
      await database.query(roleSql)
      await database.query(roleSql)

      const privileges = await database.query<{ app_claim: boolean; app_settle: boolean; ops_claim: boolean; ops_settle: boolean; app_assert: boolean; app_lock: boolean; ops_assert: boolean; ops_lock: boolean }>(`
        SELECT has_function_privilege('merchant_app', $1, 'EXECUTE') AS app_claim,
               has_function_privilege('merchant_app', $2, 'EXECUTE') AS app_settle,
               has_function_privilege('merchant_ops', $1, 'EXECUTE') AS ops_claim,
               has_function_privilege('merchant_ops', $2, 'EXECUTE') AS ops_settle,
               has_function_privilege('merchant_app', $3, 'EXECUTE') AS app_assert,
               has_function_privilege('merchant_app', $4, 'EXECUTE') AS app_lock,
               has_function_privilege('merchant_ops', $3, 'EXECUTE') AS ops_assert,
               has_function_privilege('merchant_ops', $4, 'EXECUTE') AS ops_lock
      `, [claimSignature, settleSignature, assertMutableSignature, lockProductsSignature])
      expect(privileges.rows[0]).toEqual({ app_claim: true, app_settle: true, ops_claim: false, ops_settle: false, app_assert: false, app_lock: false, ops_assert: false, ops_lock: false })

      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString() })
      const client = await app.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id', 'ws_role_probe', true)")
        // The claim reaches its own input guard, proving EXECUTE works through
        // the runtime credential rather than just through a catalog predicate.
        const refused = await client.query(`SELECT * FROM ${claimSignature.replace(/\(.+\)$/u, '')}(
          'ws_role_probe','claim','event','job','task',1,'attempt','key','body','nonce','product','context','[]'::jsonb
        )`)
        expect(refused.rows).toEqual([{ claim_id: null, claim_state: null, claimed_at: null, refusal: 'snapshot_changed' }])
        await client.query('ROLLBACK')
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id', 'ws_role_probe', true)")
        const settled = await client.query(`SELECT * FROM ${settleSignature.replace(/\(.+\)$/u, '')}(
          'ws_role_probe','missing','attempt','key','body','nonce','completed'
        )`)
        expect(settled.rows).toEqual([])
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
