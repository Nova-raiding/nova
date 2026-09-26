#!/usr/bin/env node
// Produce a second review-only tree. No image, identity, or deployment inputs.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditBridgeReview } from './audit-ecs-bridge-254-review.mjs'

const MIGRATION = 'packages/persistence/src/migration.ts'
const CATALOG = 'packages/persistence/src/commercial-catalog-repository.ts'
const sha = value => createHash('sha256').update(value).digest('hex')
function files(directory, prefix = '') {
  const result = new Map()
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name
    const path = join(directory, name), stat = lstatSync(path)
    if (stat.isDirectory()) for (const [key, digest] of files(path, relative)) result.set(key, digest)
    else if (stat.isFile()) result.set(relative, sha(readFileSync(path)))
    else throw new Error(`overlay source contains a link or special file: ${relative}`)
  }
  return result
}
function replaceOnce(source, oldText, newText, label) {
  if (source.split(oldText).length !== 2) throw new Error(`B source anchor changed: ${label}`)
  return source.replace(oldText, newText)
}

export function buildBridgeOverlay({ review, output }) {
  if (!isAbsolute(output) || resolve(output) !== output || existsSync(output)) throw new Error('output must be a new absolute canonical path')
  if (output === review || output.startsWith(`${review}/`) || review.startsWith(`${output}/`)) throw new Error('overlay and input review paths must be separate')
  const audit = auditBridgeReview(review)
  if (audit.status !== 'blocked' || audit.blockers.map(item => item.code).join(',') !== 'BRIDGE_PREFIX_CONTRACT_244,OCR_VARIABLE_RATE_UNSUPPORTED') throw new Error('prepared review is not the audited B-derived source')
  mkdirSync(dirname(output), { recursive: true })
  const stage = mkdtempSync(join(dirname(output), '.bridge-254-overlay-'))
  try {
    const sourceRoot = join(stage, 'overlay-source')
    cpSync(join(review, 'review-source'), sourceRoot, { recursive: true, dereference: false })
    const before = files(sourceRoot)
    const migrationPath = join(sourceRoot, MIGRATION)
    let migration = readFileSync(migrationPath, 'utf8')
    const oldVerifier = `  if (mode !== 'prefix_242_or_244') throw new Error('bridge schema compatibility mode is not enabled')
  if (expected.length !== 244 || expected.some((migration, index) => migration.version !== index + 1)) {
    throw new Error('bridge release must carry the complete migration chain through 244')
  }
  if (applied.length !== 242 && applied.length !== 244) throw new Error('bridge database migration prefix must be exactly 242 or 244')
  verifyAppliedMigrations(applied, expected, migrationChecksumBaseline())
  return applied.length`
    const newVerifier = `  if (mode !== 'prefix_242_or_254') throw new Error('242-to-254 bridge schema compatibility mode is not enabled')
  if (expected.length !== 254 || expected.some((migration, index) => migration.version !== index + 1)) {
    throw new Error('242-to-254 bridge must carry the complete migration chain through 254')
  }
  if (applied.length !== 242 && applied.length !== 254) throw new Error('242-to-254 bridge database prefix must be exactly 242 or 254')
  verifyAppliedMigrations(applied, expected, migrationChecksumBaseline())
  return applied.length`
    migration = replaceOnce(migration, oldVerifier, newVerifier, 'bridge verifier')
    migration = replaceOnce(migration, '): 242 | 244 {\n  if (mode !== \'prefix_242_or_254\')', '): 242 | 254 {\n  if (mode !== \'prefix_242_or_254\')', 'bridge return type')
    writeFileSync(migrationPath, migration)

    const catalogPath = join(sourceRoot, CATALOG)
    let catalog = readFileSync(catalogPath, 'utf8')
    catalog = replaceOnce(catalog, "pricingMode: 'fixed' | 'starts_at' | 'unresolved'", "pricingMode: 'fixed' | 'starts_at' | 'unresolved' | 'variable'", 'rate mode union')
    const guard = `    // B has no variable OCR reservation/settlement policy. Fail before a
    // fixed v2 rate can be quoted or charged after 247/248.
    if (actionCode === 'ocr.extract') throw new CreativePointRateUnavailableError()
`
    catalog = replaceOnce(catalog, '  async resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate> {\n    const candidates', `  async resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate> {\n${guard}    const candidates`, 'memory OCR quote guard')
    catalog = replaceOnce(catalog, '  async resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate> {\n    const client', `  async resolveApprovedRate(actionCode: string): Promise<ApprovedCreativePointRate> {\n${guard}    const client`, 'Postgres OCR quote guard')
    catalog = replaceOnce(catalog, `      return result.rows.map(row => ({
        id: row.id!, rateCardId: row.rateCardId, version: row.version, actionCode: row.actionCode,
        unit: row.unit, integerPoints: ratePoints(row.integerPoints), pricingMode: row.pricingMode!,
        lifecycle: row.lifecycle!, approvalStatus: row.approvalStatus!, executable: row.executable!,
        ruleExecutable: row.ruleExecutable!, checksum: row.checksum, effectiveAt: iso(row.effectiveAt),
        blockers: rateBlockers(row.blockers),
      }))`, `      return result.rows.map(row => {
        if (!['fixed', 'starts_at', 'unresolved', 'variable'].includes(row.pricingMode ?? '')) throw new CreativePointRateUnavailableError()
        const variable = row.pricingMode === 'variable'
        return {
          id: row.id!, rateCardId: row.rateCardId, version: row.version, actionCode: row.actionCode,
          unit: row.unit, integerPoints: ratePoints(row.integerPoints), pricingMode: row.pricingMode!,
          lifecycle: row.lifecycle!, approvalStatus: row.approvalStatus!, executable: row.executable!,
          ruleExecutable: row.ruleExecutable! && !variable, checksum: row.checksum, effectiveAt: iso(row.effectiveAt),
          blockers: variable ? [...rateBlockers(row.blockers), 'BRIDGE_VARIABLE_OCR_RATE_UNSUPPORTED'] : rateBlockers(row.blockers),
        }
      })`, 'variable rate projection')
    writeFileSync(catalogPath, catalog)
    const after = files(sourceRoot)
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
    if (JSON.stringify(changed) !== JSON.stringify([CATALOG, MIGRATION].sort())) throw new Error('overlay changed outside the two-file allowlist')
    const manifest = {
      schema_version: 'ecs-bridge-254-compatibility-overlay/1', status: 'review_only', deployable: false, runtime_verified: false,
      source_review_tree_sha256: audit.review_tree_sha256, bridge_base_commit: audit.bridge_base_commit,
      migration_commit: audit.migration_commit, changed_paths: changed,
      changed_digests: Object.fromEntries(changed.map(path => [path, `sha256:${after.get(path)}`])),
      overlay_tree_sha256: `sha256:${sha([...after].map(([path, digest]) => `${path}\t${digest}\n`).join(''))}`,
      missing_proof: [
        'isolated PG17 242/254 API and six-worker execution',
        'variable OCR business acceptance',
        'entitlement v2 under 254 RLS',
        'intermediate-prefix traffic freeze and recovery',
        'separate reviewed Compose/preflight/package verifier: B deploy-preflight and package verifier require prefix_242_or_244',
      ],
    }
    writeFileSync(join(stage, 'overlay-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    renameSync(stage, output)
    return manifest
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 4 || args[0] !== '--review' || args[2] !== '--output') throw new Error('usage: overlay-ecs-bridge-254-review.mjs --review <prepared absolute directory> --output <new absolute directory>')
    process.stdout.write(`${JSON.stringify(buildBridgeOverlay({ review: args[1], output: args[3] }), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`bridge overlay rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
