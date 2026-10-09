import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: process.env.MERCHANT_BROWSER_SPEC_DIR === 'repo' ? '../..' : '.',
  testMatch: '**/*.spec.js',
  testIgnore: ['**/*.test.ts', '**/*.test.js'],
  workers: 1,
  ...(process.env.TASK_QUEUE_BROWSER_FIXTURE === '1' || process.env.MERCHANT_CATALOG_BROWSER_FIXTURE === '1' ? {
    webServer: {
      command: `npm --prefix demo/merchant-studio run dev -- --host 127.0.0.1 --port ${process.env.MERCHANT_CATALOG_BROWSER_FIXTURE === '1' ? '4188' : '4189'} --strictPort`,
      cwd: '../..',
      url: `http://127.0.0.1:${process.env.MERCHANT_CATALOG_BROWSER_FIXTURE === '1' ? '4188' : '4189'}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_BASE_URL: '/api' },
    },
  } : {}),
})
