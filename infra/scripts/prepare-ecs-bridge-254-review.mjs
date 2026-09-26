#!/usr/bin/env node
// Produce a local, non-deployable review tree. This does not build images,
// generate a candidate identity, sign evidence, or touch a remote host.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRIDGE_BASE_COMMIT = '4491ad2ee625156ca82615e475ad643a0e4e1c5a'
const MIGRATIONS = 'packages/persistence/src/migrations'
const REGISTRY = 'packages/persistence/src/migration.ts'
const METADATA = 'release-metadata.json'
const SHA = /^[0-9a-f]{40}$/u
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function git(args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, ...options })
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function shaFile(path) {
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256')
  try { let count; while ((count = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count)) }
  finally { closeSync(fd) }
  return hash.digest('hex')
}
function treeFiles(directory, prefix = '') {
  const result = new Map()
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), relativePath = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(path)
    if (stat.isDirectory()) for (const [key, value] of treeFiles(path, relativePath)) result.set(key, value)
    else if (stat.isFile()) result.set(relativePath, sha(readFileSync(path)))
    else throw new Error(`review source contains a link or special file: ${relativePath}`)
  }
  return result
}
function migrationInventory(commit) {
  return git(['ls-tree', '-r', commit, '--', MIGRATIONS], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .map(line => {
      const match = line.match(/^100644 blob ([0-9a-f]{40})\t(.+)$/u)
      requireValue(match, 'migration inventory contains a non-file entry')
      return { oid: match[1], path: match[2] }
    }).sort((a, b) => a.path.localeCompare(b.path))
}
function readCommitted(commit, path) { return git(['show', `${commit}:${path}`]) }
function requireValue(value, message) { if (!value) throw new Error(message) }

export function verifyMigrationInputs(migrationCommit) {
  requireValue(SHA.test(migrationCommit), 'migration commit must be a full Git SHA')
  requireValue(git(['rev-parse', `${migrationCommit}^{commit}`], { encoding: 'utf8' }).trim() === migrationCommit, 'migration commit is unavailable')
  requireValue(git(['rev-parse', `${BRIDGE_BASE_COMMIT}^{commit}`], { encoding: 'utf8' }).trim() === BRIDGE_BASE_COMMIT, 'pinned Bridge B commit is unavailable')
  const old = migrationInventory(BRIDGE_BASE_COMMIT), current = migrationInventory(migrationCommit)
  requireValue(old.length === 244 && current.length === 254, 'migration inventory must contain exactly 244 B and 254 current SQL files')
  const expectedName = (path, version) => {
    const name = path.split('/').at(-1) ?? ''
    return name.startsWith(`${String(version).padStart(3, '0')}_`) && /^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(name)
  }
  for (let index = 0; index < current.length; index++) requireValue(expectedName(current[index].path, index + 1), `migration inventory is not contiguous at ${index + 1}`)
  for (let index = 0; index < old.length; index++) {
    requireValue(old[index].path === current[index].path, `published migration name drift at ${index + 1}`)
    requireValue(old[index].oid === current[index].oid, `published migration SQL drift at ${index + 1}`)
  }
  const baseMetadata = JSON.parse(readCommitted(BRIDGE_BASE_COMMIT, METADATA).toString('utf8'))
  const currentMetadata = JSON.parse(readCommitted(migrationCommit, METADATA).toString('utf8'))
  requireValue(baseMetadata.expectedMigrationVersion === 244 && currentMetadata.expectedMigrationVersion === 254, 'release metadata migration tails must be 244 and 254')
  return current.slice(244).map(item => item.path)
}

function registryAdditions(migrationCommit, newNames) {
  const source = readCommitted(migrationCommit, REGISTRY).toString('utf8')
  const declarations = [], entries = []
  for (const path of newNames) {
    const name = path.split('/').at(-1), version = Number(name.slice(0, 3)), migrationName = name.slice(4, -4)
    const declaration = source.split('\n').filter(line => line.includes(`./migrations/${name}`))
    const entry = source.split('\n').filter(line => line.includes(`{ version: ${version}, name: '${migrationName}',`))
    requireValue(declaration.length === 1 && /^  const [A-Za-z][A-Za-z0-9]* = await readFile\(new URL\('\.\/migrations\/[0-9]{3}_[a-z0-9_]+\.sql', import\.meta\.url\), 'utf8'\)$/u.test(declaration[0]), `migration ${version} declaration is not a single reviewed readFile`)
    const variable = declaration[0].match(/^  const ([A-Za-z][A-Za-z0-9]*) =/u)?.[1]
    requireValue(entry.length === 1 && entry[0] === `    { version: ${version}, name: '${migrationName}', sql: ${variable} },`, `migration ${version} registry entry changed beyond the reviewed shape`)
    declarations.push(declaration[0]); entries.push(entry[0])
  }
  return { declarations, entries }
}

export function buildBridgeReview({ migrationCommit, output }) {
  requireValue(isAbsolute(output) && resolve(output) === output && !existsSync(output), 'output must be a new absolute canonical path')
  const newNames = verifyMigrationInputs(migrationCommit)
  const { declarations, entries } = registryAdditions(migrationCommit, newNames)
  mkdirSync(dirname(output), { recursive: true })
  const stage = mkdtempSync(join(dirname(output), '.bridge-254-review-'))
  try {
    const sourceRoot = join(stage, 'review-source')
    mkdirSync(sourceRoot)
    const archivePath = join(stage, 'bridge-base.tar')
    git(['archive', '--format=tar', `--output=${archivePath}`, BRIDGE_BASE_COMMIT, ':(exclude)artifacts', ':(exclude)screenshots'])
    execFileSync('tar', ['-xf', archivePath, '-C', sourceRoot])
    const before = treeFiles(sourceRoot)
    const registryPath = join(sourceRoot, REGISTRY)
    const originalRegistry = readFileSync(registryPath, 'utf8')
    const declarationAnchor = "  const localPluginInstallInstances = await readFile(new URL('./migrations/244_local_plugin_install_instances.sql', import.meta.url), 'utf8')"
    const entryAnchor = "    { version: 244, name: 'local_plugin_install_instances', sql: localPluginInstallInstances },"
    requireValue(originalRegistry.split(declarationAnchor).length === 2 && originalRegistry.split(entryAnchor).length === 2, 'B migration registry anchors changed')
    const updatedRegistry = originalRegistry.replace(declarationAnchor, `${declarationAnchor}\n${declarations.join('\n')}`)
      .replace(entryAnchor, `${entryAnchor}\n${entries.join('\n')}`)
    writeFileSync(registryPath, updatedRegistry)
    const oldMetadata = readFileSync(join(sourceRoot, METADATA), 'utf8')
    const newMetadata = JSON.parse(oldMetadata)
    newMetadata.expectedMigrationVersion = 254
    writeFileSync(join(sourceRoot, METADATA), `${JSON.stringify(newMetadata, null, 2)}\n`)
    const migrationDigests = {}
    for (const path of newNames) {
      const bytes = readCommitted(migrationCommit, path)
      writeFileSync(join(sourceRoot, path), bytes)
      migrationDigests[path] = `sha256:${sha(bytes)}`
    }
    const after = treeFiles(sourceRoot)
    const changes = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
    const allowlist = [REGISTRY, METADATA, ...newNames].sort()
    requireValue(JSON.stringify(changes) === JSON.stringify(allowlist), 'B review tree changed outside the strict migration allowlist')
    requireValue(readFileSync(registryPath, 'utf8').replace(`\n${declarations.join('\n')}`, '').replace(`\n${entries.join('\n')}`, '') === originalRegistry, 'B registry changed outside 245-254 additions')
    requireValue(JSON.stringify({ ...newMetadata, expectedMigrationVersion: 244 }) === JSON.stringify(JSON.parse(oldMetadata)), 'B release metadata changed outside migration tail')
    const manifest = {
      schema_version: 'ecs-bridge-254-source-review/1', status: 'review_only', deployable: false,
      bridge_base_commit: BRIDGE_BASE_COMMIT, migration_commit: migrationCommit,
      bridge_base_archive_sha256: `sha256:${shaFile(archivePath)}`, migration_target_version: 254,
      migration_digests: migrationDigests, changed_paths: changes,
      review_tree_sha256: `sha256:${sha([...after].map(([path, digest]) => `${path}\t${digest}\n`).join(''))}`,
    }
    writeFileSync(join(stage, 'review-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
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
    requireValue(args.length === 4 && args[0] === '--migration-commit' && args[2] === '--output', 'usage: prepare-ecs-bridge-254-review.mjs --migration-commit <full SHA> --output <new absolute directory>')
    const manifest = buildBridgeReview({ migrationCommit: args[1], output: args[3] })
    process.stdout.write(`bridge source review package created: ${manifest.bridge_base_commit} + ${manifest.migration_commit}; deployable=false\n`)
  } catch (error) {
    process.stderr.write(`bridge source review rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
