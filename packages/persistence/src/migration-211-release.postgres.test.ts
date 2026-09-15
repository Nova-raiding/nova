import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const tables = ['mcp_oauth_authorization_codes', 'mcp_oauth_tokens'] as const
const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 211 MCP OAuth workspace RLS release gate', () => {
  postgresIt('upgrades 210 without history drift and rejects OAuth catalog/tenant isolation regressions', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `release_211_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let catalog: PoolClient | undefined
    let ops: Pool | undefined
    let app: Pool | undefined
    let opsClient: PoolClient | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName), max: 1 })
      const migrations = (await loadMigrations()).filter(migration => migration.version <= 211)
      const before = migrations.filter(migration => migration.version <= 210)
      expect(await new MigrationRunner(database, before).run()).toEqual(before.map(migration => migration.version))
      const history = (await database.query('SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version')).rows
      const principals = Array.from({ length: 2 }, () => ({ workspace: `oauth211-${randomUUID()}`, identity: randomUUID(), account: randomUUID() }))
      for (const principal of principals) {
        await database.query(`INSERT INTO workspaces(id,status) VALUES($1,'active')`, [principal.workspace])
        await database.query(`INSERT INTO platform_identities(id,issuer,external_subject,display_name,access_status,risk_decision)
          VALUES($1::uuid,'oauth211-acceptance',$1::uuid::text,'Fixture principal','active','allow')`, [principal.identity])
        await database.query(`INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id)
          VALUES($1,$2,$3::uuid::text,'Fixture principal','workspace_owner','active','acceptance',$3::uuid)`, [randomUUID(), principal.workspace, principal.identity])
        await database.query(`INSERT INTO platform_password_accounts(id,identity_id,login_identifier,account_type,enterprise_name,contact_name,password_hash,terms_agreed_at,status,workspace_ids)
          VALUES($1::uuid,$2,$1::uuid::text||'@example.test','merchant','Fixture','Fixture','$argon2id$acceptance',now(),'active',ARRAY[$3])`, [principal.account, principal.identity, principal.workspace])
      }
      const insert = (queryable: Pick<Pool, 'query'> | PoolClient, table: typeof tables[number], principal = principals[0]!) => {
        const id = randomUUID()
        const hash = id.replaceAll('-', '').padEnd(64, 'a')
        if (table === 'mcp_oauth_authorization_codes') return queryable.query(`INSERT INTO mcp_oauth_authorization_codes
          (id,code_hash,client_id,redirect_uri,account_id,identity_id,workspace_id,code_challenge,scope,issuer,audience,resource,account_auth_epoch,identity_auth_epoch,expires_at)
          VALUES($1,$2,'chatgpt','https://chatgpt.com/oauth/callback',$3,$4,$5,repeat('b',43),ARRAY['merchant'],'https://issuer.example','mcp','https://resource.example',1,1,now()+interval '5 minutes')`, [id, hash, principal.account, principal.identity, principal.workspace])
        return queryable.query(`INSERT INTO mcp_oauth_tokens
          (id,family_id,token_kind,token_hash,client_id,account_id,identity_id,workspace_id,scope,issuer,audience,resource,account_auth_epoch,identity_auth_epoch,issued_at,expires_at)
          VALUES($1,$1,'access',$2,'chatgpt',$3,$4,$5,ARRAY['merchant'],'https://issuer.example','mcp','https://resource.example',1,1,now(),now()+interval '5 minutes')`, [id, hash, principal.account, principal.identity, principal.workspace])
      }
      for (const table of tables) for (const principal of principals) await insert(database, table, principal)

      // Execute the deployment script's exact query against real PostgreSQL,
      // not a copied approximation or a mock catalog fixture.
      const source = await readFile(resolve(import.meta.dirname, '../../../infra/scripts/verify-runtime-db-role.sh'), 'utf8')
      const gateSql = source.match(/mcp_oauth_rls_failures=\$\(psql[\s\S]*?-c \\\n\s*"([\s\S]*?)"\)/u)?.[1]
      expect(gateSql).toBeTruthy()
      catalog = await database.connect()
      const failures = async () => String((await catalog!.query(gateSql!)).rows[0]!.coalesce)
      expect(await failures()).toContain('_workspace_isolation')
      catalog.release(); catalog = undefined
      expect(await new MigrationRunner(database, migrations).run()).toEqual([211])
      expect((await database.query('SELECT version,name,checksum,applied_at FROM schema_migrations WHERE version <= 210 ORDER BY version')).rows).toEqual(history)
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      await database.query(migrations.find(migration => migration.version === 211)!.sql)
      expect((await database.query(`SELECT count(*)::integer AS count FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1)`, [tables])).rows).toEqual([{ count: 4 }])

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 1 })
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      opsClient = await ops.connect()
      for (const table of tables) {
        expect((await opsClient.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 0 }])
        await expect(insert(opsClient, table)).rejects.toMatchObject({ code: '42501' })
      }
      await opsClient.query(`SELECT set_config('app.workspace_id',$1,false)`, [principals[0]!.workspace])
      await app.query(`SELECT set_config('app.workspace_id',$1,false),set_config('app.platform_scope','platform_ops',false)`, [principals[0]!.workspace])
      for (const table of tables) {
        expect((await opsClient.query(`SELECT workspace_id FROM ${table}`)).rows).toEqual([{ workspace_id: principals[0]!.workspace }])
        expect((await opsClient.query(`UPDATE ${table} SET expires_at=expires_at WHERE workspace_id=$1`, [principals[0]!.workspace])).rowCount).toBe(1)
        expect((await opsClient.query(`UPDATE ${table} SET expires_at=expires_at WHERE workspace_id=$1`, [principals[1]!.workspace])).rowCount).toBe(0)
        await expect(opsClient.query(`UPDATE ${table} SET workspace_id=$1 WHERE workspace_id=$2`, [principals[1]!.workspace, principals[0]!.workspace])).rejects.toMatchObject({ code: '42501' })
        await expect(insert(opsClient, table, principals[1]!)).rejects.toMatchObject({ code: '42501' })
        await insert(opsClient, table)
        await expect(opsClient.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
        await expect(app.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
        await expect(insert(app, table)).rejects.toMatchObject({ code: '42501' })
        await expect(app.query(`UPDATE ${table} SET expires_at=expires_at`)).rejects.toMatchObject({ code: '42501' })
      }
      await opsClient.query(`RESET app.workspace_id`)
      await opsClient.query(`SET app.platform_scope='platform_ops'`)
      for (const table of tables) {
        expect((await opsClient.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 3 }])
        expect((await opsClient.query(`UPDATE ${table} SET expires_at=expires_at WHERE workspace_id=$1`, [principals[1]!.workspace])).rowCount).toBe(1)
        await expect(insert(opsClient, table, { ...principals[1]!, account: principals[0]!.account })).rejects.toMatchObject({ code: '23503' })
      }
      await opsClient.query(`RESET app.platform_scope`)
      for (const table of tables) expect((await opsClient.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 0 }])

      catalog = await database.connect()
      expect(await failures()).toBe('')
      for (const table of tables) {
        const policy = `${table}_workspace_isolation`
        const corruptions = [
          `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
          `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`,
          `CREATE POLICY unapproved_permissive_policy ON ${table} USING(true) WITH CHECK(true)`,
          `CREATE POLICY unapproved_restrictive_policy ON ${table} AS RESTRICTIVE USING(true)`,
          `DROP POLICY ${policy} ON ${table}`,
          `DROP POLICY ${policy} ON ${table}; CREATE POLICY ${policy} ON ${table} FOR UPDATE USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true))`,
          `DROP POLICY ${policy} ON ${table}; CREATE POLICY ${policy} ON ${table} TO merchant_ops USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true))`,
          `ALTER TABLE ${table} RENAME TO __missing_oauth_fixture_table`,
        ]
        for (const corruption of corruptions) {
          await catalog.query('BEGIN')
          try {
            await catalog.query(corruption)
            expect(await failures(), corruption).toContain(table)
          } finally { await catalog.query('ROLLBACK') }
          expect(await failures()).toBe('')
        }
      }
    } finally {
      catalog?.release()
      opsClient?.release()
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
