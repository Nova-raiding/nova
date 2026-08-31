import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('067 durable platform mapping preflight approvals', () => {
  it('registers tenant scope, evidence bindings, CAS revision and least privilege', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 67)
    expect(migration).toMatchObject({ name: 'platform_mapping_preflight_approvals' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('platform_mapping_preflight_approvals')
    expect(sql).toContain('mapped_payload_sha256')
    expect(sql).toContain('remote_snapshot_sha256')
    expect(sql).toContain('schema_evidence_sha256')
    expect(sql).toContain('mapping_evidence_sha256')
    expect(sql).toContain('confirmation_valid')
    expect(sql).toContain('finding_codes')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("workspace_id = current_setting('app.workspace_id', true)")
    expect(sql).toContain('REVOKE ALL ON TABLE platform_mapping_preflight_approvals FROM PUBLIC')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE platform_mapping_preflight_approvals TO merchant_app')
  })
})
