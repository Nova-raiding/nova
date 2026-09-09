import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { authorizationScopeHash } from './authorization-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

async function withIsolatedDatabase(run: (database: Pool) => Promise<void>) {
  const base = new URL(databaseUrlValue!)
  const databaseName = `probe_grant_scope_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: base.toString() })
  let database: Pool | undefined
  let createdDatabase = false
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    createdDatabase = true
    const databaseUrl = new URL(base)
    databaseUrl.pathname = `/${databaseName}`
    database = new Pool({ connectionString: databaseUrl.toString() })
    await run(database)
  } finally {
    await database?.end()
    try { if (createdDatabase) await admin.query(`DROP DATABASE "${databaseName}"`) } finally { await admin.end() }
  }
}

async function seedSubject(database: Pool) {
  const subject = randomUUID()
  await database.query(`INSERT INTO workspaces (id,status) VALUES ('grant_scope_a','active'),('grant_scope_b','active')`)
  await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'grant-scope-probe',$2,'Grant Scope Probe')`, [subject, subject])
  return subject
}

const insertGrant = `INSERT INTO ops_access_grants
  (id,grant_kind,access_mode,subject_identity_id,workspace_id,capabilities,resource_scope,scope_hash,reason,ticket_ref,issued_by,approved_by,approved_at,issued_at,expires_at,max_uses,use_count,authorization_revision,revoked_at,revoked_by,revocation_reason)
  VALUES ($1,'support','read',$2,'grant_scope_a',ARRAY['customer.content.read'],$3::jsonb,$4,'scope probe',$5,'issuer','approver',$6,$7,$8,1,$9,1,$10,$11,$12)`

describe('authorization grant exact scope PostgreSQL probe', () => {
  postgresIt('allows only an exact workspace_ids scope with safe string metadata for new writes', async () => {
    await withIsolatedDatabase(async database => {
      await new MigrationRunner(database, await loadMigrations()).run()
      const subject = await seedSubject(database)
      const now = Date.now()
      const scope = { workspace_ids: ['grant_scope_a'], reason_tag: 'approved support' }
      const grantId = randomUUID()
      const args = (id: string, resourceScope: unknown, ticket: string) => [id, subject, JSON.stringify(resourceScope), authorizationScopeHash(resourceScope as Record<string, unknown>), ticket, new Date(now), new Date(now), new Date(now + 600_000), 0, null, null, null]
      await expect(database.query(insertGrant, args(grantId, scope, 'grant-scope-valid'))).resolves.toBeDefined()
      const before = (await database.query('SELECT resource_scope,scope_hash FROM ops_access_grants WHERE id=$1', [grantId])).rows
      const invalidScopes: unknown[] = [
        { workspace_ids: ['grant_scope_b'] },
        { workspace_ids: ['grant_scope_a', 'grant_scope_b'] },
        { workspace_ids: ['grant_scope_a'], task_ids: ['task-a'] },
        { workspace_ids: ['*'] },
        { workspace_ids: 'grant_scope_a' },
        { workspace_ids: [1] },
        { workspace_ids: [] },
        { type: 'workspace', ids: ['grant_scope_a'] },
        { workspace_ids: ['grant_scope_a'], type: 'workspace' },
        { workspace_ids: ['grant_scope_a'], ids: 'grant_scope_a' },
        { workspace_ids: ['grant_scope_a'], reason_tag: { unsafe: true } },
        { workspace_ids: ['grant_scope_a'], reason_tag: '' },
        { workspace_ids: ['grant_scope_a'], reason_tag: ' padded' },
        { workspace_ids: ['grant_scope_a'], reason_tag: 'unsafe\nmetadata' },
        { workspace_ids: ['grant_scope_a'], 'unsafe\nkey': 'metadata' },
        { workspace_ids: ['grant_scope_a'], reason_tag: 'x'.repeat(256) },
        'grant_scope_a', [], null,
      ]
      for (const [index, invalidScope] of invalidScopes.entries()) {
        await expect(database.query(insertGrant, args(randomUUID(), invalidScope, `grant-scope-invalid-${index}`))).rejects.toMatchObject({ code: '22023', message: 'ops access grant scope is invalid' })
        await expect(database.query('UPDATE ops_access_grants SET resource_scope=$2::jsonb WHERE id=$1', [grantId, JSON.stringify(invalidScope)])).rejects.toMatchObject({ code: '22023', message: 'ops access grant scope is invalid' })
      }
      await expect(database.query("UPDATE ops_access_grants SET workspace_id='grant_scope_b' WHERE id=$1", [grantId])).rejects.toMatchObject({ code: '22023' })
      expect((await database.query('SELECT resource_scope,scope_hash FROM ops_access_grants WHERE id=$1', [grantId])).rows).toEqual(before)
      expect((await database.query('SELECT count(*)::integer AS count FROM ops_access_grants')).rows[0].count).toBe(1)
    })
  }, 240_000)

  postgresIt('blocks incompatible live legacy authority and preserves historical scope, hash, and event evidence on upgrade', async () => {
    await withIsolatedDatabase(async database => {
      const migrations = await loadMigrations()
      expect(migrations.some(migration => migration.version === 163)).toBe(true)
      // Before 152, repository-issued workspace_ids rows could coexist with
      // canonical type/ids imports. Upgrade fixtures retain their original JSON.
      await new MigrationRunner(database, migrations.filter(migration => migration.version <= 151)).run()
      const subject = await seedSubject(database)
      const now = Date.now()
      const legacyScope = { type: 'workspace', ids: ['grant_scope_a'] }
      const compatibleScope = { workspace_ids: ['grant_scope_a'], reason_tag: 'historical approved support' }
      const seedGrant = async (scope: Record<string, unknown>, ticket: string, options: { expired?: boolean; revoked?: boolean; exhausted?: boolean; futureIssued?: boolean } = {}) => {
        const id = randomUUID()
        const issued = options.expired ? now - 1_200_000 : options.futureIssued ? now + 60_000 : now
        const expires = options.expired ? now - 600_000 : now + 600_000
        await database.query(insertGrant, [id, subject, JSON.stringify(scope), authorizationScopeHash(scope), ticket, new Date(Math.min(issued, now)), new Date(issued), new Date(expires), options.exhausted ? 1 : 0, options.revoked ? new Date(now) : null, options.revoked ? 'scope-upgrade-operator' : null, options.revoked ? 'explicit historical revocation' : null])
        await database.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json) VALUES ($1,$2,$3,'grant_scope_a','issued','scope-upgrade-operator','retain original scope evidence',1,1,$4::jsonb)`, [randomUUID(), id, subject, JSON.stringify({ resourceScope: scope, scopeHash: authorizationScopeHash(scope), ticketRef: ticket })])
        return id
      }
      await seedGrant(legacyScope, 'historical-expired', { expired: true })
      await seedGrant(legacyScope, 'historical-revoked', { revoked: true })
      await seedGrant(compatibleScope, 'historical-compatible-active')
      const blockedGrants = []
      for (const [label, scope, options] of [
        ['legacy-live', legacyScope, {}],
        ['legacy-exhausted', legacyScope, { exhausted: true }],
        ['legacy-future-issued', legacyScope, { futureIssued: true }],
        ['cross-workspace', { workspace_ids: ['grant_scope_b'] }, {}],
        ['ambiguous-union', { workspace_ids: ['grant_scope_a'], task_ids: ['task-a'] }, {}],
        ['canonical-alias', { workspace_ids: ['grant_scope_a'], type: 'workspace' }, {}],
        ['malformed-metadata', { workspace_ids: ['grant_scope_a'], reason_tag: { unsafe: true } }, {}],
      ] as const) blockedGrants.push(await seedGrant(scope, label, { ...options, revoked: true }))
      await new MigrationRunner(database, migrations.filter(migration => migration.version <= 162)).run()
      const migration163 = migrations.find(migration => migration.version === 163)!
      // Prove an RLS-filtered migrator fails at the audit SELECT, rather than
      // treating invisible authority as an empty table. These ACL changes are
      // confined to this test's new database; no cluster role is modified.
      await database.query('GRANT SELECT, UPDATE ON ops_access_grants TO merchant_app')
      const restricted = await database.connect()
      try {
        await restricted.query('BEGIN')
        await restricted.query('SET LOCAL ROLE merchant_app')
        expect((await restricted.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
        expect((await restricted.query('SELECT count(*)::integer AS count FROM ops_access_grants')).rows[0].count).toBe(0)
        // Establish that LOCK itself is permitted, so 42501 below specifically
        // proves row_security=off rejects the otherwise-hidden audit records.
        await restricted.query('LOCK TABLE ops_access_grants IN SHARE ROW EXCLUSIVE MODE')
        await expect(restricted.query(migration163.sql)).rejects.toMatchObject({ code: '42501', message: 'query would be affected by row-level security policy for table "ops_access_grants"' })
      } finally {
        await restricted.query('ROLLBACK')
        restricted.release()
      }
      await database.query('REVOKE SELECT, UPDATE ON ops_access_grants FROM merchant_app')
      expect((await database.query("SELECT pg_get_functiondef('validate_ops_access_grant_scope()'::regprocedure) AS definition")).rows[0].definition).toContain("resource_scope->>'type'")

      // A legacy writer that started before the migration must not slip past
      // the compatibility audit. Observe the real table-lock wait, then commit
      // its insert and require the actual runner to reject that newly-live row.
      const writer = await database.connect()
      const concurrentGrantId = randomUUID()
      let upgradeOutcome: Promise<{ applied?: number[]; error?: unknown }> | undefined
      try {
        await writer.query('BEGIN')
        await writer.query(insertGrant, [concurrentGrantId, subject, JSON.stringify(legacyScope), authorizationScopeHash(legacyScope), 'concurrent-legacy-writer', new Date(now), new Date(now), new Date(now + 600_000), 0, null, null, null])
        upgradeOutcome = new MigrationRunner(database, migrations).run().then(applied => ({ applied }), error => ({ error }))
        let observedWait = false
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const locks = await database.query("SELECT 1 FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='ops_access_grants'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted")
          if (locks.rows.length > 0) { observedWait = true; break }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(observedWait).toBe(true)
        await writer.query('COMMIT')
        expect((await upgradeOutcome).error).toMatchObject({ code: '22023', message: 'active ops access grants use an incompatible scope; revoke and reissue before migration 163' })
      } finally {
        await writer.query('ROLLBACK')
        writer.release()
        await upgradeOutcome
      }
      expect((await database.query('SELECT resource_scope,scope_hash FROM ops_access_grants WHERE id=$1', [concurrentGrantId])).rows[0]).toEqual({ resource_scope: legacyScope, scope_hash: authorizationScopeHash(legacyScope) })
      await database.query("UPDATE ops_access_grants SET revoked_at=now(),revoked_by='scope-upgrade-operator',revocation_reason='explicit revoke concurrent fixture' WHERE id=$1", [concurrentGrantId])
      const evidence = async () => ({
        grants: (await database.query('SELECT id,resource_scope,scope_hash FROM ops_access_grants ORDER BY id')).rows,
        events: (await database.query('SELECT id,grant_id,snapshot_json FROM ops_access_grant_events ORDER BY id')).rows,
      })
      const originalEvidence = await evidence()
      for (const id of blockedGrants) {
        // Activate exactly one incompatible fixture at a time; exhausted and
        // future-issued authority must independently block the forward migration.
        await database.query('UPDATE ops_access_grants SET revoked_at=NULL,revoked_by=NULL,revocation_reason=NULL WHERE id=$1', [id])
        await expect(new MigrationRunner(database, migrations).run()).rejects.toMatchObject({ code: '22023', message: 'active ops access grants use an incompatible scope; revoke and reissue before migration 163' })
        expect((await database.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version).toBe(162)
        expect(await evidence()).toEqual(originalEvidence)
        // This explicit operator action touches revocation metadata only. The
        // migration itself must never rewrite any scope/hash/audit event.
        await database.query("UPDATE ops_access_grants SET revoked_at=now(),revoked_by='scope-upgrade-operator',revocation_reason='explicit revoke before upgrade' WHERE id=$1", [id])
      }
      // The probe starts from the pre-163 schema, so the real release runner
      // must apply the complete forward tail, not stop at the migration under
      // test. Keep this assertion aligned as new forward-only migrations are
      // added to the release chain.
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.filter(migration => migration.version > 162).map(migration => migration.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      expect(await evidence()).toEqual(originalEvidence)
      // Inactive legacy rows remain revocable without being translated; new
      // canonical writes are rejected after the successful forward migration.
      await database.query("UPDATE ops_access_grants SET revoked_at=now(),revoked_by='scope-upgrade-operator',revocation_reason='historical metadata remains mutable' WHERE ticket_ref='historical-expired'")
      expect(await evidence()).toEqual(originalEvidence)
      await expect(seedGrant(legacyScope, 'forbidden-new-legacy')).rejects.toMatchObject({ code: '22023' })
      await expect(seedGrant(compatibleScope, 'new-workspace-contract')).resolves.toBeDefined()
    })
  }, 240_000)
})
