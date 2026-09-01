import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['merchant-*.test.ts'],
    exclude: ['**/*.spec.js'],
  },
})
