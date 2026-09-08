import { defineConfig } from 'vitest/config'
import { randomUUID } from 'node:crypto'
import { LOCAL_RUNTIME_TEST_FILES } from './tests/local-runtime-test-safety.js'

// Independent configuration: do not inherit the default suite's live-test
// exclusions. All nine runtime scenarios remain in the explicit denominator;
// missing isolation fails each test before Docker/HTTP side effects, never skip.
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 30_000,
    include: [...LOCAL_RUNTIME_TEST_FILES],
    passWithNoTests: false,
    reporters: ['default', 'json'],
    outputFile: { json: process.env.LOCAL_RUNTIME_TEST_REPORT_PATH || `artifacts/local-runtime-tests/${randomUUID()}/vitest.json` },
  },
})
