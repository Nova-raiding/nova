import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CAPTURE_SQL, resolveCanonicalSafeState, summarizeCanonicalSafeState, validateCandidateBinding } from '../infra/protected/canonical-safe-state-snapshot.mjs'

const binding = {
  RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40), MANIFEST_SHA256: 'b'.repeat(64),
  RELEASE_MANIFEST_SHA256: 'c'.repeat(64), IMAGE_SET_DIGEST: `sha256:${'d'.repeat(64)}`,
  DEPLOYMENT_NONCE: 'deployment_nonce_abcdefghijklmnop',
}

describe('canonical safe-state snapshot collector contract', () => {
  it('binds claimed candidate fields without retaining the deployment nonce', () => {
    const result = validateCandidateBinding(binding)
    expect(result).toMatchObject({ release_id: binding.RELEASE_ID, release_git_sha: binding.RELEASE_GIT_SHA, image_set_digest: binding.IMAGE_SET_DIGEST })
    expect(result.deployment_nonce_sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result).not.toHaveProperty('deployment_nonce')
    expect(() => validateCandidateBinding({ ...binding, IMAGE_SET_DIGEST: 'mutable-tag' })).toThrow(/image_set_digest/u)
  })

  it('matches workspace default, exact target, emergency, time-window and percentage resolution semantics', () => {
    const flag = { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false }
    expect(resolveCanonicalSafeState(undefined, [], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('legacy_shadow')
    expect(resolveCanonicalSafeState(flag, [], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('legacy_shadow')
    expect(resolveCanonicalSafeState({ ...flag, value_json: 'canonical_read' }, [], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('canonical_read')
    expect(resolveCanonicalSafeState(flag, [{ target_type: 'workspace', target_value: 'ws-a', enabled: true, value_json: 'canonical_read' }], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('canonical_read')
    expect(resolveCanonicalSafeState(flag, [{ target_type: 'workspace', target_value: 'ws-a', enabled: false, value_json: 'canonical_read' }], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('legacy_shadow')
    expect(resolveCanonicalSafeState({ ...flag, emergency_disabled: true, value_json: 'canonical_read' }, [], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('legacy_shadow')
    expect(resolveCanonicalSafeState({ ...flag, valid_from: '2026-09-28T00:00:00.000Z', value_json: 'canonical_read' }, [], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('legacy_shadow')
    expect(resolveCanonicalSafeState(flag, [{ target_type: 'percentage', target_value: '10000', enabled: true, value_json: 'canonical_read' }], 'ws-a', '2026-09-27T00:00:00.000Z')).toBe('canonical_read')
  })

  it('blocks non-legacy modes and leaves identity/signing limitations explicit', () => {
    const summary = summarizeCanonicalSafeState({
      observed_at: '2026-09-27T00:00:00.000Z', database_name: 'merchant', database_oid: '16384',
      workspaces: [{ id: 'ws-a', status: 'active' }, { id: 'ws-b', status: 'disabled' }],
      flags: [{ flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'canonical_read', enabled: true, emergency_disabled: false }], targets: [],
    })
    expect(summary.mode_counts).toEqual({ legacy_shadow: 0, dual_verify: 0, canonical_read: 2 })
    expect(summary.blockers).toContain('one or more workspaces are not in legacy_shadow')
    expect(summary).not.toHaveProperty('workspace_ids')
  })

  it('collects only inside an explicit read-only transaction and never claims a signature', () => {
    expect(CAPTURE_SQL).toContain('public.platform_feature_flag_targets')
    expect(CAPTURE_SQL).toContain('workspaces_canonical_safe_state_reader')
    expect(CAPTURE_SQL).toContain('has_any_column_privilege(current_user, relation_name,')
    expect(CAPTURE_SQL).toContain('has_any_column_privilege(current_user, c.oid,')
    expect(CAPTURE_SQL).toContain('SELECT 1 / 0 AS canonical_safe_state_role_guard_failed')
    expect(CAPTURE_SQL).not.toContain('\\quit 8')
    expect(CAPTURE_SQL).toContain('COMMIT;')
    const source = readFileSync(new URL('../infra/protected/canonical-safe-state-snapshot.mjs', import.meta.url), 'utf8')
    expect(source).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(source).toContain("final_evidence: false")
    expect(source).toContain('source_provenance_verified: false')
    expect(source).not.toContain('signBytes')
  })
})
