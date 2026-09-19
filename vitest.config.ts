import { configDefaults, defineConfig } from 'vitest/config'
import { NON_HERMETIC_TEST_FILES } from './tests/test-suite-isolation.js'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    exclude: [...configDefaults.exclude, ...NON_HERMETIC_TEST_FILES],
    // Cold E2E workers dynamically import the API composition root after
    // stubbing process env. Transforming that graph can exceed Vitest's 10s
    // hook default even though the server subsequently binds successfully.
    hookTimeout: 30_000,
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/**/*.test.ts', 'demo/merchant-studio/*.test.ts', 'demo/merchant-studio/src/**/*.test.ts', '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.test.ts'],
    // A `postgresIt`/`skipIf` file that loses its binding reports every
    // DB-backed assertion as pending and still exits 0, so a green default run
    // proved nothing about them. The gate reporter fails the run unless every
    // pending assertion is declared, with its exact count, in
    // DEFAULT_SUITE_PENDING_ALLOWANCES. It is configured here rather than in the
    // safe launcher because the launcher's argument and environment contracts
    // are pinned by tests/safe-test-launcher.test.ts.
    reporters: ['default', './scripts/pending-assertion-gate.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
