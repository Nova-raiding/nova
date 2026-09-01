import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['dogfood/chatgpt-all-functions/merchant-*.test.ts'],
    exclude: ['dogfood/chatgpt-all-functions/**/*.spec.js'],
  },
})
