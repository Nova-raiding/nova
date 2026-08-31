import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: 'demo/merchant-studio',
  test: {
    include: ['entry-points.test.ts', 'api.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
})
