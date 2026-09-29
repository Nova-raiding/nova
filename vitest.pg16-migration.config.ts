import { defineConfig } from 'vitest/config'
import { PG16_MIGRATION_TEST_FILES } from './scripts/pg16-migration-test-entrypoint.js'

const outputFile = process.env.PG16_MIGRATION_TEST_REPORT_PATH
if (!outputFile) throw new Error('PG16_MIGRATION_TEST_REPORT_PATH is required by the dedicated acceptance runner')

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 30_000,
    include: [...PG16_MIGRATION_TEST_FILES],
    passWithNoTests: false,
    reporters: ['default', 'json'],
    outputFile: { json: outputFile },
  },
})
