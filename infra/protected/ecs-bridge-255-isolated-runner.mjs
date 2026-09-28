#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Bundle from an exact reviewed commit and install through the protected
// control installer. This root entry only writes isolated PG17 preview state;
// it has no live DB endpoint, Compose, gateway, nonce consumer or cutover verb.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSignedBridge255PreviewPlan, runSignedBridge255Preview,
  verifySignedBridge255PreviewPlan } from './ecs-bridge-255-isolated-preview.mjs'
import { createIsolatedPg17DockerPorts } from './ecs-bridge-255-isolated-host.mjs'
import { validateBridge255Plan } from './ecs-bridge-255-review.mjs'

const INSTALLED = '/usr/local/libexec/merchant/ecs-bridge-255-isolated-runner'
const TRUST = '/run/release-security/evidence-trust'
const ROOT = '/var/lib/merchant-release-security'
const BACKUPS = `${ROOT}/backups`
const STAGING = `${ROOT}/bridge-255`
const OUTPUT = `${ROOT}/preview-restores`
const DIGEST = `${TRUST}/production-bridge-255-isolated-runner-sha256`
const PUBLIC = `${TRUST}/production-evidence-public.pem`
const KEY_ID = `${TRUST}/production-evidence-key-id`
const PRIVATE = `${ROOT}/production-capability-private.pem`
const SOURCE_PLAN = `${TRUST}/production-demo-254-backup-source-plan.json`
const PREVIEW_PLAN = `${TRUST}/production-bridge-255-isolated-preview-plan.json`
const HEX = /^[a-f0-9]{64}$/u
const fail = reason => { throw new Error(`BRIDGE_255_ISOLATED_RUNNER_${reason}`) }
const check = (ok, reason) => { if (!ok) fail(reason) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)

function protectedPath(path, kind = 'file') {
  check(path === resolve(path) && realpathSync(path) === path, 'PATH_NOT_CANONICAL')
  let cursor = path
  for (;;) {
    const stat = lstatSync(cursor)
    check(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0,
      'PATH_NOT_PROTECTED')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
  check(kind === 'file' ? lstatSync(path).isFile() : lstatSync(path).isDirectory(),
    'PATH_KIND_INVALID')
}

function readProtected(path, limit) {
  protectedPath(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size > 0 && stat.size <= limit, 'INPUT_SIZE_INVALID')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

export function parseBridge255IsolatedArgs(args) {
  const keys = ['--backup', '--attestation', '--capture',
    '--migration-255', '--output']
  check(args.length === keys.length * 2, 'ARGUMENT_COUNT_INVALID')
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    check(keys.includes(args[index]) && !Object.hasOwn(values, args[index])
      && typeof args[index + 1] === 'string', 'ARGUMENT_INVALID')
    values[args[index]] = args[index + 1]
  }
  check(keys.every(key => values[key]), 'ARGUMENT_MISSING')
  return values
}

export function parseBridge255PreviewPlanArgs(args) {
  check(['inspect', 'sign'].includes(args[0]), 'MODE_INVALID')
  const common = ['--attempt-id', '--pg17-image-id', '--created-at', '--backup', '--attestation',
    '--capture', '--migration-255', '--output']
  const keys = args[0] === 'sign' ? [...common, '--approved-plan-sha256'] : common
  check(args.length === 1 + keys.length * 2, 'ARGUMENT_COUNT_INVALID')
  const values = {}
  for (let index = 1; index < args.length; index += 2) {
    check(keys.includes(args[index]) && !Object.hasOwn(values, args[index])
      && typeof args[index + 1] === 'string', 'ARGUMENT_INVALID')
    values[args[index]] = args[index + 1]
  }
  check(keys.every(key => values[key])
    && /^[A-Za-z0-9_-]{16,128}$/u.test(values['--attempt-id'] ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(values['--pg17-image-id'] ?? '')
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(values['--created-at'] ?? '')
    && Number.isFinite(Date.parse(values['--created-at']))
    && (args[0] !== 'sign' || HEX.test(values['--approved-plan-sha256'] ?? '')),
  'ARGUMENT_MISSING_OR_INVALID')
  return { mode: args[0], values }
}

export function verifySignedBridge255Plan(envelope, publicPem, keyId) {
  check(envelope && Object.keys(envelope).sort().join(',') === 'key_id,plan,signature_base64'
    && envelope.key_id === keyId, 'PLAN_ENVELOPE_INVALID')
  const key = createPublicKey(publicPem)
  const bytes = Buffer.from(envelope.signature_base64 ?? '', 'base64')
  check(key.asymmetricKeyType === 'ed25519' && bytes.length === 64
    && bytes.toString('base64') === envelope.signature_base64
    && verify(null, Buffer.from(canonical(envelope)), key, bytes),
  'PLAN_SIGNATURE_INVALID')
  validateBridge255Plan(envelope.plan)
  return envelope.plan
}

export function validateBridge255IsolatedPaths(options, plan) {
  const attemptDir = join(BACKUPS,
    `${plan.source_release_id ?? plan.bridge_254_255?.identity.release_id}-demo254-${plan.attempt_id}`)
  check(dirname(options['--backup']) === attemptDir
    && basename(options['--backup']) === 'before-upgrade-254.dump'
    && options['--attestation'] === `${options['--backup']}.attestation.json`
    && options['--capture'] === `${options['--backup']}.capture.json`,
  'BACKUP_ATTEMPT_PATH_INVALID')
  const assets = join(STAGING, plan.attempt_id)
  check(options['--migration-255'] === join(assets, '255_scoped_brand_settings.sql')
    && options['--output'] === join(OUTPUT, `${plan.attempt_id}-isolated-255.json`),
  'CANDIDATE_ASSET_PATH_INVALID')
}

async function main(args) {
  check(process.getuid?.() === 0 && process.geteuid?.() === 0,
    'ROOT_REQUIRED')
  check(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'NODE_ENV_UNSAFE')
  check(realpathSync(process.argv[1]) === INSTALLED, 'FIXED_INSTALL_REQUIRED')
  for (const path of [INSTALLED, DIGEST, PUBLIC, KEY_ID, PRIVATE,
    SOURCE_PLAN, '/usr/bin/docker', process.execPath]) protectedPath(path)
  check((lstatSync(PRIVATE).mode & 0o777) === 0o600, 'PRIVATE_KEY_MODE_INVALID')
  for (const path of [BACKUPS, STAGING, OUTPUT]) protectedPath(path, 'directory')
  check(sha(readProtected(INSTALLED, 4 * 1024 * 1024))
    === readProtected(DIGEST, 128).toString().trim(), 'INSTALLED_DIGEST_INVALID')
  const publicPem = readProtected(PUBLIC, 8192).toString()
  const keyId = readProtected(KEY_ID, 128).toString().trim()
  const planning = args[0] === 'inspect' || args[0] === 'sign'
  const parsed = planning ? parseBridge255PreviewPlanArgs(args) : null
  const options = planning ? parsed.values : parseBridge255IsolatedArgs(args)
  const attemptId = planning ? options['--attempt-id'] : null
  const plan = planning ? { source_release_id: null, attempt_id: attemptId }
    : JSON.parse(readProtected(PREVIEW_PLAN, 64 * 1024))
  if (!planning) verifySignedBridge255PreviewPlan(plan, publicPem, keyId)
  const source = JSON.parse(readProtected(SOURCE_PLAN, 64 * 1024))
  const sourceReleaseId = source?.freeze?.public_route?.release_id
  check(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(sourceReleaseId ?? ''),
    'SOURCE_RELEASE_INVALID')
  validateBridge255IsolatedPaths(options, planning
    ? { ...plan, source_release_id: sourceReleaseId } : plan)
  const backupPath = options['--backup']
  for (const path of [backupPath, options['--attestation'], options['--capture'],
    options['--migration-255']]) protectedPath(path)
  protectedPath(dirname(backupPath), 'directory')
  protectedPath(dirname(options['--migration-255']), 'directory')
  const attestation = JSON.parse(readProtected(options['--attestation'], 64 * 1024))
  const manifest = JSON.parse(readProtected(options['--capture'], 64 * 1024))
  const sql = readProtected(options['--migration-255'], 4 * 1024 * 1024)
  const imageId = planning ? options['--pg17-image-id'] : plan.pg17_image_id
  const imageResult = spawnSync('/usr/bin/docker',
    ['image', 'inspect', imageId], { encoding: 'utf8', timeout: 30_000,
      maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent',
        DOCKER_HOST: 'unix:///var/run/docker.sock' } })
  check(!imageResult.error && imageResult.status === 0, 'PINNED_PG17_IMAGE_NOT_LOCAL')
  const image = JSON.parse(imageResult.stdout || 'null')
  check(image?.[0]?.Id === imageId, 'PINNED_PG17_IMAGE_NOT_LOCAL')
  const privatePem = readProtected(PRIVATE, 8192).toString()
  if (planning) {
    const createdAt = new Date(options['--created-at'])
    check(createdAt.toISOString() === options['--created-at']
      && createdAt.getTime() <= Date.now() + 300_000
      && createdAt.getTime() >= Date.now() - 3_600_000,
    'CREATED_AT_NOT_FRESH')
    const previewPlan = createSignedBridge255PreviewPlan({ attemptId, signedSourcePlan: source,
      manifest, attestation, backupPath, migration255Sql: sql, pg17ImageId: imageId,
      publicPem, privatePem, keyId, now: createdAt })
    const planSha = sha(Buffer.from(JSON.stringify(previewPlan)))
    if (parsed.mode === 'inspect') {
      process.stdout.write(`${JSON.stringify({ status: 'review_only', plan_sha256: planSha,
        source_release_id: previewPlan.source_release_id,
        production_deploy_authorized: false, database_mutations: false })}\n`)
      return
    }
    check(planSha === options['--approved-plan-sha256'], 'APPROVED_PLAN_DIGEST_MISMATCH')
    const fd = openSync(PREVIEW_PLAN, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444)
    try { writeFileSync(fd, `${JSON.stringify(previewPlan)}\n`); fsyncSync(fd) }
    finally { closeSync(fd) }
    process.stdout.write(`${JSON.stringify({ plan_sha256: planSha,
      production_deploy_authorized: false, database_mutations: false })}\n`)
    return
  }
  const result = await runSignedBridge255Preview({ plan, signedSourcePlan: source,
    manifest, attestation, backupPath, migration255Sql: sql,
    publicPem, privatePem, keyId }, createIsolatedPg17DockerPorts())
  const output = options['--output']
  const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`); fsyncSync(fd) }
  finally { closeSync(fd) }
  process.stdout.write(`isolated 254→255 restore evidence: ${output}\n`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`isolated 254→255 restore rejected: ${error.message}\n`)
    process.exitCode = 1
  })
}
