import { defineConfig } from 'vitest/config'

/** Optional Kubernetes/ACK source gates; never inherited by the ECS suite. */
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: [
      'tests/kubernetes-release-gate.test.ts',
      'tests/rendered-kubernetes-config.test.ts',
    ],
    passWithNoTests: false,
    reporters: ['default', './scripts/pending-assertion-gate.ts'],
  },
})
