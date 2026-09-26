import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { comparePg17DataIntegrity } from '../infra/protected/compare-pg17-data-integrity.mjs'
import type { Pg17RestoreCaptureIdentity, Pg17RowsetInventory } from '../infra/protected/compare-pg17-data-integrity.mjs'

const migrationChainRows = Array.from({ length: 254 }, (_, index) => `${index + 1}|migration_${index + 1}|${'5'.repeat(64)}`)
const capture: Pg17RestoreCaptureIdentity = { schema_version: 'pg17-isolated-restore-capture/2', status: 'pass', simulated: false, release_id: 'release-1', release_git_sha: '1'.repeat(40), image_set_digest: `sha256:${'2'.repeat(64)}`, manifest_sha256: '3'.repeat(64), deployment_nonce_sha256: '4'.repeat(64), migration_target_version: 254, restored_migration_prefix: '1:242:242', migrated_prefix: '1:254:254', migration_chain_sha256: createHash('sha256').update(migrationChainRows.join('\n')).digest('hex'), migration_chain_rows: migrationChainRows, backup_sha256: 'a'.repeat(64), source_database_id_sha256: 'b'.repeat(64), target_database_id_sha256: 'c'.repeat(64), captured_at: '2026-09-23T02:00:00.000Z' }
const table = { name: 'public.merchants', row_count: 2, canonical_rows_sha256: 'd'.repeat(64), rls_policy_sha256: 'e'.repeat(64) }
const baseline: Pg17RowsetInventory = { schema_version: 'pg17-rowset-inventory/1', kind: 'live-backup-baseline', simulated: false, release_id: capture.release_id, backup_sha256: capture.backup_sha256, database_id_sha256: capture.source_database_id_sha256, observed_at: '2026-09-23T01:00:00.000Z', tables: [table] }
const restored: Pg17RowsetInventory = { ...baseline, kind: 'isolated-restore-observation', database_id_sha256: capture.target_database_id_sha256, observed_at: '2026-09-23T03:00:00.000Z' }

describe('PG17 raw data integrity comparator', () => {
  it('compares independent before/after rowsets and RLS policy digests', () => {
    expect(comparePg17DataIntegrity(baseline, restored, capture)).toEqual({ status: 'pass', compared_table_count: 1, mismatched_tables: [] })
    expect(comparePg17DataIntegrity(baseline, { ...restored, tables: [{ ...table, row_count: 1 }] }, capture)).toEqual({ status: 'fail', compared_table_count: 1, mismatched_tables: ['public.merchants'] })
    expect(comparePg17DataIntegrity(baseline, { ...restored, tables: [{ ...table, rls_policy_sha256: 'f'.repeat(64) }] }, capture).status).toBe('fail')
  })

  it('fails closed on wrong target, missing table, synthetic inventory or invalid chronology', () => {
    expect(() => comparePg17DataIntegrity(baseline, { ...restored, database_id_sha256: baseline.database_id_sha256 }, capture)).toThrow(/database identity mismatch/u)
    expect(comparePg17DataIntegrity(baseline, { ...restored, tables: [{ ...table, name: 'public.other' }] }, capture).status).toBe('fail')
    expect(() => comparePg17DataIntegrity({ ...baseline, simulated: true }, restored, capture)).toThrow(/provenance invalid/u)
    expect(() => comparePg17DataIntegrity(baseline, { ...restored, observed_at: baseline.observed_at }, capture)).toThrow(/chronology invalid/u)
  })

  it('requires current v2 release and migration bindings', () => {
    expect(() => comparePg17DataIntegrity(baseline, restored, { ...capture, schema_version: 'pg17-isolated-restore-capture/1' } as unknown as Pg17RestoreCaptureIdentity)).toThrow(/v2 capture required/u)
    expect(() => comparePg17DataIntegrity(baseline, restored, { ...capture, release_git_sha: '' })).toThrow(/v2 capture required/u)
    expect(() => comparePg17DataIntegrity(baseline, restored, { ...capture, image_set_digest: '2'.repeat(64) })).toThrow(/v2 capture required/u)
    expect(() => comparePg17DataIntegrity(baseline, restored, { ...capture, migrated_prefix: '1:253:253' })).toThrow(/migration binding invalid/u)
    expect(() => comparePg17DataIntegrity(baseline, restored, { ...capture, migration_chain_rows: migrationChainRows.slice(1) })).toThrow(/migration chain invalid/u)
  })

  it('writes a non-replaceable raw artifact, never a signed production claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg17-raw-compare-'))
    const inputs = [baseline, restored, capture].map((value, index) => { const path = join(dir, `input-${index}.json`); writeFileSync(path, JSON.stringify(value)); return path })
    const output = join(dir, 'comparison.json')
    const args = ['infra/protected/compare-pg17-data-integrity.mjs', '--baseline', inputs[0]!, '--restored', inputs[1]!, '--capture', inputs[2]!, '--output', output]
    execFileSync(process.execPath, args)
    const artifact = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>
    expect(artifact.status).toBe('pass')
    expect(artifact.release_git_sha).toBe(capture.release_git_sha)
    expect(artifact.migration_target_version).toBe(254)
    expect(artifact.final_production_evidence).toBe(false)
    expect(artifact.capture_sha256).toBe(createHash('sha256').update(readFileSync(inputs[2]!)).digest('hex'))
    expect(artifact.signature_base64).toBeUndefined()
    expect(spawnSync(process.execPath, args).status).toBe(1)
  })

  it('retains a failed comparison artifact rather than replacing it with success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg17-raw-compare-fail-'))
    const beforePath = join(dir, 'before.json'), afterPath = join(dir, 'after.json'), capturePath = join(dir, 'capture.json'), output = join(dir, 'failed.json')
    writeFileSync(beforePath, JSON.stringify(baseline))
    writeFileSync(afterPath, JSON.stringify({ ...restored, tables: [{ ...table, row_count: 0 }] }))
    writeFileSync(capturePath, JSON.stringify(capture))
    const result = spawnSync(process.execPath, ['infra/protected/compare-pg17-data-integrity.mjs', '--baseline', beforePath, '--restored', afterPath, '--capture', capturePath, '--output', output])
    expect(result.status).toBe(1)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ status: 'fail', mismatched_tables: ['public.merchants'], final_production_evidence: false })
  })
})
