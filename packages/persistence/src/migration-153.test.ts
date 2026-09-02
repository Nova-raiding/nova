import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 153 commercial contract facts', () => {
  it('creates the complete tenant-scoped immutable commercial fact set', async () => {
    const sql = await readFile(new URL('./migrations/153_commercial_contract_facts.sql', import.meta.url), 'utf8')

    for (const table of [
      'commercial_orders_v2',
      'commercial_order_snapshots_v2',
      'workspace_subscription_periods_v2',
      'workspace_entitlement_snapshots_v2',
      'private_trial_eligibilities_v2',
      'private_trial_credits_v2',
      'onboarding_point_grant_schedules_v2',
      'commercial_payment_events_v2',
      'creative_point_provider_receipts_v2',
      'creative_point_reversals_v2',
      'creative_point_adjustments_v2',
      'commercial_access_decisions_v2',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`)
    }
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('WITH CHECK')
    expect(sql).toContain('commercial contract fact is append-only')
  })

  it('keeps unresolved policies and provider outcomes fail-closed', async () => {
    const sql = await readFile(new URL('./migrations/153_commercial_contract_facts.sql', import.meta.url), 'utf8')

    expect(sql).toContain("DEFAULT 'pending_business_approval'")
    expect(sql).toContain("DEFAULT 'pending_accounting_approval'")
    expect(sql).toContain("DEFAULT 'blocked_policy_unresolved'")
    expect(sql).toContain("outcome IN ('succeeded', 'failed', 'unknown')")
    expect(sql).toContain("outcome <> 'succeeded' OR (usage IS NOT NULL AND cost IS NOT NULL AND verified_at IS NOT NULL)")
    expect(sql).toContain("kind IN ('grant', 'reserve', 'release', 'settle', 'refund', 'reverse', 'expire', 'adjust')")
    expect(sql).toContain("event_type IN ('granted', 'reserved', 'released', 'settled', 'refunded', 'reversed', 'expired', 'adjusted')")
  })

  it('uses composite tenant foreign keys and stable natural idempotency keys', async () => {
    const sql = await readFile(new URL('./migrations/153_commercial_contract_facts.sql', import.meta.url), 'utf8')

    expect(sql).toContain('FOREIGN KEY (workspace_id, order_id)')
    expect(sql).toContain('FOREIGN KEY (workspace_id, operation_id)')
    expect(sql).toContain('UNIQUE (workspace_id, onboarding_order_id, sequence)')
    expect(sql).toContain('UNIQUE (provider, provider_event_id)')
    expect(sql).toContain('UNIQUE (provider, provider_request_id)')
  })

  it('is registered in the migration chain', async () => {
    expect((await loadMigrations()).find(item => item.version === 153)).toMatchObject({
      version: 153,
      name: 'commercial_contract_facts',
    })
  })
})
