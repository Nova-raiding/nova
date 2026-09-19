import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/verify-database-migration-chain.sh'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migration-chain-preflight-'))
  const migrations = join(root, 'migrations')
  const bin = join(root, 'bin')
  mkdirSync(migrations)
  mkdirSync(bin)
  const sql = ['SELECT 1;\n', 'SELECT 2;\n', 'SELECT 3;\n']
  sql.forEach((contents, index) => writeFileSync(join(migrations, `${String(index + 1).padStart(3, '0')}_migration_${index + 1}.sql`), contents))
  const rows = sql.map((contents, index) => `${index + 1}|migration_${index + 1}|${createHash('sha256').update(contents).digest('hex')}`).join('\n') + '\n'
  const psql = join(bin, 'psql')
  writeFileSync(psql, `#!/bin/sh\ncase "$1" in\n  *tenant*) printf '%s' "$FAKE_TENANT_ROWS" ;;\n  *ops*) printf '%s' "$FAKE_OPS_ROWS" ;;\n  *) exit 9 ;;\nesac\n`)
  chmodSync(psql, 0o755)
  return { migrations, bin, rows }
}

function run(extra: Record<string, string> = {}) {
  const testFixture = fixture()
  return spawnSync('sh', [script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
      DATABASE_URL: 'postgresql://tenant@db.internal/merchant?sslmode=verify-full',
      OPS_DATABASE_URL: 'postgresql://ops@db.internal/merchant?sslmode=verify-full',
      EXPECTED_MIGRATION_VERSION: '3',
      MIGRATIONS_DIR: testFixture.migrations,
      FAKE_TENANT_ROWS: testFixture.rows,
      FAKE_OPS_ROWS: testFixture.rows,
      ...extra,
    },
  })
}

describe('ECS database migration-chain preflight', () => {
  it('binds the production preflight to the current release migration tail', () => {
    const metadata = JSON.parse(readFileSync('release-metadata.json', 'utf8')) as { expectedMigrationVersion: number }
    const migration = readFileSync('packages/persistence/src/migrations/218_manual_publish_evidence.sql', 'utf8')
    expect(metadata.expectedMigrationVersion).toBe(219)
    expect(migration).toContain('manual_publish_evidence')
  })

  it('checks the complete migration history and checksums through both target roles', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('versions=1-3 checksums=matched')
  })

  it('fails closed when the tenant history is missing an intermediate migration', () => {
    const result = run({ FAKE_TENANT_ROWS: '1|migration_1|bad\n3|migration_3|bad\n' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/DATABASE_URL: migration 1 checksum mismatch|missing or has an unexpected version/)
  })

  it('fails closed when Ops sees a different checksum', () => {
    const baseline = fixture()
    const tampered = baseline.rows.replace(/([a-f0-9]{64})\n$/, `${'0'.repeat(64)}\n`)
    const result = run({ FAKE_OPS_ROWS: tampered })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('OPS_DATABASE_URL: migration 3 checksum mismatch')
  })

  it('is wired before the runtime role/RLS boundary gate', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight-ecs.sh', 'utf8')
    expect(preflight).toContain('verify-database-migration-chain.sh')
    expect(preflight.indexOf('verify-database-migration-chain.sh')).toBeLessThan(preflight.indexOf('verify-runtime-db-role.sh'))
  })
})
