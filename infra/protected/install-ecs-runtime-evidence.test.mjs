import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RUNTIME_EVIDENCE_TARGETS, validateRuntimeTarget } from './install-ecs-runtime-evidence.mjs'

test('runtime evidence has two fixed bind targets', () => {
  assert.deepEqual(RUNTIME_EVIDENCE_TARGETS, {
    capability: '/run/release-evidence/platform-capability.json',
    capacity: '/run/release-evidence/capacity-report.json',
  })
  assert.equal(validateRuntimeTarget('capability', RUNTIME_EVIDENCE_TARGETS.capability), RUNTIME_EVIDENCE_TARGETS.capability)
  assert.equal(validateRuntimeTarget('capacity', RUNTIME_EVIDENCE_TARGETS.capacity), RUNTIME_EVIDENCE_TARGETS.capacity)
})

test('runtime evidence rejects path substitution and traversal before touching the host', () => {
  assert.throws(() => validateRuntimeTarget('other', RUNTIME_EVIDENCE_TARGETS.capacity), /capability or capacity/u)
  assert.throws(() => validateRuntimeTarget('capability', '/tmp/platform-capability.json'), /fixed ECS runtime evidence path/u)
  assert.throws(() => validateRuntimeTarget('capacity', '/run/release-evidence/../release-evidence/capacity-report.json'), /fixed ECS runtime evidence path/u)
})
