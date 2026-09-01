import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
      if (file.startsWith('apps/ops-console/') && file.endsWith('.test.tsx')) {
        return !check.includes('npm run test:ops-console')
      }
      return !file.endsWith('.test.ts') || !check.includes('npm test')
    })

    expect(uncovered).toEqual([])
    expect(check).toContain('npm run typecheck')
    expect(check).toContain('npm run release:metadata:validate')
    expect(check).toContain('npm run build:ops-console')
    expect(check).toContain('npm run build:merchant-studio')
  })

  it('keeps all fail-closed gate tests in the explicit release suite', () => {
    const releaseGate = script('test:release-gates')
    const missing = filesUnder('tests')
      .filter(file => /^tests\/[^/]+-gate\.test\.ts$/.test(file))
      .filter(file => !releaseGate.includes(file))

    expect(missing).toEqual([])
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

  it('tracks the current migration tail and required CI quality entrypoints', () => {
    const migrationVersions = filesUnder('packages/persistence/src/migrations')
      .map(file => /\/(\d{3})_[^/]+\.sql$/.exec(file)?.[1])
      .filter((version): version is string => version !== undefined)
      .map(Number)
    const latestMigration = Math.max(...migrationVersions).toString().padStart(3, '0')

    expect(script('test:release-gates')).toContain(
      `packages/persistence/src/migration-${latestMigration}.test.ts`,
    )

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
  })

  it('keeps the current late-migration acceptance tests in CI', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    const lateMigrationTests = filesUnder('packages/persistence/src')
      .filter(file => /\/migration-(08[3-9]|09[0-9]|100|101|102|103|104|105)\.test\.ts$/.test(file))
    expect(lateMigrationTests.length).toBeGreaterThan(0)
    for (const file of lateMigrationTests) expect(ci).toContain(file)
  })
})
