#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_CONTRACT_TESTS } from './local-plugin-test-attestation.mjs'

// These v1 release tests read the desktop plugin tree. The signed local test
// attestation executes each of them from the same clean Git SHA. The cloud
// image must never silently omit a test that the local signed suite lacks.
export const LOCAL_ONLY_RELEASE_TESTS = Object.freeze([
  'tests/mcp-integration-mode-release-gate.test.ts',
  'tests/env-example-read-gate.test.ts',
  'tests/quality-entrypoints.test.ts',
  'tests/release-metadata-gate.test.ts',
  'tests/release-manifest.test.ts',
  'tests/release-manifest-gate.test.ts',
  'tests/container-source-manifest.test.ts',
  'tests/operations-scripts.test.ts',
  'tests/source-artifact-hygiene.test.ts',
  'tests/mcp-surface-contract.test.ts',
  'tests/plugin-manifest.test.ts',
])

export function cloudReleaseTests(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const command = packageJson.scripts?.['test:release-gates']
  if (typeof command !== 'string' || !command.startsWith('node --import tsx scripts/run-safe-tests.ts --no-file-parallelism ')) {
    throw new Error('release gate command is not the expected fixed source list')
  }
  const tests = command.split(/\s+/u).filter(item => /\.test\.tsx?$/u.test(item))
  if (tests.length < 20 || new Set(tests).size !== tests.length) throw new Error('release gate source list is invalid')
  const local = new Set(LOCAL_ONLY_RELEASE_TESTS)
  for (const file of local) {
    if (!tests.includes(file) || !PLUGIN_CONTRACT_TESTS.includes(file)) throw new Error(`local plugin test is not present in both signed and release suites: ${file}`)
  }
  const cloud = tests.filter(file => !local.has(file))
  if (cloud.length + local.size !== tests.length) throw new Error('cloud test split is incomplete')
  return cloud
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.cwd()
    for (const path of ['apps/plugin', '.codex-marketplace']) {
      if (existsSync(resolve(root, path))) throw new Error(`cloud source still contains local plugin path: ${path}`)
    }
    const files = cloudReleaseTests(root)
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-safe-tests.ts', '--no-file-parallelism', ...files], {
      cwd: root, stdio: 'inherit', env: process.env,
    })
    if (result.status !== 0) process.exitCode = result.status ?? 1
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
