#!/usr/bin/env node
// Static audit of a prepared B-derived source tree. A successful audit is
// deliberately not a runtime or deployability verdict.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIDGE_BASE_COMMIT } from './prepare-ecs-bridge-254-review.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const REPOSITORY = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MIGRATIONS = 'packages/persistence/src/migrations'

function git(args, options = {}) {
  return execFileSync('git', ['-C', REPOSITORY, ...args], { maxBuffer: 256 * 1024 * 1024, ...options })
}

function files(directory, prefix = '') {
  const found = new Map()
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) for (const [key, digest] of files(path, relative)) found.set(key, digest)
    else if (stat.isFile()) found.set(relative, sha(readFileSync(path)))
    else throw new Error(`review source contains a link or special file: ${relative}`)
  }
  return found
}

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(`cannot audit changed B source contract: ${message}`)
}

function verifyDerivedTree(directory, manifest, sourceRoot) {
  const stage = mkdtempSync(join(tmpdir(), 'bridge-254-audit-'))
  try {
    const archive = join(stage, 'base.tar'), base = join(stage, 'base')
    mkdirSync(base)
    git(['archive', '--format=tar', `--output=${archive}`, BRIDGE_BASE_COMMIT, ':(exclude)artifacts', ':(exclude)screenshots'])
    if (`sha256:${sha(readFileSync(archive))}` !== manifest.bridge_base_archive_sha256) throw new Error('B source archive is not the pinned Git archive')
    execFileSync('tar', ['-xf', archive, '-C', base])
    const baseline = files(base), actual = files(sourceRoot)
    const currentMigrations = git(['ls-tree', '-r', manifest.migration_commit, '--', MIGRATIONS], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      .map(line => line.match(/^100644 blob ([0-9a-f]{40})\t(.+)$/u))
    if (currentMigrations.length !== 254 || currentMigrations.some(match => !match)) throw new Error('migration commit inventory is not 254 regular SQL files')
    const added = currentMigrations.slice(244).map(match => match[2])
    const expectedPaths = new Set([...baseline.keys(), ...added])
    if (actual.size !== expectedPaths.size || [...actual.keys()].some(path => !expectedPaths.has(path))) throw new Error('review tree paths do not match pinned B plus migration additions')
    for (const [path, digest] of baseline) {
      if (path === 'release-metadata.json' || path === 'packages/persistence/src/migration.ts') continue
      if (actual.get(path) !== digest) throw new Error(`review tree differs from pinned B source: ${path}`)
    }
    for (const [index, path] of added.entries()) {
      const blob = currentMigrations[index + 244][1]
      const expected = git(['cat-file', 'blob', blob])
      if (sha(expected) !== actual.get(path)) throw new Error(`migration addition is not the pinned commit blob: ${path}`)
    }
    const baseMeta = JSON.parse(readFileSync(join(base, 'release-metadata.json'), 'utf8'))
    const actualMeta = JSON.parse(readFileSync(join(sourceRoot, 'release-metadata.json'), 'utf8'))
    if (baseMeta.expectedMigrationVersion !== 244 || actualMeta.expectedMigrationVersion !== 254
      || JSON.stringify({ ...actualMeta, expectedMigrationVersion: 244 }) !== JSON.stringify(baseMeta)) throw new Error('review metadata is not the B metadata with only the 254 tail')
    const baseRegistry = readFileSync(join(base, 'packages/persistence/src/migration.ts'), 'utf8')
    const sourceRegistry = readFileSync(join(sourceRoot, 'packages/persistence/src/migration.ts'), 'utf8')
    const commitRegistry = git(['show', `${manifest.migration_commit}:packages/persistence/src/migration.ts`], { encoding: 'utf8' })
    const declarations = [], entries = []
    for (const path of added) {
      const name = path.split('/').at(-1), version = Number(name.slice(0, 3)), migrationName = name.slice(4, -4)
      const declaration = commitRegistry.split('\n').filter(line => line.includes(`./migrations/${name}`))
      const entry = commitRegistry.split('\n').filter(line => line.includes(`{ version: ${version}, name: '${migrationName}',`))
      if (declaration.length !== 1 || entry.length !== 1) throw new Error(`migration ${version} registry addition is ambiguous`)
      declarations.push(declaration[0]); entries.push(entry[0])
    }
    const declAnchor = "  const localPluginInstallInstances = await readFile(new URL('./migrations/244_local_plugin_install_instances.sql', import.meta.url), 'utf8')"
    const entryAnchor = "    { version: 244, name: 'local_plugin_install_instances', sql: localPluginInstallInstances },"
    const expectedRegistry = baseRegistry.replace(declAnchor, `${declAnchor}\n${declarations.join('\n')}`).replace(entryAnchor, `${entryAnchor}\n${entries.join('\n')}`)
    if (expectedRegistry === baseRegistry || sourceRegistry !== expectedRegistry) throw new Error('review migration registry is not independently derived from pinned B and migration commit')
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

export function auditBridgeReview(directory) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('review directory must be an absolute canonical path')
  const manifest = JSON.parse(readFileSync(join(directory, 'review-manifest.json'), 'utf8'))
  if (manifest.schema_version !== 'ecs-bridge-254-source-review/1' || manifest.status !== 'review_only' || manifest.deployable !== false
    || manifest.bridge_base_commit !== BRIDGE_BASE_COMMIT || manifest.migration_target_version !== 254) {
    throw new Error('review manifest identity or non-deployable status changed')
  }
  const archiveDigest = `sha256:${sha(readFileSync(join(directory, 'bridge-base.tar')))}`
  if (archiveDigest !== manifest.bridge_base_archive_sha256) throw new Error('B source archive digest mismatch')
  const sourceRoot = join(directory, 'review-source')
  verifyDerivedTree(directory, manifest, sourceRoot)
  const inventory = files(sourceRoot)
  const treeDigest = `sha256:${sha([...inventory].map(([path, digest]) => `${path}\t${digest}\n`).join(''))}`
  if (treeDigest !== manifest.review_tree_sha256) throw new Error('review source tree digest mismatch')
  for (const [path, digest] of Object.entries(manifest.migration_digests)) {
    if (`sha256:${inventory.get(path)}` !== digest) throw new Error(`migration digest mismatch: ${path}`)
  }
  const read = path => readFileSync(join(sourceRoot, path), 'utf8')
  const migration = read('packages/persistence/src/migration.ts')
  const catalog = read('packages/persistence/src/commercial-catalog-repository.ts')
  const contract = read('packages/persistence/src/commercial-contract-repository.ts')
  const sql247 = read('packages/persistence/src/migrations/247_ocr_cost_rate_v3.sql')
  const sql248 = read('packages/persistence/src/migrations/248_ocr_free_threshold_rate_v4.sql')
  const sql254 = read('packages/persistence/src/migrations/254_merchant_entitlement_snapshot_cursor.sql')

  requireMatch(migration, /mode !== 'prefix_242_or_244'/u, 'old bridge mode')
  requireMatch(migration, /expected\.length !== 244/u, 'old bridge inventory bound')
  requireMatch(migration, /applied\.length !== 242 && applied\.length !== 244/u, 'old bridge prefix bound')
  requireMatch(catalog, /pricingMode: 'fixed' \| 'starts_at' \| 'unresolved'/u, 'B rate mode type')
  requireMatch(catalog, /pricingMode: row\.pricingMode!/u, 'B listRates unchecked pricing mode')
  requireMatch(catalog, /r\.pricing_mode = 'fixed' AND r\.integer_points > 0/u, 'B fixed-only rate resolver')
  requireMatch(sql247, /'ocr\.extract', 'request', NULL,\s*'variable', '[^']*cost_cny_x2_ceil_min1/u, '247 variable OCR rate')
  requireMatch(sql248, /'ocr\.extract', 'request', NULL,\s*'variable', '[^']*cost_cny_threshold_x2_ceil_v1/u, '248 variable OCR rate')
  requireMatch(contract, /FROM public\.merchant_entitlement_snapshots_v2\(\$1\)/u, 'B entitlement v2 query')
  requireMatch(sql254, /CREATE OR REPLACE FUNCTION public\.merchant_entitlement_snapshots_v3\(/u, '254 entitlement v3 addition')
  if (/DROP FUNCTION\s+(?:IF EXISTS\s+)?(?:public\.)?merchant_entitlement_snapshots_v2\b/iu.test(sql254)) throw new Error('254 removes the B entitlement v2 function')

  return {
    schema_version: 'ecs-bridge-254-compatibility-audit/1', status: 'blocked', deployable: false,
    runtime_verified: false, bridge_base_commit: manifest.bridge_base_commit,
    migration_commit: manifest.migration_commit, review_tree_sha256: treeDigest,
    blockers: [
      { code: 'BRIDGE_PREFIX_CONTRACT_244', evidence: 'packages/persistence/src/migration.ts', detail: 'B verifier requires 244 migrations and permits only schema 242 or 244; the review tree ships 254.' },
      { code: 'OCR_VARIABLE_RATE_UNSUPPORTED', evidence: 'packages/persistence/src/commercial-catalog-repository.ts', detail: '247/248 publish variable OCR rates with null integer points; B listRates maps this mode unchecked and resolveApprovedRate selects fixed rates only.' },
    ],
    requires_pg17_evidence: [
      'B API and six workers with the same immutable review-derived image at isolated schema 242 and 254',
      '247/248 OCR variable pricing and historical reservation/settlement with real relay receipts',
      'B entitlement v2 function call under merchant_app workspace RLS after migration 254',
      'Migration interruption and recovery at every exposed prefix or a verified traffic and worker freeze',
    ],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--review') throw new Error('usage: audit-ecs-bridge-254-review.mjs --review <absolute prepared directory>')
    process.stdout.write(`${JSON.stringify(auditBridgeReview(process.argv[3]), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`bridge compatibility audit rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
