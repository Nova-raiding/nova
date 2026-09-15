import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 212', () => {
  it('allows manual training confirmation without an uploaded proof', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 212)
    expect(migration?.name).toBe('customer_delivery_training_without_evidence')
    expect(migration?.sql).toContain('DROP CONSTRAINT IF EXISTS customer_delivery_training_evidence_required')
    expect(migration?.sql).not.toContain('NEW.training_completed AND cardinality(NEW.training_evidence_refs) = 0')
  })
})
