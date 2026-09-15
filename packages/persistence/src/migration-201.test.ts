import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery required evidence migration', () => {
  it('adds durable payment and training evidence with fail-closed constraints', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 201)
    expect(migration?.name).toBe('customer_delivery_required_evidence')
    expect(migration?.sql).toContain('payment_evidence_refs TEXT[] NOT NULL')
    expect(migration?.sql).toContain('training_evidence_refs TEXT[] NOT NULL')
    expect(migration?.sql).toContain("payment_status <> 'paid'")
    expect(migration?.sql).toContain('NOT training_completed')
    expect(migration?.sql).not.toMatch(/DELETE FROM|TRUNCATE TABLE/u)
  })
})
