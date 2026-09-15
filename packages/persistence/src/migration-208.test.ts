import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('alert webhook receipt migration', () => {
  it('creates an append-only audit ledger with durable replay keys', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 208)
    expect(migration).toMatchObject({ name: 'alert_webhook_receipts' })
    const sql = migration!.sql
    expect(sql).toContain('request_id text PRIMARY KEY')
    expect(sql).toContain('alert_id text NOT NULL UNIQUE')
    expect(sql).toContain('body_sha256 text NOT NULL')
    expect(sql).toContain('alert_webhook_receipts_payload_request_id_matches')
    expect(sql).toContain("payload @> jsonb_build_object('request_id', request_id)")
    expect(sql).toContain('alert_webhook_receipts_payload_alert_id_matches')
    expect(sql).toContain("jsonb_build_object('alert', jsonb_build_object('id', alert_id))")
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE ON alert_webhook_receipts FOR EACH STATEMENT')
    expect(sql).toContain('REVOKE ALL ON alert_webhook_receipts FROM PUBLIC')
    expect(sql).toContain('GRANT SELECT, INSERT ON alert_webhook_receipts TO merchant_ops')
    expect(sql).toContain('REVOKE ALL ON FUNCTION reject_alert_webhook_receipt_mutation() FROM PUBLIC')
  })
})
