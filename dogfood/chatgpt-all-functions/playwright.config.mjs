import { defineConfig } from '@playwright/test'

const merchantOverviewFixture = process.env.MERCHANT_OVERVIEW_BROWSER_FIXTURE === '1'
const merchantImageFixture = process.env.MERCHANT_IMAGE_BROWSER_FIXTURE === '1'
const merchantFixturePort = merchantImageFixture ? '4191'
  : process.env.MERCHANT_CATALOG_BROWSER_FIXTURE === '1' ? '4188'
  : process.env.TASK_QUEUE_BROWSER_FIXTURE === '1' ? '4189'
    : '4190'

export default defineConfig({
  testDir: merchantOverviewFixture || merchantImageFixture ? '../../demo/merchant-studio' : process.env.MERCHANT_BROWSER_SPEC_DIR === 'repo' ? '../..' : '.',
  testMatch: merchantImageFixture
    ? ['image-generation-desktop.spec.js', 'image-generation-desktop-responsive.spec.js']
    : merchantOverviewFixture
      ? ['merchant-risk-destination.browser.spec.js', 'overview-finance.browser.spec.js']
    : '**/*.spec.js',
  testIgnore: ['**/*.test.ts', '**/*.test.js'],
  workers: 1,
  ...(process.env.TASK_QUEUE_BROWSER_FIXTURE === '1' || process.env.MERCHANT_CATALOG_BROWSER_FIXTURE === '1' || merchantOverviewFixture || merchantImageFixture ? {
    webServer: {
      command: `npm --prefix demo/merchant-studio run dev -- --host 127.0.0.1 --port ${merchantFixturePort} --strictPort`,
      cwd: '../..',
      url: `http://127.0.0.1:${merchantFixturePort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_BASE_URL: '/api' },
    },
  } : {}),
})
