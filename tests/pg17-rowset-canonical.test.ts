import { describe, expect, it } from 'vitest'
import { canonicalRowsDigest, rlsPolicyDigest } from '../infra/protected/pg17-rowset-canonical.mjs'

describe('PG17 rowset byte contract', () => {
  it('is order independent but preserves duplicates and byte boundaries', () => {
    const a = Buffer.from('a'), b = Buffer.from('b')
    expect(canonicalRowsDigest([b, a])).toEqual(canonicalRowsDigest([a, b]))
    expect(canonicalRowsDigest([a, a, b]).row_count).toBe(3)
    expect(canonicalRowsDigest([a, a, b]).canonical_rows_sha256).not.toBe(canonicalRowsDigest([a, b]).canonical_rows_sha256)
    expect(canonicalRowsDigest([Buffer.from('ab'), Buffer.from('c')]).canonical_rows_sha256).not.toBe(canonicalRowsDigest([a, Buffer.from('bc')]).canonical_rows_sha256)
    expect(() => canonicalRowsDigest(['a' as unknown as Buffer])).toThrow(/bounded Buffer/u)
  })

  it('canonicalizes policy order and roles but detects semantic changes', () => {
    const policy = { name: 'workspace_read', cmd: 'SELECT', permissive: true, roles: ['merchant', 'operator'], qual: '(workspace_id = current_setting(\'app.workspace_id\'::text)::uuid)', with_check: null }
    const observation = { enabled: true, forced: true, policies: [policy] }
    expect(rlsPolicyDigest(observation)).toBe(rlsPolicyDigest({ ...observation, policies: [{ ...policy, roles: [...policy.roles].reverse() }] }))
    expect(rlsPolicyDigest(observation)).not.toBe(rlsPolicyDigest({ ...observation, forced: false }))
    expect(rlsPolicyDigest(observation)).not.toBe(rlsPolicyDigest({ ...observation, policies: [{ ...policy, qual: 'true' }] }))
    expect(() => rlsPolicyDigest({ ...observation, policies: [{ ...policy, owner: 'postgres' }] } as never)).toThrow(/fields invalid/u)
  })
})
