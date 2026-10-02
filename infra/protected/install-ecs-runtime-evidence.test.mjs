import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RUNTIME_EVIDENCE_TARGET_NAMES, RUNTIME_EVIDENCE_TARGET_ROOT, validateRuntimeTarget } from './install-ecs-runtime-evidence.mjs'

test('runtime evidence has two fixed container bind names under a release-scoped host root', () => {
  assert.equal(RUNTIME_EVIDENCE_TARGET_ROOT, '/var/lib/merchant-release-security/runtime-evidence')
  assert.deepEqual(RUNTIME_EVIDENCE_TARGET_NAMES, {
    capability: 'platform-capability.json',
    capacity: 'capacity-report.json',
  })
  assert.equal(validateRuntimeTarget('capability', `${RUNTIME_EVIDENCE_TARGET_ROOT}/release-test/platform-capability.json`), `${RUNTIME_EVIDENCE_TARGET_ROOT}/release-test/platform-capability.json`)
  assert.equal(validateRuntimeTarget('capacity', `${RUNTIME_EVIDENCE_TARGET_ROOT}/release-test/capacity-report.json`), `${RUNTIME_EVIDENCE_TARGET_ROOT}/release-test/capacity-report.json`)
})

test('runtime evidence rejects path substitution and traversal before touching the host', () => {
  assert.throws(() => validateRuntimeTarget('other', `${RUNTIME_EVIDENCE_TARGET_ROOT}/release-test/capacity-report.json`), /capability or capacity/u)
  assert.throws(() => validateRuntimeTarget('capability', '/tmp/platform-capability.json'), /under the ECS runtime evidence root/u)
  assert.throws(() => validateRuntimeTarget('capacity', `${RUNTIME_EVIDENCE_TARGET_ROOT}/../release-test/capacity-report.json`), /canonical absolute path/u)
  assert.throws(() => validateRuntimeTarget('capacity', `${RUNTIME_EVIDENCE_TARGET_ROOT}/platform-capability.json`), /release-scoped runtime evidence directory/u)
  assert.throws(() => validateRuntimeTarget('capacity', `${RUNTIME_EVIDENCE_TARGET_ROOT}/release-test/platform-capability.json`), /filename does not match kind/u)
})
