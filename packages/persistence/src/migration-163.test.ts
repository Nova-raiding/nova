import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 163 workspace authorization scope contract', () => {
  it('keeps the authorization repair immediately before migration 164', async () => {
    const migrations = await loadMigrations()
    expect(migrations.findIndex(migration => migration.version === 163) + 1).toBe(migrations.findIndex(migration => migration.version === 164))
    expect(migrations.find(migration => migration.version === 163)).toMatchObject({ version: 163, name: 'authorization_workspace_scope_contract' })
    expect(migrations.filter(migration => migration.version === 163)).toHaveLength(1)
  })

  it('does not rewrite the historical migration 152 asset', async () => {
    const bytes = await readFile(new URL('./migrations/152_authorization_grant_scope_integrity.sql', import.meta.url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('682b6c3e14558d07844aae3bffc0361c240a23addccc1dcfe09eefabf8bad427')
  })

  it('keeps the authorization PostgreSQL denominator explicit in package and CI entrypoints', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
    const ci = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const command = packageJson.scripts['test:authorization-postgres'] as string
    const paths = command.split(/\s+/u).filter(path => path.endsWith('.test.ts')).sort()
    expect(paths).toEqual([
      'packages/persistence/src/authorization-event-scope-integrity.postgres.test.ts',
      'packages/persistence/src/authorization-grant-scope-integrity.postgres.test.ts',
      'packages/persistence/src/authorization-repository.release.postgres.test.ts',
      'packages/persistence/src/authorization-rls-boundary.postgres.test.ts',
      'packages/persistence/src/migration-105-release.postgres.test.ts',
    ])
    expect(command).toContain('--no-file-parallelism')
    expect(command).toContain('--reporter=json')
    expect(ci).toContain('npm run test:authorization-postgres')
    expect(ci).toContain("assert.deepEqual(actual, expected, 'authorization test file set mismatch')")
    expect(ci).toContain("test.status === 'passed'")
    expect(ci).toContain('process.stdout.write(rawReport')
  })

  it('executes the CI denominator guard against missing, empty, failed and skipped results', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
    const ci = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const block = ci.match(/node --input-type=module <<'NODE'\n([\s\S]+?)\n\s+NODE/u)?.[1]
    expect(block).toBeDefined()
    // Exercise the exact repository-owned CI code with in-memory synthetic reports.
    const body = block!.split('\n').map(line => line.trimStart()).filter(line => !line.startsWith('import ')).join('\n')
    const guard = new Function('assert', 'readFileSync', 'resolve', 'process', body)
    const names = (packageJson.scripts['test:authorization-postgres'] as string).split(/\s+/u).filter(path => path.endsWith('.test.ts'))
    const valid = { success: true, testResults: names.map(name => ({ name, assertionResults: [{ status: 'passed' }] })) }
    const execute = (report: typeof valid) => guard(assert, (path: string) => JSON.stringify(path === 'package.json' ? packageJson : report), resolve, { stdout: { write: () => true } })
    expect(() => execute(valid)).not.toThrow()
    for (const variant of ['missing', 'wrong-file', 'empty', 'skipped', 'failed', 'unsuccessful']) {
      const invalid = structuredClone(valid)
      if (variant === 'missing') invalid.testResults.pop()
      if (variant === 'wrong-file') invalid.testResults[0]!.name = 'tests/unrelated.test.ts'
      if (variant === 'empty') invalid.testResults[0]!.assertionResults = []
      if (variant === 'skipped' || variant === 'failed') invalid.testResults[0]!.assertionResults[0]!.status = variant
      if (variant === 'unsuccessful') invalid.success = false
      expect(() => execute(invalid), variant).toThrow()
    }
  })
})
