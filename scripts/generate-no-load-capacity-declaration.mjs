#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gate = resolve(root, 'tests/capacity-evidence-gate.ts')
const allowedValues = new Set([
  '--release-id', '--confirm-release-id', '--verified-by', '--software-version',
  '--config-version', '--data-version', '--target-url', '--expires-at', '--output',
])

function usage() {
  return [
    'Usage: npm run capacity:no-load:declare -- --release-id <id> --confirm-release-id <same-id>',
    '  --verified-by <operator> --software-version <version> --config-version <version>',
    '  --data-version <version> --target-url https://yxsona.com --expires-at <ISO-8601>',
    '  --output <absolute-new-file-path>',
    'Creates only an unsigned no_load declaration; it performs no network or load test.',
  ].join('\n')
}

function parseArgs(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (!allowedValues.has(name)) throw new Error(`unsupported or missing option: ${name ?? ''}`)
    if (values.has(name)) throw new Error(`duplicate option: ${name}`)
    const value = args[index + 1]
    if (typeof value !== 'string' || value.startsWith('--') || !value.trim()) throw new Error(`${name} requires a non-empty value`)
    values.set(name, value)
    index += 1
  }
  for (const name of allowedValues) if (!values.has(name)) throw new Error(`${name} is required`)
  return Object.fromEntries([...values].map(([name, value]) => [name.slice(2).replaceAll('-', '_'), value]))
}

function requiredText(value, label, max = 256) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a trimmed non-empty value without control characters (max ${max})`)
  }
  return value
}

function parseStrictInstant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`${label} must be an ISO-8601 instant with timezone`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`)
  return timestamp
}

function validateInputs(input, now = new Date()) {
  const releaseId = requiredText(input.release_id, '--release-id', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) throw new Error('--release-id contains unsafe characters')
  if (input.confirm_release_id !== releaseId) throw new Error('--confirm-release-id must exactly match --release-id')
  const verifiedBy = requiredText(input.verified_by, '--verified-by', 120)
  const softwareVersion = requiredText(input.software_version, '--software-version')
  const configVersion = requiredText(input.config_version, '--config-version')
  const dataVersion = requiredText(input.data_version, '--data-version')

  // The declaration is specific to this project's canonical production URL;
  // accepting arbitrary HTTPS hosts could mislabel staging as production.
  if (input.target_url !== 'https://yxsona.com') throw new Error('--target-url must exactly equal the canonical production origin https://yxsona.com')
  const expiresAtMs = parseStrictInstant(input.expires_at, '--expires-at')
  if (expiresAtMs <= now.getTime() + 60_000) throw new Error('--expires-at must be at least one minute in the future')

  return {
    releaseId,
    verifiedBy,
    softwareVersion,
    configVersion,
    dataVersion,
    targetUrl: input.target_url,
    expiresAt: new Date(expiresAtMs).toISOString(),
    issuedAt: now.toISOString(),
  }
}

function validateOutputPath(outputPath) {
  if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) throw new Error('--output must be an absolute, normalized path')
  const parent = dirname(outputPath)
  let parentStat
  try { parentStat = lstatSync(parent) } catch { throw new Error('--output parent directory must already exist') }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('--output parent must be a real directory, not a symlink')
  const canonicalParent = realpathSync(parent)
  if (canonicalParent !== parent) throw new Error('--output parent path must be canonical and contain no symlink components')
  if (typeof process.getuid !== 'function' || parentStat.uid !== process.getuid()) throw new Error('--output parent must be owned by the invoking user')
  if ((parentStat.mode & 0o777) !== 0o700) throw new Error('--output parent must have mode 0700')
  try {
    const outputStat = lstatSync(outputPath)
    if (outputStat.isSymbolicLink()) throw new Error('--output already exists as a symlink')
    throw new Error('--output already exists; declarations are append-only')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!basename(outputPath)) throw new Error('--output must name a file')
  return parent
}

function buildDeclaration(input, now = new Date()) {
  const values = validateInputs(input, now)
  return {
    schema_version: '1',
    status: 'not_performed',
    release_id: values.releaseId,
    software_version: values.softwareVersion,
    config_version: values.configVersion,
    data_version: values.dataVersion,
    environment: 'production',
    target_url: values.targetUrl,
    started_at: values.issuedAt,
    ended_at: values.issuedAt,
    expires_at: values.expiresAt,
    generated_at: values.issuedAt,
    profile: 'no_load',
    cloud_gate: false,
    scope: 'no_load',
    capacity_commitment: 'none',
    reason: 'load_testing_excluded_by_release_scope',
    sign_off: { verified_by: values.verifiedBy, verified_at: values.issuedAt },
  }
}

function validateWithExistingGate(path, releaseId) {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', gate, '--file', path, '--release-id', releaseId, '--profile', 'no_load',
  ], { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw new Error(`capacity evidence gate could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`capacity evidence gate rejected the declaration:\n${result.stderr || result.stdout}`)
  process.stdout.write('existing capacity gate validated --profile no_load (declaration only; no load test or cloud gate)\n')
}

function writeExclusive(filePath, bytes) {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function generateDeclaration(input, now = new Date()) {
  const outputPath = input.output
  const outputParent = validateOutputPath(outputPath)
  const document = buildDeclaration(input, now)
  const temporaryPath = resolve(outputParent, `.${basename(outputPath)}.unsigned-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  try {
    writeExclusive(temporaryPath, `${JSON.stringify(document, null, 2)}\n`)
    validateWithExistingGate(temporaryPath, document.release_id)
    // Hard-link creation is atomic and will not replace an output created by
    // another process between the initial inspection and this point.
    linkSync(temporaryPath, outputPath)
    validateWithExistingGate(outputPath, document.release_id)
    const directoryFd = openSync(outputParent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    process.stdout.write(`unsigned no_load declaration created (not a capacity pass or signature): ${outputPath}\n`)
    return document
  } finally {
    try { unlinkSync(temporaryPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    // Once linked, output is append-only and deliberately retained even if a
    // post-write verifier or directory sync reports an operational error.
    // Deliberately retain the final path after linking, including if a later
    // durability check reports an operational error.
  }
}

function main() {
  if (process.argv[2] === '--help') { process.stdout.write(`${usage()}\n`); return }
  try {
    const input = parseArgs(process.argv.slice(2))
    generateDeclaration(input)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
