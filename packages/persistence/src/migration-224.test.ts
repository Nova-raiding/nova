import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const migrationSql = () =>
  readFile(new URL('./migrations/224_public_platform_rule_audit_truncate_guard.sql', import.meta.url), 'utf8')

describe('migration 224 public platform rule audit truncate guard', () => {
  it('registers the owner-safe truncate guard in a contiguous chain', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(migrations.find(item => item.version === 224)).toMatchObject({
      version: 224,
      name: 'public_platform_rule_audit_truncate_guard',
    })
    // 224 is no longer the chain tail (225 follows it); the contiguity check
    // below is the invariant, so it must not be pinned to this version.
    expect(migrations.map(migration => migration.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
    // No concurrent index build, so the file must not opt out of the runner's
    // default transactional posture.
    expect(migrations.find(item => item.version === 224)?.transactional).not.toBe(false)
  })

  it('adds the statement-level guard 219 lacked, with the shared 55000 contract', async () => {
    const sql = await migrationSql()

    // 219 only installed `BEFORE UPDATE OR DELETE ... FOR EACH ROW`, which
    // TRUNCATE never fires. The statement-level trigger is the missing piece.
    expect(sql).toContain('BEFORE TRUNCATE ON public_platform_rule_audits')
    expect(sql).toContain('FOR EACH STATEMENT')
    expect(sql).toContain('public_platform_rule_audits_no_truncate')
    expect(sql).toContain("RAISE EXCEPTION 'public platform rule audits are append-only' USING ERRCODE = '55000'")
    // 132 (rule audit) and 136 (workspace operation audit) are the sibling
    // ledgers this guard mirrors.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_public_platform_rule_audit_mutation()')
  })

  it('stays idempotent and re-runnable without dropping data or schema', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('DROP TRIGGER IF EXISTS public_platform_rule_audits_no_truncate')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION')
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+FUNCTION|ALTER\s+TABLE/iu)
  })

  it('keeps the runtime roles out of the truncate path without widening anything', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('REVOKE TRUNCATE ON public_platform_rule_audits FROM PUBLIC')
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app')")
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops')")
    expect(sql).toContain('REVOKE TRUNCATE ON public_platform_rule_audits FROM merchant_app')
    expect(sql).toContain('REVOKE TRUNCATE ON public_platform_rule_audits FROM merchant_ops')
    // The migration is a guard only: it never grants a new privilege and never
    // touches the mutable lifecycle table 219 also created.
    expect(sql).not.toMatch(/\bGRANT\b/u)
    expect(sql).not.toContain('public_platform_rule_versions')
  })

  it('leaves 219 in place as the owner of the table definition', async () => {
    const original = (await loadMigrations()).find(item => item.version === 219)?.sql ?? ''

    expect(original).toContain('CREATE TABLE IF NOT EXISTS public_platform_rule_audits')
    expect(original).toContain('BEFORE UPDATE OR DELETE ON public_platform_rule_audits')
    expect(original).not.toContain('BEFORE TRUNCATE')
    expect(original).not.toContain('public_platform_rule_audits_no_truncate')
  })
})
