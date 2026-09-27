import test from 'node:test'
import assert from 'node:assert/strict'
import * as planControl from './attest-pg17-frozen-plan.mjs'

test('protected plan control has no caller-directed signing capability', async () => {
  assert.equal(typeof planControl.signFrozenPlanFromObservedCatalog, 'undefined')
  const selfApprovedArguments = [
    'sign', '--release-id', 'release-39fc097d-review', '--git-sha', '1'.repeat(40),
    '--attempt-id', 'attempt-self-approved', '--approved-policy-sha256', 'a'.repeat(64),
    '--approved-table-plan-sha256', 'b'.repeat(64),
  ]
  await assert.rejects(planControl.runProtectedPlanSigner(selfApprovedArguments),
    /plan signing is disabled until independent owner approval is provisioned/u)
})
