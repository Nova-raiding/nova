#!/usr/bin/env node
// Compares two independently captured rowset inventories. This is a raw
// comparison artifact, never a signed production restore attestation.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX = /^[a-f0-9]{64}$/u
const RELEASE = /^[A-Za-z0-9._:-]{1,128}$/u
const TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const requireValue = (ok, message) => { if (!ok) throw new Error(message) }
function readBounded(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    requireValue(st.isFile() && st.size > 0 && st.size <= 2 * 1024 * 1024, 'unsafe inventory file')
    const bytes = readFileSync(fd)
    return { value: JSON.parse(bytes.toString('utf8')), sha256: sha(bytes) }
  } finally { closeSync(fd) }
}
function exactArgs(args) {
  const names = ['--baseline', '--restored', '--capture', '--output']
  requireValue(args.length === names.length * 2, 'exact comparator arguments required')
  const found = {}
  for (let i = 0; i < args.length; i += 2) {
    requireValue(names.includes(args[i]) && !Object.hasOwn(found, args[i]) && args[i + 1], 'unknown or duplicate argument')
    found[args[i]] = resolve(args[i + 1])
  }
  requireValue(names.every(name => found[name]), 'missing comparator argument')
  requireValue(new Set(Object.values(found)).size === names.length, 'input and output paths must differ')
  return found
}
function inventory(value, kind, capture) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${kind} must be an object`)
  requireValue(value.schema_version === 'pg17-rowset-inventory/1' && value.kind === kind && value.simulated === false, `${kind} schema or provenance invalid`)
  requireValue(value.release_id === capture.release_id && value.backup_sha256 === capture.backup_sha256, `${kind} release or backup mismatch`)
  const expectedDatabase = kind === 'live-backup-baseline' ? capture.source_database_id_sha256 : capture.target_database_id_sha256
  requireValue(value.database_id_sha256 === expectedDatabase && HEX.test(value.database_id_sha256 ?? ''), `${kind} database identity mismatch`)
  requireValue(typeof value.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.observed_at) && Number.isFinite(Date.parse(value.observed_at)), `${kind} timestamp invalid`)
  requireValue(Array.isArray(value.tables) && value.tables.length >= 1 && value.tables.length <= 500, `${kind} tables missing or excessive`)
  const names = new Set()
  for (const table of value.tables) {
    requireValue(table && TABLE.test(table.name ?? '') && !names.has(table.name), `${kind} table name invalid or duplicate`)
    names.add(table.name)
    requireValue(Number.isSafeInteger(table.row_count) && table.row_count >= 0 && HEX.test(table.canonical_rows_sha256 ?? '') && HEX.test(table.rls_policy_sha256 ?? ''), `${kind} table observation invalid`)
  }
  return new Map(value.tables.map(table => [table.name, table]))
}
export function comparePg17DataIntegrity(baseline, restored, capture) {
  requireValue(capture?.schema_version === 'pg17-isolated-restore-capture/2' && capture.status === 'pass' && capture.simulated === false && RELEASE.test(capture.release_id ?? '') && /^[a-f0-9]{40}$/u.test(capture.release_git_sha ?? '') && /^sha256:[a-f0-9]{64}$/u.test(capture.image_set_digest ?? '') && HEX.test(capture.manifest_sha256 ?? '') && HEX.test(capture.deployment_nonce_sha256 ?? '') && HEX.test(capture.backup_sha256 ?? ''), 'verified PG17 v2 capture required')
  requireValue(Number.isSafeInteger(capture.migration_target_version) && capture.migration_target_version >= 242 && capture.restored_migration_prefix === '1:242:242' && capture.migrated_prefix === `1:${capture.migration_target_version}:${capture.migration_target_version}` && HEX.test(capture.migration_chain_sha256 ?? ''), 'capture migration binding invalid')
  requireValue(Array.isArray(capture.migration_chain_rows) && capture.migration_chain_rows.length === capture.migration_target_version && capture.migration_chain_rows.every((row, index) => typeof row === 'string' && row.startsWith(`${index + 1}|`)) && sha(capture.migration_chain_rows.join('\n')) === capture.migration_chain_sha256, 'capture migration chain invalid')
  requireValue(HEX.test(capture.source_database_id_sha256 ?? '') && HEX.test(capture.target_database_id_sha256 ?? '') && capture.source_database_id_sha256 !== capture.target_database_id_sha256, 'capture database identities invalid')
  requireValue(typeof capture.captured_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(capture.captured_at) && Number.isFinite(Date.parse(capture.captured_at)), 'capture timestamp invalid')
  const before = inventory(baseline, 'live-backup-baseline', capture)
  const after = inventory(restored, 'isolated-restore-observation', capture)
  requireValue(Date.parse(baseline.observed_at) <= Date.parse(capture.captured_at) && Date.parse(restored.observed_at) >= Date.parse(capture.captured_at), 'inventory chronology invalid')
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  const mismatches = names.filter(name => {
    const left = before.get(name), right = after.get(name)
    return !left || !right || left.row_count !== right.row_count || left.canonical_rows_sha256 !== right.canonical_rows_sha256 || left.rls_policy_sha256 !== right.rls_policy_sha256
  })
  return { status: mismatches.length === 0 ? 'pass' : 'fail', compared_table_count: names.length, mismatched_tables: mismatches }
}
function main(args) {
  const paths = exactArgs(args)
  const baseline = readBounded(paths['--baseline'])
  const restored = readBounded(paths['--restored'])
  const capture = readBounded(paths['--capture'])
  const result = comparePg17DataIntegrity(baseline.value, restored.value, capture.value)
  const artifact = { schema_version: 'pg17-data-integrity-comparison/1', simulated: false, release_id: capture.value.release_id, release_git_sha: capture.value.release_git_sha, image_set_digest: capture.value.image_set_digest, manifest_sha256: capture.value.manifest_sha256, deployment_nonce_sha256: capture.value.deployment_nonce_sha256, migration_target_version: capture.value.migration_target_version, backup_sha256: capture.value.backup_sha256, capture_sha256: capture.sha256, baseline_sha256: baseline.sha256, restored_sha256: restored.sha256, ...result, compared_at: new Date().toISOString(), comparison_id: randomBytes(12).toString('hex'), final_production_evidence: false }
  requireValue(dirname(paths['--output']) !== '/', 'output path must be scoped')
  writeFileSync(paths['--output'], `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`PG17 raw data comparison: ${artifact.status}; artifact=${paths['--output']}\n`)
  if (artifact.status !== 'pass') process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`PG17 data comparison rejected: ${error.message}\n`); process.exitCode = 1 }
}
