import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NON_HERMETIC_TEST_FILES } from './test-suite-isolation.js'

const root = resolve(import.meta.dirname, '..')
const packageJsonSource = readFileSync(resolve(root, 'package.json'), 'utf8')
const packageJson = JSON.parse(packageJsonSource) as {
  scripts: Record<string, string>
}

function script(name: string): string {
  const command = packageJson.scripts[name]
  if (!command) throw new Error(`required package script is missing: ${name}`)
  return command
}

function filesUnder(directory: string): string[] {
  return readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'))
}

describe('quality entrypoint coverage', () => {
  it('keeps release gate script names unique in the source manifest', () => {
    const occurrences = packageJsonSource.match(/^\s*"test:release-gates"\s*:/gm) ?? []
    expect(occurrences).toHaveLength(1)
  })

  it('keeps every deterministic source test reachable from the root check', () => {
    const check = script('check')
    const testFiles = ['apps', 'packages', 'tests', 'demo/merchant-studio']
      .flatMap(filesUnder)
      .filter(file => /\.test\.tsx?$/.test(file))
      .filter(file => !file.includes('/dist/') && !file.includes('/node_modules/'))

    const uncovered = testFiles.filter(file => {
      if ((NON_HERMETIC_TEST_FILES as readonly string[]).includes(file)) return false
      if (file.startsWith('apps/ops-console/') && file.endsWith('.test.tsx')) {
        return !check.includes('npm run test:ops-console')
      }
      return !file.endsWith('.test.ts') || !check.includes('npm test')
    })

    expect(uncovered).toEqual([])
    expect(script('test')).toContain('scripts/run-safe-tests.ts')
    expect(check).toContain('npm run typecheck')
    expect(check).toContain('npm run release:metadata:validate')
    expect(check).toContain('npm run build:ops-console')
    expect(check).toContain('npm run build:merchant-studio')
  })

  it('keeps all fail-closed gate tests in the explicit release suite', () => {
    const releaseGate = script('test:release-gates')
    const missing = filesUnder('tests')
      .filter(file => /^tests\/[^/]+-gate\.test\.ts$/.test(file))
      .filter(file => file !== 'tests/local-docker-release-gate.test.ts')
      .filter(file => !releaseGate.includes(file))

    expect(missing).toEqual([])
    expect(script('test:local-release-gate')).toContain('--config vitest.runtime.config.ts tests/local-docker-release-gate.test.ts')
    for (const contract of [
      'tests/quality-entrypoints.test.ts',
      'tests/mcp-surface-contract.test.ts',
      'tests/openapi-contract.test.ts',
      'tests/ops-api-surface.test.ts',
      'tests/operations-scripts.test.ts',
      'tests/runtime-db-role.test.ts',
      'tests/ui-production-contract.test.ts',
      'packages/persistence/src/migration-100.test.ts',
      'packages/persistence/src/migration-101.test.ts',
      'packages/persistence/src/migration-102.test.ts',
      'packages/persistence/src/migration-103.test.ts',
      'packages/persistence/src/migration-104.test.ts',
      'packages/persistence/src/migration-105.test.ts',
      'packages/persistence/src/migration-106.test.ts',
      'packages/persistence/src/migration-110.test.ts',
    ]) {
      expect(releaseGate).toContain(contract)
    }
  })

  it('keeps the deliberately server-only feature-flag control plane explicit', () => {
    const auditSource = readFileSync(resolve(root, 'scripts/audit-ops-surface.mjs'), 'utf8')
    const serverOnly = [
      'ops.feature-flags.list',
      'ops.feature-flag.upsert',
      'ops.feature-flag.emergency.set',
      'ops.feature-flag.events',
      'ops.feature-flag.evaluate',
    ]
    for (const method of serverOnly) expect(auditSource).toContain(`'${method}'`)

    const report = JSON.parse(execFileSync(process.execPath, ['scripts/audit-ops-surface.mjs'], {
      cwd: root,
      encoding: 'utf8',
    })) as {
      server_only_methods?: string[]
      unregistered_server_only?: string[]
      unreferenced?: string[]
    }
    expect(report.server_only_methods).toEqual([...serverOnly].sort())
    expect(report.unregistered_server_only).toEqual([])
    expect(report.unreferenced).toEqual([])
  })

  it('keeps non-hermetic coverage explicit instead of silently passing it in the default suite', () => {
    expect(NON_HERMETIC_TEST_FILES).toHaveLength(19)
    expect(script('test:runtime:isolated')).toContain('--config vitest.runtime.config.ts')
    expect(script('test:postgres:isolated')).toContain('scripts/run-isolated-postgres-tests.ts')
    expect(script('test:browser:ops:jit')).toContain('scripts/run-ops-oidc-e2e.ts')
    expect(readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')).toContain('...NON_HERMETIC_TEST_FILES')
    // The legacy canonical API contract still embeds merchant bearer login.
    // It is quarantined, not claimed as passing until its signed, isolated
    // runtime migration is implemented. Keep that exact gap visible.
    expect(NON_HERMETIC_TEST_FILES).toContain('apps/api/src/canonical-backfill-contract.test.ts')
  })

  it('tracks the current migration tail and required CI quality entrypoints', () => {
    const migrationVersions = filesUnder('packages/persistence/src/migrations')
      .map(file => /\/(\d{3})_[^/]+\.sql$/.exec(file)?.[1])
      .filter((version): version is string => version !== undefined)
      .map(Number)
    const latestMigration = Math.max(...migrationVersions).toString().padStart(3, '0')

    const releaseGates = script('test:release-gates')
    // The release suite may use the shared migration-chain test instead of
    // listing every late migration contract individually. The root suite
    // still executes the version-specific test file.
    expect(
      releaseGates.includes(`packages/persistence/src/migration-${latestMigration}.test.ts`) ||
        releaseGates.includes('packages/persistence/src/migration.test.ts'),
    ).toBe(true)

    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    for (const command of [
      'npm run check',
      'npm run test:release-gates',
      'npm run test:load',
      'npm run build',
      'npm run infra:validate',
    ]) {
      expect(ci).toContain(command)
    }

    // A migration that is only covered by a source-level contract can still
    // fail when applied by PostgreSQL. Keep the CI acceptance list aligned
    // with the migration tail as well as the release-gate list.
    expect(ci).toContain('npm run test:release-gates')
    // Schema-dump acceptance is version-sensitive: the CI workflow must pin
    // the PostgreSQL 17 client instead of relying on an image-host default.
    expect(ci).toContain('Install PostgreSQL 17 client for schema-dump acceptance')
    expect(ci).toContain('PG_DUMP_BIN: /usr/lib/postgresql/17/bin/pg_dump')
  })

  it('keeps the current late-migration acceptance tests in CI', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    const lateMigrationTests = filesUnder('packages/persistence/src')
      .filter(file => /\/migration-(08[3-9]|09[0-9]|100|101|102|103|104|105)\.test\.ts$/.test(file))
    expect(lateMigrationTests.length).toBeGreaterThan(0)
    for (const file of lateMigrationTests) expect(ci).toContain(file)
  })
})
