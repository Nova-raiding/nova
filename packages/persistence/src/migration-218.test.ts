import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 218 manual publish evidence', () => {
  it('is the next contiguous migration and creates the manual evidence ledger', async () => {
    const migrations = await loadMigrations()
    const migration = migrations.find(item => item.version === 218)

    // The chain stays contiguous from 1 to the newest artifact; later
    // migrations append to it without renaming this one.
    const latestVersion = migrations.at(-1)?.version ?? 0
    expect(migrations.map(item => item.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
    expect(migration).toMatchObject({ version: 218, name: 'manual_publish_evidence' })
    expect(migration?.sql).toContain('CREATE TABLE manual_publish_evidence')
    expect(migration?.sql).toContain("'manual_publish_record'")
    expect(migration?.sql).toContain('business_entity_snapshots_entity_type_supported_check')
  })

  it('binds evidence to one tenant, store, product, task, and approved version', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 218)?.sql ?? ''

    expect(sql).toContain('FOREIGN KEY (workspace_id, platform, platform_account_id)')
    expect(sql).toContain('FOREIGN KEY (workspace_id, product_id, task_id)')
    expect(sql).toContain('FOREIGN KEY (workspace_id, task_id, approved_content_version_id)')
    expect(sql).toContain('delivery_bundle_sha256 ~ \'^[0-9a-f]{64}$\'')
    expect(sql).toContain('evidence_manifest_sha256 ~ \'^[0-9a-f]{64}$\'')
    expect(sql).toContain('manual_publish_evidence_bundle_identity_idx')
  })

  it('allows only manual workflow states and cannot masquerade as platform verification', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 218)?.sql ?? ''
    const statusConstraint = sql.match(/status TEXT NOT NULL CHECK \(status IN \(([\s\S]*?)\n  \)\),/)?.[1] ?? ''

    expect(statusConstraint).toContain("'export_ready'")
    expect(statusConstraint).toContain("'manual_publish_in_progress'")
    expect(statusConstraint).toContain("'manual_publish_reported'")
    expect(statusConstraint).toContain("'manual_review_required'")
    expect(statusConstraint).not.toContain('platform_verified')
    expect(statusConstraint).not.toContain("'published'")
    expect(sql).toContain('manual_publish_evidence_reported_fields')
  })

  it('forces workspace RLS and denies destructive runtime access', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 218)?.sql ?? ''

    expect(sql).toContain('ALTER TABLE manual_publish_evidence ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE manual_publish_evidence FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("workspace_id = current_setting('app.workspace_id', true)")
    expect(sql).toContain('WITH CHECK')
    expect(sql).toContain('REVOKE ALL ON manual_publish_evidence FROM PUBLIC')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON manual_publish_evidence FROM merchant_app')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON manual_publish_evidence FROM merchant_ops')
  })
})
