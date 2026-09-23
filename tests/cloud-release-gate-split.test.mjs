import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCAL_ONLY_RELEASE_TESTS, cloudReleaseTests } from '../scripts/run-cloud-release-gates.mjs'
import { PLUGIN_CONTRACT_TESTS } from '../scripts/local-plugin-test-attestation.mjs'

test('every omitted cloud test is executed by the signed local plugin suite', () => {
  const cloud = cloudReleaseTests(process.cwd())
  assert.ok(cloud.length > 50)
  assert.ok(LOCAL_ONLY_RELEASE_TESTS.every(path => PLUGIN_CONTRACT_TESTS.includes(path)))
  assert.ok(LOCAL_ONLY_RELEASE_TESTS.every(path => !cloud.includes(path)))
  assert.ok(cloud.includes('tests/authorization-release-dynamic-gate.test.ts'))
  assert.ok(cloud.includes('tests/payment-gateway-process.integration.test.ts'))
})
