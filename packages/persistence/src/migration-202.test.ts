import { describe, expect, it } from 'vitest'
import { loadMigrations, splitTopLevelSqlStatements } from './migration.js'

describe('customer delivery evidence transition migration SQL contract', () => {
  it('replaces the legacy checks with an insert/update trigger in one transactional migration', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 202)
    expect(migration).toMatchObject({ name: 'customer_delivery_evidence_transition' })
    expect(migration?.transactional).not.toBe(false)
    const statements = splitTopLevelSqlStatements(migration!.sql)
    expect(statements).toHaveLength(4)
    expect(statements[0]).toContain('DROP CONSTRAINT IF EXISTS customer_delivery_paid_evidence_required')
    expect(statements[0]).toContain('DROP CONSTRAINT IF EXISTS customer_delivery_training_evidence_required')
    expect(statements[1]).toContain('FUNCTION public.enforce_customer_delivery_evidence_transition()')
    expect(statements[3]).toContain('BEFORE INSERT OR UPDATE ON workspace_customer_deliveries')
    expect(statements[3]).toContain('EXECUTE FUNCTION public.enforce_customer_delivery_evidence_transition()')
  })

  it('validates every inserted group and only actually changed groups on update', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 202)!.sql
    expect(sql).toContain("payment_facts_changed BOOLEAN := TG_OP = 'INSERT'")
    expect(sql).toContain("training_facts_changed BOOLEAN := TG_OP = 'INSERT'")
    expect(sql).toContain("IF TG_OP = 'UPDATE' THEN")
    expect(sql).toMatch(/ROW\(NEW\.payment_status, NEW\.payment_date, NEW\.payment_evidence_refs\)\s+IS DISTINCT FROM ROW\(OLD\.payment_status, OLD\.payment_date, OLD\.payment_evidence_refs\)/u)
    expect(sql).toMatch(/ROW\(NEW\.training_completed, NEW\.training_evidence_refs\)\s+IS DISTINCT FROM ROW\(OLD\.training_completed, OLD\.training_evidence_refs\)/u)
    for (const group of ['payment', 'training']) {
      expect(sql).toContain(`IF ${group}_facts_changed THEN`)
      expect(sql).toContain(`NEW.${group}_evidence_refs IS NULL OR EXISTS`)
      expect(sql).toContain(`unnest(NEW.${group}_evidence_refs)`)
      expect(sql).toContain(`cardinality(NEW.${group}_evidence_refs) = 0`)
    }
    expect(sql.match(/evidence_ref\.value IS NULL OR btrim\(evidence_ref\.value, evidence_whitespace\) = ''/gu)).toHaveLength(2)
    expect(sql).toContain("IF NEW.payment_status = 'paid'")
    expect(sql).toContain('NEW.payment_date IS NULL')
    expect(sql).toContain('IF NEW.training_completed AND')
    expect(sql.match(/ERRCODE = '23514'/gu)).toHaveLength(4)
  })

  it('uses the application whitespace set even when the database locale is C', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 202)!.sql
    const escapedWhitespace = sql.match(/evidence_whitespace CONSTANT TEXT := U&'([^']+)'/u)?.[1]
    expect(escapedWhitespace).toBeDefined()
    const characters = [...escapedWhitespace!.matchAll(/\\([0-9A-F]{4})/gu)]
      .map(match => String.fromCodePoint(Number.parseInt(match[1]!, 16)))
    expect(characters.length).toBe(25)
    expect(new Set(characters).size).toBe(25)
    expect(characters.every(character => character.trim() === '')).toBe(true)
    for (const character of ['\t', '\n', '\u00a0', '\u2007', '\u202f', '\u3000', '\ufeff']) {
      expect(characters).toContain(character)
    }
  })

  it('preserves historical rows and existing role, RLS and audit boundaries', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 202)!.sql
    expect(sql).toContain('SET search_path = pg_catalog')
    expect(sql).not.toMatch(/SECURITY DEFINER|\bGRANT\b|\bREVOKE\b|\bPOLICY\b|DISABLE ROW LEVEL SECURITY/iu)
    expect(sql).not.toMatch(/\bUPDATE\s+workspace_customer_deliveries\s+SET|\bINSERT\s+INTO|\bDELETE\s+FROM|\bTRUNCATE\b/iu)
    expect(sql).not.toContain('workspace_operation_audit')
  })
})
