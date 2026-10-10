import { configDefaults, defineConfig } from 'vitest/config'

// This Chromium/Vite UI boundary regression is excluded from the root default
// suite with the other non-hermetic browser acceptance. The Ops browser runner
// selects it explicitly with this narrow config so the test is actually
// collected without widening the default unit/API suite.
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ['apps/ops-console/src/components/rules/PublicRuleDraftReviewPanel.detail-boundary.regression.test.tsx'],
    exclude: [...configDefaults.exclude],
    passWithNoTests: false,
    reporters: ['default', './scripts/pending-assertion-gate.ts'],
  },
})
