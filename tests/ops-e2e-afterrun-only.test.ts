import { describe, expect, it } from 'vitest'
import { validateOpsE2eAfterRunOnly } from '../scripts/run-ops-password-e2e.js'

describe('isolated afterRun-only browser acceptance', () => {
  it('is disabled by default and cannot skip another named browser spec', () => {
    const spec = 'dogfood/chatgpt-all-functions/ops-members-global-isolated.spec.js'
    const enabled = { OPS_E2E_AFTER_RUN_ONLY: 'true', OPS_E2E_MERCHANT_UI: 'true' }
    expect(validateOpsE2eAfterRunOnly({}, [spec], true)).toBe(false)
    expect(validateOpsE2eAfterRunOnly(enabled, [spec], true)).toBe(true)
    expect(() => validateOpsE2eAfterRunOnly({ ...enabled, OPS_E2E_AFTER_RUN_ONLY: 'false' }, [spec], true)).toThrow('OPS_E2E_AFTER_RUN_ONLY_INVALID')
    expect(() => validateOpsE2eAfterRunOnly({ OPS_E2E_AFTER_RUN_ONLY: 'true' }, [spec], true)).toThrow('OPS_E2E_AFTER_RUN_ONLY_REQUIRES_ISOLATED_MERCHANT_MEMBERS_VERIFIER')
    expect(() => validateOpsE2eAfterRunOnly(enabled, [spec], false)).toThrow('OPS_E2E_AFTER_RUN_ONLY_REQUIRES_ISOLATED_MERCHANT_MEMBERS_VERIFIER')
    expect(() => validateOpsE2eAfterRunOnly(enabled, ['dogfood/chatgpt-all-functions/ops-users.spec.js'], true)).toThrow('OPS_E2E_AFTER_RUN_ONLY_REQUIRES_ISOLATED_MERCHANT_MEMBERS_VERIFIER')
  })
})
