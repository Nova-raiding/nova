import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/verify-database-migration-chain.sh'

function fixture(migrationCount = 3) {
  const root = mkdtempSync(join(tmpdir(), 'migration-chain-preflight-'))
  const migrations = join(root, 'migrations')
  const bin = join(root, 'bin')
  mkdirSync(migrations)
  mkdirSync(bin)
  const sql = Array.from({ length: migrationCount }, (_, index) => `SELECT ${index + 1};\n`)
  sql.forEach((contents, index) => writeFileSync(join(migrations, `${String(index + 1).padStart(3, '0')}_migration_${index + 1}.sql`), contents))
  const rows = sql.map((contents, index) => `${index + 1}|migration_${index + 1}|${createHash('sha256').update(contents).digest('hex')}`).join('\n') + '\n'
  const psql = join(bin, 'psql')
  writeFileSync(psql, `#!/bin/sh\ncase "$1" in\n  *tenant*) printf '%s' "$FAKE_TENANT_ROWS" ;;\n  *ops*) printf '%s' "$FAKE_OPS_ROWS" ;;\n  *) exit 9 ;;\nesac\n`)
  chmodSync(psql, 0o755)
  return { migrations, bin, rows }
}

function run(extra: Record<string, string> = {}, migrationCount = 3) {
  const testFixture = fixture(migrationCount)
  return spawnSync('sh', [script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
      DATABASE_URL: 'postgresql://tenant@db.internal/merchant?sslmode=verify-full',
      OPS_DATABASE_URL: 'postgresql://ops@db.internal/merchant?sslmode=verify-full',
      EXPECTED_MIGRATION_VERSION: String(migrationCount),
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
    // Derive the tail from the migrations directory rather than hardcoding it. A
    // literal here drifts silently the moment a migration is added — which is
    // the very mismatch this test exists to catch.
    const migrationFiles = readdirSync('packages/persistence/src/migrations')
    const versions = migrationFiles.map(name => Number(name.split('_')[0])).filter(version => Number.isSafeInteger(version))
    const tail = Math.max(...versions)
    expect(metadata.expectedMigrationVersion).toBe(tail)
    // The tail migration must exist under the repo's zero-padded naming rule and
    // carry real SQL, so the metadata cannot name a version that was never written.
    const tailFile = migrationFiles.find(name => Number(name.split('_')[0]) === tail)!
    expect(tailFile.startsWith(`${String(tail).padStart(3, '0')}_`)).toBe(true)
    expect(readFileSync(`packages/persistence/src/migrations/${tailFile}`, 'utf8').trim().length).toBeGreaterThan(0)
  })

  it('checks the complete migration history and checksums through both target roles', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('mode=complete versions=1-3 checksums=matched')
  })

  it('accepts the same checksum-matched candidate prefix through both runtime roles', () => {
    const baseline = fixture()
    const prefix = baseline.rows.split('\n').slice(0, 2).join('\n') + '\n'
    const result = run({ MIGRATION_CHAIN_MODE: 'prefix', FAKE_TENANT_ROWS: prefix, FAKE_OPS_ROWS: prefix })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('mode=prefix applied=1-2 candidate=1-3 checksums=matched')
  })

  it('keeps complete mode fail-closed when migrations are still pending', () => {
    const baseline = fixture()
    const prefix = baseline.rows.split('\n').slice(0, 2).join('\n') + '\n'
    const result = run({ FAKE_TENANT_ROWS: prefix, FAKE_OPS_ROWS: prefix })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('migration history length mismatch: expected 3, found 2')
  })

  it('fails closed when the tenant history is missing an intermediate migration', () => {
    const baseline = fixture()
    const rows = baseline.rows.trimEnd().split('\n')
    const missing = `${rows[0]}\n${rows[2]}\n`
    const result = run({ MIGRATION_CHAIN_MODE: 'prefix', FAKE_TENANT_ROWS: missing, FAKE_OPS_ROWS: missing })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('DATABASE_URL: migration history is missing or has an unexpected version at 2')
  })

  it('fails closed when Ops sees a different checksum', () => {
    const baseline = fixture()
    const tampered = baseline.rows.replace(/([a-f0-9]{64})\n$/, `${'0'.repeat(64)}\n`)
    const result = run({ FAKE_OPS_ROWS: tampered })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('OPS_DATABASE_URL: migration 3 checksum mismatch')
  })

  it('fails closed on a legacy checksum without explicit baseline acceptance', () => {
    const baseline = fixture(144)
    const legacyRows = baseline.rows.replace(/144\|migration_144\|[a-f0-9]{64}\n$/, '144|migration_144|9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7\n')
    const result = run({ FAKE_TENANT_ROWS: legacyRows, FAKE_OPS_ROWS: legacyRows }, 144)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('DATABASE_URL: migration 144 checksum mismatch')
  }, 20_000)

  it('accepts a built-in legacy checksum only after explicit baseline acceptance', () => {
    const baseline = fixture(144)
    const legacyRows = baseline.rows.replace(/144\|migration_144\|[a-f0-9]{64}\n$/, '144|migration_144|9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7\n')
    const result = run({
      FAKE_TENANT_ROWS: legacyRows,
      FAKE_OPS_ROWS: legacyRows,
      MIGRATION_BASELINE_ACCEPTED: 'true',
    }, 144)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('mode=complete versions=1-144 checksums=matched')
  }, 20_000)

  it('rejects a checksum-matched history that is ahead of the candidate', () => {
    const baseline = fixture()
    const ahead = `${baseline.rows}4|future|${'a'.repeat(64)}\n`
    const result = run({ MIGRATION_CHAIN_MODE: 'prefix', FAKE_TENANT_ROWS: ahead, FAKE_OPS_ROWS: ahead })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('migration history is ahead of candidate at version 4')
  })

  it('rejects different tenant and Ops prefixes even when each is independently valid', () => {
    const baseline = fixture()
    const tenant = baseline.rows.split('\n').slice(0, 2).join('\n') + '\n'
    const ops = baseline.rows.split('\n').slice(0, 1).join('\n') + '\n'
    const result = run({ MIGRATION_CHAIN_MODE: 'prefix', FAKE_TENANT_ROWS: tenant, FAKE_OPS_ROWS: ops })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('tenant and Ops migration histories differ')
  })

  it('rejects an unknown verification mode', () => {
    const result = run({ MIGRATION_CHAIN_MODE: 'relaxed' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('MIGRATION_CHAIN_MODE must be prefix or complete')
  })

  it('is wired before the runtime role/RLS boundary gate', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight-ecs.sh', 'utf8')
    expect(preflight).toContain('MIGRATION_CHAIN_MODE=prefix sh infra/scripts/verify-database-migration-chain.sh')
    expect(preflight).not.toContain('ensure-ops-migration-history-read.sh')
    expect(preflight).not.toMatch(/\b(?:GRANT|REVOKE)\b/iu)
    expect(preflight.indexOf('verify-database-migration-chain.sh')).toBeLessThan(preflight.indexOf('verify-runtime-db-role.sh'))
  })

  it('grants the Ops role read-only access to the migration ledger', () => {
    const preflightGrant = readFileSync('infra/scripts/ensure-ops-migration-history-read.sh', 'utf8')
    const roleBootstrap = readFileSync('infra/local/ensure-app-role.sql', 'utf8')
    for (const source of [preflightGrant, roleBootstrap]) {
      expect(source).toContain('public.schema_migrations')
      expect(source).toContain('GRANT SELECT ON TABLE public.schema_migrations TO merchant_ops')
      expect(source).toContain('REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM merchant_ops')
    }
    expect(preflightGrant).not.toMatch(/GRANT\s+ALL\s+ON\s+(?:TABLE|ALL\s+TABLES)/iu)
  })
})
