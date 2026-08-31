import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('057 feature flags migration', () => {
  it('keeps defaults safe and events immutable', async () => {
    const sql = await readFile(new URL('./migrations/057_feature_flags.sql', import.meta.url), 'utf8')
    expect(sql).toContain('enabled boolean NOT NULL DEFAULT false')
    expect(sql).toContain('emergency_disabled boolean NOT NULL DEFAULT false')
    expect(sql).toContain('UNIQUE (flag_id, idempotency_key)')
    expect(sql).toContain('platform_feature_flag_events is immutable')
    expect(sql).toContain("target_type IN ('identity', 'workspace', 'percentage')")
    expect(sql).toContain('octet_length(value_json::text) <= 16384')
    expect(sql).toContain('feature flag target value type mismatch')
    expect(sql).toContain('REVOKE ALL ON platform_feature_flags')
  })
})
