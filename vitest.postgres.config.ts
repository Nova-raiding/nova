import { defineConfig } from 'vitest/config'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NON_HERMETIC_TEST_FILES } from './tests/test-suite-isolation.js'

export const ISOLATED_POSTGRES_TEST_FILES = NON_HERMETIC_TEST_FILES.filter(file => file.startsWith('packages/persistence/src/') && file.endsWith('.postgres.test.ts'))

const projectRoot = resolve(import.meta.dirname)
function discover(directory: string, prefix = ''): string[] {
  return readdirSync(join(projectRoot, directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return discover(directory, relative)
    return entry.name.endsWith('.postgres.test.ts') ? [`${directory}/${relative}`] : []
  }).sort()
}
export const ALL_POSTGRES_TEST_FILES = ['packages/persistence', 'apps/worker', 'tests'].flatMap(directory => discover(directory)).sort()

export function createIsolatedPostgresConfig(environment: NodeJS.ProcessEnv) {
  let valid = false
  try {
    const database = new URL(environment.PERSISTENCE_RELEASE_DATABASE_URL ?? '')
    valid = /^postgres(?:ql)?:$/u.test(database.protocol) && database.hostname === '127.0.0.1'
      && database.username === 'merchant' && database.password.length > 0 && database.pathname === '/merchant'
      && /^\d+$/u.test(database.port) && Number(database.port) > 0 && Number(database.port) <= 65535
      && !database.search && !database.hash
      && /^[a-f0-9-]{36}$/u.test(environment.MERCHANT_ISOLATED_POSTGRES_RUN_ID ?? '')
  } catch { /* missing or malformed binding must not activate a localhost fallback */ }
  if (!valid || ISOLATED_POSTGRES_TEST_FILES.length !== 11 || ALL_POSTGRES_TEST_FILES.length < ISOLATED_POSTGRES_TEST_FILES.length) throw new Error('Use the isolated PostgreSQL launcher; generated local fixture bindings and the PostgreSQL manifest are required.')
  const files = environment.MERCHANT_ISOLATED_POSTGRES_ALL === 'true' ? ALL_POSTGRES_TEST_FILES : ISOLATED_POSTGRES_TEST_FILES
  return {
    test: {
      environment: 'node' as const,
      include: [...files],
      fileParallelism: false,
      hookTimeout: 30_000,
      passWithNoTests: false,
    },
  }
}

// Deliberately standalone: do not merge the offline default configuration or
// inherit its exclusion list. A direct config invocation without bindings fails.
export default defineConfig(() => createIsolatedPostgresConfig(process.env))
