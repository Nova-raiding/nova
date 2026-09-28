#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Root-only staged installation. Requires an owner-reviewed manifest digest.
// No database, Docker, nonce ledger, signing key or backup is opened here.
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = '/usr/local/libexec/merchant'
const TRUST = '/run/release-security/evidence-trust'
const STATE = '/var/lib/merchant-release-security'
const NODE = `${BIN}/runtime/node-v22.23.2-linux-x64/bin/node`
const CONSUMER = `${BIN}/consume-production-evidence-nonce`
const CONSUMER_DIGEST = `${TRUST}/production-evidence-nonce-consumer-sha256`
const LOCK = `${STATE}/demo254-control-install.lock`
const JOURNAL = `${STATE}/demo254-control-install-recovery.json`
const SHA = /^[a-f0-9]{64}$/u
const controls = [
  { key: 'demo254Plan', file: 'attest-demo-254-frozen-plan', digest: 'production-demo-254-plan-signer-sha256' },
  { key: 'demo254Backup', file: 'attest-demo-254-backup', digest: 'production-demo-254-backup-attester-sha256' },
]
const targets = [...controls.flatMap(item => [join(BIN, item.file), join(TRUST, item.digest)]), CONSUMER, CONSUMER_DIGEST]
const check = (value, message) => { if (!value) throw new Error(message) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function protectedPath(path, max = 2 * 1024 * 1024) {
  check(path === resolve(path) && realpathSync(path) === path, 'protected input must be canonical')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    check(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'protected path owner/mode invalid')
    if (cursor === '/') break
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const stat = fstatSync(fd); check(stat.isFile() && stat.size > 0 && stat.size <= max, 'protected input invalid'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
function protectedDirectory(path) {
  check(path === resolve(path) && realpathSync(path) === path, 'protected directory must be canonical')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'protected directory owner/mode invalid')
    if (cursor === '/') break
  }
}
function present(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function atomic(path, bytes, mode) {
  const temp = join(dirname(path), `.demo254-${randomBytes(12).toString('hex')}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path)
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function snapshot() {
  return targets.map(path => {
    const stat = present(path)
    return stat ? { path, mode: stat.mode & 0o777, bytes: protectedPath(path).toString('base64') } : { path, mode: null, bytes: null }
  })
}
export function validateDemo254InstallManifest(manifest, bytes) {
  check(manifest?.schema_version === 'demo-254-protected-controls/1' && /^[a-f0-9]{40}$/u.test(manifest.source_commit ?? '')
    && SHA.test(manifest.plan_bundle_sha256 ?? '') && SHA.test(manifest.backup_bundle_sha256 ?? '')
    && SHA.test(manifest.nonce_consumer_sha256 ?? ''), 'reviewed control manifest invalid')
  check(sha(bytes.plan) === manifest.plan_bundle_sha256 && sha(bytes.backup) === manifest.backup_bundle_sha256
    && sha(bytes.nonce) === manifest.nonce_consumer_sha256, 'staged control checksum mismatch')
  check(bytes.plan.toString('utf8').startsWith(`#!${NODE}\n`)
    && bytes.backup.toString('utf8').startsWith(`#!${NODE}\n`)
    && bytes.nonce.toString('utf8').startsWith('#!/usr/bin/env python3\n'), 'staged executable header invalid')
  return true
}
export function runDemo254InstallSteps(steps, restorePrevious) {
  check(Array.isArray(steps) && steps.length === 3 && typeof restorePrevious === 'function', 'install steps invalid')
  try { for (const step of steps) step() }
  catch (error) {
    try { restorePrevious() } catch { throw new Error('installation failed and recovery journal remains; run recover before any backup') }
    throw new Error(`installation failed and prior controls restored: ${error.message}`)
  }
}
function argsOf(args) {
  check(args[0] === 'install' || args[0] === 'recover', 'install or recover required')
  const names = args[0] === 'install'
    ? ['--stage', '--approved-manifest-sha256', '--installer', '--approved-installer-sha256', '--approved-wrapper-sha256', '--node-sha256']
    : ['--approved-wrapper-sha256']
  check(args.length === 1 + 2 * names.length, 'exact installation arguments required')
  const values = new Map()
  for (let i = 1; i < args.length; i += 2) { check(names.includes(args[i]) && !values.has(args[i]), 'unknown or duplicate installation argument'); values.set(args[i], args[i + 1]) }
  for (const name of names) check(values.has(name), `${name} missing`)
  for (const name of names.filter(name => name.endsWith('sha256'))) check(SHA.test(values.get(name) ?? ''), `${name} invalid`)
  if (args[0] === 'install') {
    check(values.get('--stage') === resolve(values.get('--stage')) && values.get('--installer') === resolve(values.get('--installer')), 'stage/installer path must be absolute')
  }
  return { mode: args[0], values }
}
function recover(state) {
  check(state?.schema_version === 'demo-254-control-install-recovery/1'
    && Array.isArray(state.files) && state.files.length === targets.length
    && state.files.every((item, index) => item.path === targets[index]
      && (item.bytes === null || typeof item.bytes === 'string')
      && (item.mode === null || Number.isInteger(item.mode))), 'recovery journal invalid')
  for (const item of state.files) {
    if (item.bytes === null) { if (present(item.path)) unlinkSync(item.path) }
    else atomic(item.path, Buffer.from(item.bytes, 'base64'), item.mode)
  }
  unlinkSync(JOURNAL)
}
function main(args) {
  check(process.getuid?.() === 0 && process.geteuid?.() === 0 && !process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'clean root runtime required')
  const { mode, values } = argsOf(args)
  check(sha(protectedPath(process.argv[1])) === values.get('--approved-wrapper-sha256'), 'wrapper source digest mismatch')
  for (const path of [BIN, TRUST, STATE]) protectedDirectory(path)
  mkdirSync(LOCK, { mode: 0o700 })
  try {
    if (mode === 'recover') {
      recover(JSON.parse(protectedPath(JOURNAL).toString('utf8')))
      process.stdout.write('demo 254 controls recovered to pre-install bytes\n')
      return
    }
    check(!present(JOURNAL), 'unfinished install journal requires recover')
    const stage = values.get('--stage')
    protectedDirectory(stage)
    check(sha(protectedPath(NODE, 256 * 1024 * 1024)) === values.get('--node-sha256'), 'protected Node digest mismatch')
    const installer = values.get('--installer')
    check(sha(protectedPath(installer)) === values.get('--approved-installer-sha256'), 'reviewed generic installer digest mismatch')
    const manifestBytes = protectedPath(join(stage, 'manifest.json'))
    check(sha(manifestBytes) === values.get('--approved-manifest-sha256'), 'owner-approved manifest digest mismatch')
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const bytes = { plan: protectedPath(join(stage, controls[0].file)), backup: protectedPath(join(stage, controls[1].file)),
      nonce: protectedPath(join(stage, 'consume-production-evidence-nonce')) }
    validateDemo254InstallManifest(manifest, bytes)
    const state = { schema_version: 'demo-254-control-install-recovery/1', manifest_sha256: sha(manifestBytes), files: snapshot() }
    const journal = Buffer.from(`${JSON.stringify(state)}\n`)
    const fd = openSync(JOURNAL, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, journal); fsyncSync(fd) } finally { closeSync(fd) }
    const parent = openSync(STATE, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(parent) } finally { closeSync(parent) }
    runDemo254InstallSteps([
      ...controls.map((item, index) => () => {
        const source = join(stage, item.file), sourceSha = index === 0 ? manifest.plan_bundle_sha256 : manifest.backup_bundle_sha256
        execFileSync(NODE, [installer, '--control', item.key, '--source', source, '--source-sha256', sourceSha,
          '--node', NODE, '--node-sha256', values.get('--node-sha256')], { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] })
      }),
      () => {
      // Install the new nonce consumer last: old operation semantics remain
      // active until both digest-pinned backup controls are in place.
      atomic(CONSUMER, bytes.nonce, 0o755)
      atomic(CONSUMER_DIGEST, Buffer.from(`${manifest.nonce_consumer_sha256}\n`), 0o444)
      check(sha(protectedPath(CONSUMER)) === manifest.nonce_consumer_sha256
        && protectedPath(CONSUMER_DIGEST, 128).toString('utf8').trim() === manifest.nonce_consumer_sha256, 'nonce consumer install readback failed')
      },
    ], () => recover(state))
    unlinkSync(JOURNAL)
    process.stdout.write(`${JSON.stringify({ schema_version: 'demo-254-control-install/1', source_commit: manifest.source_commit,
      manifest_sha256: sha(manifestBytes), plan_sha256: manifest.plan_bundle_sha256,
      backup_sha256: manifest.backup_bundle_sha256, nonce_sha256: manifest.nonce_consumer_sha256,
      database_mutations: false, backup_created: false })}\n`)
  } finally { rmdirSync(LOCK) }
}
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`demo 254 control install rejected: ${error.message}\n`); process.exitCode = 1 }
}
