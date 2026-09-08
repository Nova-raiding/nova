import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
const ciPostgresFiles = [...workflow.matchAll(/^ {10}((?:packages|apps|tests)\/[^\s]+\.postgres\.test\.ts)$/gmu)]
  .map(match => match[1]!)
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort()

function postgresFiles(relativeRoot: string): string[] {
  const absoluteRoot = resolve(root, relativeRoot)
  const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) return visit(absolute)
    return entry.name.endsWith('.postgres.test.ts') ? [absolute.slice(root.length + 1)] : []
  })
  return visit(absoluteRoot)
}

describe('CI PostgreSQL denominator', () => {
  it('executes every repository PostgreSQL test file in the dedicated CI service', () => {
    const expected = [
      ...postgresFiles('packages/persistence'),
      ...postgresFiles('apps/worker'),
      ...postgresFiles('tests'),
    ].sort()
    expect(ciPostgresFiles).toEqual(expected)
  })

  it('pins the schema-dump client to PostgreSQL 17 in CI', () => {
    expect(workflow).toContain('Install PostgreSQL 17 client for schema-dump acceptance')
    expect(workflow).toContain('postgresql-client-17')
    expect(workflow).toContain('PG_DUMP_BIN: /usr/lib/postgresql/17/bin/pg_dump')
  })
})
