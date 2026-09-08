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
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
