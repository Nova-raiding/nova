import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('does not accept runner text embedded in a preflight argument', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-release-gate-split-'))
  try {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    packageJson.scripts['test:release-gates'] = `echo "node --import tsx scripts/run-safe-tests.ts --no-file-parallelism tests/fake.test.ts"`
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson))
    assert.throws(() => cloudReleaseTests(root), /expected fixed source list/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
