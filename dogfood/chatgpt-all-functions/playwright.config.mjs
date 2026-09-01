import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  testIgnore: ['**/*.test.ts', '**/*.test.js'],
  workers: 1,
})
