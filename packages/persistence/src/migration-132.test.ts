import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 132 rule audit append-only ACL', () => {
  it('registers owner-safe truncate protection and runtime-role ACL hardening', async () => {
    const sql = await readFile(new URL('./migrations/132_rule_audit_append_only_acl.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 132)).toMatchObject({
      version: 132,
      name: 'rule_audit_append_only_acl',
    })
    expect(sql).toContain('BEFORE TRUNCATE ON rule_audit_events')
    expect(sql).toContain('FOR EACH STATEMENT')
    expect(sql).toContain("RAISE EXCEPTION 'rule audit events are append-only'")
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON rule_audit_events FROM PUBLIC')
    expect(sql).toContain('FROM merchant_app')
    expect(sql).toContain('FROM merchant_ops')
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE/iu)
  })
})
