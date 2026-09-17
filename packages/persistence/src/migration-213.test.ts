import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 213', () => {
  it('allows manually verified payment without requiring an uploaded proof', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 213)
    expect(migration?.name).toBe('customer_delivery_manual_verification')
    expect(migration?.sql).toContain('DROP CONSTRAINT IF EXISTS customer_delivery_paid_evidence_required')
    expect(migration?.sql).not.toContain("NEW.payment_status = 'paid'")
  })
})
