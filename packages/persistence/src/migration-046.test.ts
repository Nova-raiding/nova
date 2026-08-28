import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('046 model usage settlement migration', () => {
  it('adds durable idempotency, settlement, retry claim and resolution fields', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 46)
    expect(migration?.name).toBe('model_usage_settlement')
    for (const column of ['receipt_key', 'settlement_status', 'receipt_hash', 'attempt_count', 'last_error', 'revision', 'resolved_by', 'resolution_reason', 'resolution_evidence_ref', 'resolved_at', 'next_attempt_at', 'claim_owner', 'claim_expires_at']) {
      expect(migration?.sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`)
    }
    expect(migration?.sql).toContain("'pending_cost','pending_wallet','settled','manual_attention','waived'")
    expect(migration?.sql).toContain('model_usage_ledger_workspace_receipt_key')
    expect(migration?.sql).toContain('model_usage_ledger_retry_claim_idx')
  })
})
