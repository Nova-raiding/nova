import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const sql = readFileSync(new URL('./migrations/228_audit_ledger_errno_contract.sql', import.meta.url), 'utf8')

/**
 * `platform_identity_events` and `platform_feature_flag_events` were the last
 * two append-only ledgers rejecting with the default SQLSTATE. P0001 is what
 * *any* plpgsql `RAISE EXCEPTION` produces, so an append-only violation was
 * indistinguishable from an unrelated procedural error — the failure mode was
 * unreadable exactly where the ledger contract is what is being enforced.
 */
describe('migration 228 audit ledger errno contract', () => {
  it('is registered in a contiguous chain', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0
    expect(latestVersion).toBeGreaterThanOrEqual(228)
    expect(migrations.map(migration => migration.version)).toEqual(Array.from({ length: latestVersion }, (_, index) => index + 1))
    expect(migrations.find(migration => migration.version === 228)?.name).toBe('audit_ledger_errno_contract')
  })

  it('replaces both ledger trigger functions with 55000 bodies', () => {
    // `CREATE OR REPLACE FUNCTION` keeps the function OID, so the triggers
    // installed by 045/057 stay bound — no trigger is dropped or recreated.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_platform_identity_event_mutation()')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_feature_flag_event_mutation()')
    const bodies = sql.match(/RAISE EXCEPTION [^\n]*USING ERRCODE = '55000';/gu) ?? []
    expect(bodies).toHaveLength(2)
    expect(sql).not.toMatch(/RAISE EXCEPTION [^\n]*;\s*\n(?!\s*END)/u)
  })

  it('adds no trigger, table or grant surface of its own', () => {
    expect(sql).not.toContain('CREATE TRIGGER')
    expect(sql).not.toContain('DROP TRIGGER')
    expect(sql).not.toContain('CREATE TABLE')
    expect(sql).not.toContain('GRANT')
    expect(sql).not.toContain('REVOKE')
    expect(sql).not.toContain('migrate:no-transaction')
  })
})
