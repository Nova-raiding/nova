import { defineConfig } from 'vitest/config'
import { NON_HERMETIC_TEST_FILES } from './tests/test-suite-isolation.js'

/**
 * The durable-lease and queue-transport acceptance files are `REDIS_URL`
 * gated. The default safe suite used to collect them and silently skip every
 * assertion, so a green default run proved nothing about the Redis transport.
 * They are registered in `NON_HERMETIC_TEST_FILES` (kept out of the default
 * denominator) and executed here, under an owned local Redis, with an explicit
 * zero-pending gate.
 */
export const ISOLATED_REDIS_TEST_FILES = [
  'packages/workers/src/durable-redis-recovery.test.ts',
  'apps/worker/src/redis-queue-transport.test.ts',
] as const

// A Redis manifest entry that is not excluded from the default suite would be
// collected twice — once here and once as a silently skipped file — so fail
// closed instead of running a file the default runner also owns.
const redisManifestValid = new Set(ISOLATED_REDIS_TEST_FILES).size === ISOLATED_REDIS_TEST_FILES.length
  && ISOLATED_REDIS_TEST_FILES.every(file => (NON_HERMETIC_TEST_FILES as readonly string[]).includes(file))

export function createIsolatedRedisConfig(environment: NodeJS.ProcessEnv) {
  // An owned, disposable local Redis is the only accepted runtime. A shared or
  // remote instance is rejected before any assertion can mutate its keyspace.
  let valid = false
  try {
    const url = new URL(environment.REDIS_URL ?? '')
    valid = (url.protocol === 'redis:' || url.protocol === 'rediss:')
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && /^\d+$/u.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535
      && !url.search && !url.hash
  } catch { /* missing or malformed binding must not activate a localhost fallback */ }
  if (!valid || !redisManifestValid) throw new Error('Use the isolated Redis launcher; an owned local REDIS_URL binding and the Redis manifest are required.')
  return {
    test: {
      environment: 'node' as const,
      include: [...ISOLATED_REDIS_TEST_FILES],
      fileParallelism: false,
      hookTimeout: 30_000,
      passWithNoTests: false,
    },
  }
}

// Deliberately standalone: do not inherit the default configuration's test
// selection. A direct config invocation without a binding fails.
export default defineConfig(() => createIsolatedRedisConfig(process.env))
