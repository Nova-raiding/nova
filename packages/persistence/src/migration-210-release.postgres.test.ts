import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const denied = { code: '42501' }
const invalidReference = { code: '23503' }

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 210 MCP OAuth identity release acceptance', () => {
  postgresIt('enforces principal binding and exposes credentials only to scoped Ops', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_210_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined
    let app: Pool | undefined
    let opsClient: PoolClient | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = (await loadMigrations()).filter(migration => migration.version <= 210)
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(migration => migration.version))

      const workspaceId = `oauth-${randomUUID()}`
      const identityId = randomUUID()
      const otherIdentityId = randomUUID()
      const accountId = randomUUID()
      await database.query(`INSERT INTO workspaces(id,status) VALUES($1,'active')`, [workspaceId])
      await database.query(
        `INSERT INTO platform_identities(id,issuer,external_subject,display_name,access_status,risk_decision)
         VALUES($1,'oauth-acceptance',$2,'OAuth principal','active','allow'),
               ($3,'oauth-acceptance',$4,'Other principal','active','allow')`,
        [identityId, `subject-${identityId}`, otherIdentityId, `subject-${otherIdentityId}`],
      )
      await database.query(
        `INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id)
         VALUES($1,$2,$3,'OAuth principal','workspace_owner','active','acceptance',$4)`,
        [randomUUID(), workspaceId, `subject-${identityId}`, identityId],
      )
      await database.query(
        `INSERT INTO platform_password_accounts(id,identity_id,login_identifier,account_type,enterprise_name,contact_name,password_hash,terms_agreed_at,status,workspace_ids)
         VALUES($1,$2,$3,'merchant','OAuth acceptance','OAuth principal','$argon2id$acceptance',now(),'active',ARRAY[$4])`,
        [accountId, identityId, `oauth-${accountId}@example.test`, workspaceId],
      )

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 1 })
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      const insertCode = (queryable: Pick<Pool, 'query'> | PoolClient, insertedIdentity = identityId) => queryable.query(
        `INSERT INTO mcp_oauth_authorization_codes
           (id,code_hash,client_id,redirect_uri,account_id,identity_id,workspace_id,code_challenge,scope,issuer,audience,resource,account_auth_epoch,identity_auth_epoch,expires_at)
         VALUES($1,repeat('a',64),'chatgpt','https://chatgpt.com/oauth/callback',$2,$3,$4,repeat('b',43),ARRAY['merchant'],'https://issuer.example','mcp','https://resource.example',1,1,now()+interval '5 minutes')`,
        [randomUUID(), accountId, insertedIdentity, workspaceId],
      )

      await expect(insertCode(app)).rejects.toMatchObject(denied)
      await expect(insertCode(ops)).rejects.toMatchObject(denied)
      opsClient = await ops.connect()
      await opsClient.query(`SET app.platform_scope = 'platform_ops'`)
      await expect(insertCode(opsClient, otherIdentityId)).rejects.toMatchObject(invalidReference)
      await insertCode(opsClient)
      expect((await opsClient.query('SELECT count(*)::integer AS count FROM mcp_oauth_authorization_codes')).rows).toEqual([{ count: 1 }])
      await opsClient.query('RESET app.platform_scope')
      expect((await opsClient.query('SELECT count(*)::integer AS count FROM mcp_oauth_authorization_codes')).rows).toEqual([{ count: 0 }])

      const acl = (await database.query(
        `SELECT r.rolname,
                has_table_privilege(r.rolname,'mcp_oauth_tokens','SELECT') AS can_select,
                has_table_privilege(r.rolname,'mcp_oauth_tokens','INSERT') AS can_insert,
                has_table_privilege(r.rolname,'mcp_oauth_tokens','UPDATE') AS can_update,
                has_table_privilege(r.rolname,'mcp_oauth_tokens','DELETE') AS can_delete,
                has_table_privilege(r.rolname,'mcp_oauth_tokens','TRUNCATE') AS can_truncate
           FROM pg_roles r WHERE r.rolname IN ('merchant_app','merchant_ops') ORDER BY r.rolname`,
      )).rows
      expect(acl).toEqual([
        { rolname: 'merchant_app', can_select: false, can_insert: false, can_update: false, can_delete: false, can_truncate: false },
        { rolname: 'merchant_ops', can_select: true, can_insert: true, can_update: true, can_delete: false, can_truncate: false },
      ])
    } finally {
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
