import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalProductReadModeFromFlag } from '../packages/application/src/canonical-product-consistency.js'
import { evaluateStoredFeatureFlag, type StoredFeatureFlag, type StoredFlagTarget } from '../packages/persistence/src/feature-flags-repository.js'
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

  it('stays behaviorally identical to the production workspace feature-flag evaluator', () => {
    const at = '2026-09-27T00:00:00.000Z'
    type SafeFlagFixture = { flag_key: string; environment: string; value_type: string; value_json: string; enabled: boolean; emergency_disabled: boolean; valid_from?: string }
    type SafeTargetFixture = { target_type: 'identity' | 'workspace' | 'percentage'; target_value: string; enabled: boolean; value_json: string }
    const cases: Array<{ flag?: SafeFlagFixture; targets: SafeTargetFixture[]; workspace: string }> = [
      { flag: undefined, targets: [], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'canonical_read', enabled: false, emergency_disabled: false }, targets: [], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: true }, targets: [], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false, valid_from: '2026-09-28T00:00:00.000Z' }, targets: [], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false }, targets: [{ target_type: 'workspace', target_value: 'ws-a', enabled: true, value_json: 'dual_verify' }], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false }, targets: [{ target_type: 'workspace', target_value: 'ws-a', enabled: false, value_json: 'canonical_read' }], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false }, targets: [{ target_type: 'percentage', target_value: '10000', enabled: true, value_json: 'canonical_read' }], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false }, targets: [{ target_type: 'percentage', target_value: '1', enabled: true, value_json: 'canonical_read' }], workspace: 'ws-a' },
      { flag: { flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'legacy_shadow', enabled: true, emergency_disabled: false }, targets: [{ target_type: 'identity', target_value: 'identity-a', enabled: true, value_json: 'canonical_read' }], workspace: 'ws-a' },
    ]

    for (const item of cases) {
      const productionFlag: StoredFeatureFlag | undefined = item.flag && {
        id: 'flag-id', key: item.flag.flag_key, environment: item.flag.environment,
        description: '', defaultValue: { type: 'string', value: item.flag.value_json },
        enabled: item.flag.enabled, emergencyDisabled: item.flag.emergency_disabled,
        targets: item.targets.map(target => ({ type: target.target_type, value: target.target_value, enabled: target.enabled, ...(target.value_json ? { override: { type: 'string' as const, value: target.value_json } } : {}) })) as StoredFlagTarget[],
        ...(item.flag.valid_from ? { validFrom: item.flag.valid_from } : {}), revision: 1,
        createdBy: 'test', updatedBy: 'test', createdAt: at, updatedAt: at,
      }
      const expected = canonicalProductReadModeFromFlag(evaluateStoredFeatureFlag(productionFlag, { flagKey: 'canonical.product.read_mode', environment: 'production', workspaceId: item.workspace, at }))
      const actual = resolveCanonicalSafeState(item.flag as Record<string, unknown> | undefined, item.targets as Array<Record<string, unknown>>, item.workspace, at)
      expect(actual).toBe(expected)
    }
  })

  it('blocks non-legacy modes and leaves identity/signing limitations explicit', () => {
    const summary = summarizeCanonicalSafeState({
      observed_at: '2026-09-27T00:00:00.000Z', database_name: 'merchant', database_oid: '16384',
      workspaces: [{ id: 'ws-a', status: 'active' }, { id: 'ws-b', status: 'disabled' }],
      flags: [{ flag_key: 'canonical.product.read_mode', environment: 'production', value_type: 'string', value_json: 'canonical_read', enabled: true, emergency_disabled: false }], targets: [],
    })
    expect(summary.mode_counts).toEqual({ legacy_shadow: 0, dual_verify: 0, canonical_read: 2 })
    expect(summary.blockers).toContain('one or more workspaces are not in legacy_shadow')
    expect(summary.blockers).toContain('database identity is incomplete')
    expect(summary).not.toHaveProperty('workspace_ids')
  })

  it('hashes the observed PostgreSQL cluster system identifier without exposing it in the summary', () => {
    const summary = summarizeCanonicalSafeState({
      observed_at: '2026-09-27T00:00:00.000Z', database_name: 'merchant', database_oid: '16384',
      system_identifier: '7690056768680984617',
      workspaces: [{ id: 'ws-a', status: 'active' }], flags: [], targets: [],
    })
    expect(summary.system_identifier_sha256).toBe(createHash('sha256').update('7690056768680984617').digest('hex'))
    expect(summary).not.toHaveProperty('system_identifier')
    expect(summary.blockers).toEqual([])
  })

  it('collects only inside an explicit read-only transaction and never claims a signature', () => {
    expect(CAPTURE_SQL).toContain('public.platform_feature_flag_targets')
    expect(CAPTURE_SQL).toContain("'system_identifier', (SELECT system_identifier::text FROM pg_catalog.pg_control_system())")
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
