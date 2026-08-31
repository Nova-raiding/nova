import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('066 platform media specification evidence registry', () => {
  it('enforces immutable approved evidence, one approved scope and control-plane ACL', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 66)
    expect(migration).toMatchObject({ name: 'platform_media_spec_registry' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain("platform IN ('taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin')")
    expect(sql).toContain("status IN ('draft', 'approved', 'expired')")
    expect(sql).toContain('platform_media_specs_one_approved_scope_idx')
    expect(sql).toContain("WHERE status = 'approved'")
    expect(sql).toContain('protect_platform_media_spec_immutable_evidence')
    expect(sql).toContain('evidence_artifact_sha256')
    expect(sql).toContain('immutable_digest')
    expect(sql).toContain('active_platform_media_specs')
    expect(sql).toContain("expires_at > now()")
    expect(sql).toContain('REVOKE ALL ON TABLE platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM merchant_app')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE platform_media_specs TO merchant_ops')
    expect(sql).toContain('REVOKE ALL ON TABLE platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM merchant_ops')
    expect(sql).toContain('REVOKE ALL ON TABLE platform_media_specs, platform_media_spec_audit, active_platform_media_specs FROM PUBLIC')
    expect(sql).toContain("source_url ~ '^https://")
    expect(sql).toContain('normalize(btrim(placement), NFKC)')
    expect(sql).toContain('platform_media_spec_json_depth(spec_json) <= 12')
    expect(sql).toContain('octet_length(spec_json::text) <= 65536')
    expect(sql).toContain('platform_media_spec_scope_safe(placement, 200)')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION platform_media_spec_json_depth(JSONB), platform_media_spec_scope_safe(TEXT, INTEGER) TO merchant_ops')
  })
})
