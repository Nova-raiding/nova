#!/usr/bin/env node
// Root-only, digest-pinned control. It captures a real isolated restore; it does
// not issue production restore evidence or touch the live database.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { constants, closeSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKUP_ROOT = '/var/lib/merchant-release-security/backups'
const RESTORE_ROOT = '/var/lib/merchant-release-security/preview-restores'
const TRUST_ROOT = '/run/release-security/evidence-trust'
const INSTALLED = '/usr/local/libexec/merchant/restore-pg17-isolated'
const DIGEST_FILE = join(TRUST_ROOT, 'production-pg17-restore-runner-sha256')
const DOCKER = '/usr/bin/docker'
const HEX = /^[a-f0-9]{64}$/u
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u
const RELEASE = /^[A-Za-z0-9._:-]{1,128}$/u
const GIT = /^[a-f0-9]{40}$/u
const EXPECTED_IMAGES = ['clamav', 'merchant-api', 'merchant-ops-ui', 'merchant-ui', 'merchant-worker', 'payment-gateway', 'pilot-gateway', 'postgres-migration']
const sha = value => createHash('sha256').update(value).digest('hex')
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function readRegular(path, max = 16 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const st = fstatSync(fd); requireValue(st.isFile() && st.size > 0 && st.size <= max, 'unsafe input file'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
function protectedPath(path, kind = 'file') {
  requireValue(path === resolve(path) && realpathSync(path) === path, 'protected path must be canonical and absolute')
  let cursor = path
  for (;;) {
    const st = lstatSync(cursor)
    requireValue(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'untrusted protected path ownership or mode')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
  const st = statSync(path)
  requireValue(kind === 'directory' ? st.isDirectory() : st.isFile(), 'protected path has wrong type')
}
function within(path, root) {
  requireValue(path === resolve(path) && path.startsWith(`${root}${sep}`) && !path.split(sep).includes('..'), 'path escapes protected root')
  protectedPath(path)
}
function exactArgs(args) {
  const keys = ['--backup', '--attestation', '--candidate-root', '--eight-image-set', '--image-digests', '--rendered-compose', '--release-id', '--git-sha', '--image-set-digest', '--manifest-sha256', '--deployment-nonce']
  requireValue(args.length === keys.length * 2, 'exact restore arguments required')
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    requireValue(keys.includes(args[index]) && !Object.hasOwn(parsed, args[index]) && args[index + 1], 'unknown or duplicate restore argument')
    parsed[args[index]] = args[index + 1]
  }
  requireValue(keys.every(key => parsed[key]), 'missing restore argument')
  return parsed
}
export function validateRestoreInputs({ backupSha256, backupName, attestation, publicPem, keyId, identity, imageSet, releaseId, gitSha, imageSetDigest, manifestSha256, deploymentNonce, now = new Date() }) {
  requireValue(RELEASE.test(releaseId) && GIT.test(gitSha) && /^sha256:[a-f0-9]{64}$/u.test(imageSetDigest) && HEX.test(manifestSha256) && /^[A-Za-z0-9_-]{22,128}$/u.test(deploymentNonce), 'release binding is invalid')
  requireValue(HEX.test(backupSha256 ?? ''), 'backup checksum is invalid')
  requireValue(attestation?.schema_version === '2' && attestation.kind === 'postgres_backup' && attestation.environment === 'production' && attestation.simulated === false, 'strict restore requires a signed v2 backup attestation')
  requireValue(attestation.backup_file_name === backupName && attestation.backup_sha256 === backupSha256 && attestation.migration_version === 242, 'signed backup does not identify a verified 242 snapshot')
  requireValue(HEX.test(attestation.source_database_id_sha256 ?? '') && attestation.key_id === keyId, 'backup source/key identity is invalid')
  requireValue(Number.isInteger(attestation.source_database_oid) && attestation.source_database_oid > 0 && attestation.source_database_oid <= 4_294_967_295 && typeof attestation.source_database_name === 'string' && attestation.source_database_name.length > 0 && Buffer.byteLength(attestation.source_database_name, 'utf8') <= 63 && !attestation.source_database_name.includes('\0'), 'backup source database metadata is invalid')
  requireValue(/^[A-Za-z0-9._:-]{1,128}$/u.test(keyId), 'trusted key ID is invalid')
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
  const started = Date.parse(attestation.backup_started_at ?? ''), observed = Date.parse(attestation.snapshot_export_observed_at ?? ''), completed = Date.parse(attestation.dump_completed_at ?? ''), expires = Date.parse(attestation.expires_at ?? '')
  requireValue(['backup_started_at', 'snapshot_export_observed_at', 'dump_completed_at', 'created_at', 'expires_at'].every(field => utc.test(attestation[field] ?? '') && Number.isFinite(Date.parse(attestation[field]))), 'v2 backup timestamps must be strict UTC')
  requireValue(HEX.test(attestation.snapshot_id_sha256 ?? ''), 'v2 snapshot_id_sha256 is invalid')
  requireValue(attestation.created_at === attestation.backup_started_at && started <= observed && observed <= completed && completed <= now.getTime() + 300_000 && expires > now.getTime() && expires > completed && expires <= completed + 24 * 60 * 60_000, 'v2 backup snapshot chronology or validity is invalid')
  requireValue(/^[A-Za-z0-9+/]{86}==$/u.test(attestation.signature_base64 ?? ''), 'backup signature is malformed')
  const key = createPublicKey(publicPem)
  requireValue(key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(attestation)), key, Buffer.from(attestation.signature_base64, 'base64')), 'backup signature is invalid')
  requireValue(identity.release_id === releaseId && identity.git_sha === gitSha && /^sha256:[a-f0-9]{64}$/u.test(identity.source_sha256 ?? ''), 'staged candidate identity mismatch')
  requireValue(imageSet.schema_version === 1 && imageSet.release_id === releaseId && imageSet.release_git_sha === gitSha && imageSet.source_sha256 === identity.source_sha256, 'eight-image set identity mismatch')
  const digests = imageSet.image_digests, references = imageSet.image_references
  requireValue(Object.keys(digests ?? {}).sort().join(',') === EXPECTED_IMAGES.join(',') && Object.keys(references ?? {}).sort().join(',') === EXPECTED_IMAGES.join(','), 'eight-image inventory is incomplete')
  for (const name of EXPECTED_IMAGES) requireValue(/^sha256:[a-f0-9]{64}$/u.test(digests[name]) && IMAGE.test(references[name]) && references[name].endsWith(`@${digests[name]}`), `invalid immutable image: ${name}`)
  requireValue(/(?:^|\/)postgres:17-alpine@sha256:[a-f0-9]{64}$/u.test(references['postgres-migration']), 'migration image must be pinned PostgreSQL 17 alpine')
  const canonicalImages = EXPECTED_IMAGES.map(name => `${name}=${digests[name]}\n`).join('')
  requireValue(imageSetDigest === `sha256:${sha(canonicalImages)}`, 'canonical eight-image digest mismatch')
  return { backupSha256: attestation.backup_sha256, sourceDatabaseIdSha256: attestation.source_database_id_sha256, postgresImage: references['postgres-migration'] }
}
export function validateArchiveCommit(actual, expected) { requireValue(GIT.test(actual ?? '') && actual === expected, 'candidate archive embedded Git commit does not match staged identity') }
export function retainedNonceBinding(nonce) { requireValue(/^[A-Za-z0-9_-]{22,128}$/u.test(nonce ?? ''), 'deployment nonce is invalid'); return { deployment_nonce_sha256: sha(nonce) } }
export function composeDigestArgument(digestFile, imageDigests) {
  requireValue(digestFile && typeof digestFile === 'object' && !Array.isArray(digestFile) && imageDigests && typeof imageDigests === 'object' && !Array.isArray(imageDigests), 'eight-image digest sidecar is invalid')
  const keys = Object.keys(digestFile).sort()
  requireValue(keys.length === EXPECTED_IMAGES.length && keys.join(',') === EXPECTED_IMAGES.join(',') && keys.every(key => digestFile[key] === imageDigests[key]), 'eight-image digest sidecar mismatch')
  return JSON.stringify(digestFile)
}
export function postgresContainerArgs({ containerName, network, volume, image }) {
  return ['run', '-d', '--name', containerName, '--network', network, '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=merchant', image]
}
export function migrationContainerArgs({ migrationName, containerName, network, migrations, script, image }) {
  return ['run', '--rm', '--name', migrationName, '--network', network, '--env', `PGHOST=${containerName}`, '--env', 'PGPORT=5432', '--env', 'PGDATABASE=merchant', '--env', 'PGUSER=postgres', '--env', 'PGPASSWORD', '--mount', `type=bind,source=${migrations},target=/migrations,readonly`, '--mount', `type=bind,source=${script},target=/ops/apply-migrations.sh,readonly`, '--entrypoint', '/bin/sh', image, '/ops/apply-migrations.sh']
}
export function readArchiveCommit(path) {
  const header = Buffer.alloc(4096)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try { bytes = readSync(fd, header, 0, header.length, 0) } finally { closeSync(fd) }
  requireValue(bytes >= 1024, 'candidate source archive header is incomplete')
  const result = spawnSync('/usr/bin/git', ['get-tar-commit-id'], { input: header.subarray(0, bytes), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } })
  requireValue(!result.error && result.status === 0 && GIT.test(result.stdout.trim()), 'candidate archive has no embedded Git commit')
  return result.stdout.trim()
}
function lines(text) { return Object.fromEntries(text.trim().split('\n').map(line => { const at = line.indexOf('='); requireValue(at > 0, 'candidate identity malformed'); return [line.slice(0, at), line.slice(at + 1)] })) }
export function validateMigrationAssets(names) {
  requireValue(Array.isArray(names) && names.length === 245, 'candidate migration chain must contain exactly 245 SQL files')
  const ordered = [...names].sort()
  for (let index = 0; index < ordered.length; index++) requireValue(new RegExp(`^${String(index + 1).padStart(3, '0')}_[a-z0-9][a-z0-9_]*\\.sql$`, 'u').test(ordered[index]), 'candidate migration chain has a gap or unsafe filename')
  requireValue(ordered[242] === '243_local_plugin_connection_requests.sql' && ordered[243] === '244_local_plugin_install_instances.sql' && ordered[244] === '245_local_plugin_authorized_timestamp.sql', 'candidate 243/244/245 migration identity mismatch')
}
async function hashFile(path, maxBytes) {
  const st = statSync(path); requireValue(st.size > 0 && st.size <= maxBytes, 'input size is invalid')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { flags: 'r' })) digest.update(chunk)
  return digest.digest('hex')
}
function dockerStream(args, file, timeout = 3_600_000) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(DOCKER, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
    const source = createReadStream(file, { flags: 'r' })
    let output = '', bytes = 0, settled = false
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) { source.destroy(); child.kill('SIGTERM'); rejectCommand(error) } else resolveCommand(output.trim()) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('isolated Docker operation timed out')) }, timeout)
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { child.kill('SIGKILL'); finish(new Error('Docker output exceeded limit')) } else output += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { child.kill('SIGKILL'); finish(new Error('Docker diagnostics exceeded limit')) } })
    child.on('error', finish)
    child.stdin.on('error', finish)
    child.on('close', code => finish(code === 0 ? null : new Error(`isolated Docker operation failed: ${args[0]}`)))
    source.on('error', finish); source.pipe(child.stdin)
  })
}
function docker(args, input, timeout = 120_000, isolatedEnvironment = {}) {
  const result = spawnSync(DOCKER, args, { input, encoding: input ? undefined : 'utf8', timeout, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock', ...isolatedEnvironment } })
  requireValue(!result.error && result.status === 0, `isolated Docker operation failed: ${args[0]}`)
  return String(result.stdout ?? '').trim()
}
function query(container, sql) {
  const output = docker(['exec', '-u', 'postgres', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'merchant', '-c', sql])
  requireValue(!output.includes('\n') && output.length <= 256, 'database probe returned unexpected output')
  return output
}
export function validateContainerInspection(value, { id, expectedImageId, expectedNetwork, expectedVolume }) {
  requireValue(value?.Id === id && value.Image === expectedImageId && value.State?.Running === true, 'isolated container/image identity mismatch')
  requireValue(value.HostConfig?.NetworkMode === expectedNetwork && Object.keys(value.NetworkSettings?.Networks ?? {}).join(',') === expectedNetwork, 'restore container escaped its internal network')
  requireValue(Object.keys(value.HostConfig?.PortBindings ?? {}).length === 0 && Object.values(value.NetworkSettings?.Ports ?? {}).every(item => item === null), 'restore container published a port')
  requireValue(value.Mounts?.length === 1 && value.Mounts[0].Type === 'volume' && value.Mounts[0].Name === expectedVolume, 'restore container mounted an unapproved volume')
  return value
}
function inspectContainer(id, expectedImageId, expectedNetwork, expectedVolume) {
  return validateContainerInspection(JSON.parse(docker(['inspect', id]))[0], { id, expectedImageId, expectedNetwork, expectedVolume })
}
function record(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) }
async function main(args) {
  requireValue(process.getuid?.() === 0 && process.geteuid?.() === 0, 'protected restore requires root')
  requireValue(realpathSync(process.argv[1]) === INSTALLED, 'restore runner must use fixed installed executable')
  for (const path of [INSTALLED, DIGEST_FILE, DOCKER]) protectedPath(path)
  requireValue(sha(readRegular(INSTALLED, 4 * 1024 * 1024)) === readRegular(DIGEST_FILE, 128).toString().trim(), 'installed restore runner digest mismatch')
  const options = exactArgs(args)
  const backupPath = options['--backup'], attestationPath = options['--attestation'], root = options['--candidate-root']
  within(backupPath, BACKUP_ROOT); within(attestationPath, BACKUP_ROOT)
  requireValue(dirname(backupPath) === dirname(attestationPath) && basename(dirname(backupPath)).startsWith(`${options['--release-id']}-attempt-`), 'backup attempt is not release-scoped')
  protectedPath(root, 'directory'); protectedPath(RESTORE_ROOT, 'directory'); protectedPath(TRUST_ROOT, 'directory')
  for (const name of ['.candidate-identity', '.candidate-source.tar']) protectedPath(join(root, name))
  protectedPath(options['--eight-image-set']); protectedPath(options['--image-digests']); protectedPath(options['--rendered-compose'])
  const identity = lines(readRegular(join(root, '.candidate-identity'), 1024).toString())
  requireValue(await hashFile(join(root, '.candidate-source.tar'), 4 * 1024 * 1024 * 1024) === identity.source_sha256?.slice(7), 'staged source archive changed')
  protectedPath('/usr/bin/git')
  validateArchiveCommit(readArchiveCommit(join(root, '.candidate-source.tar')), identity.git_sha)
  const imageSet = JSON.parse(readRegular(options['--eight-image-set'], 16 * 1024).toString())
  const digestFile = JSON.parse(readRegular(options['--image-digests'], 16 * 1024).toString())
  const digestJson = composeDigestArgument(digestFile, imageSet.image_digests)
  for (const path of [join(TRUST_ROOT, 'production-evidence-public.pem'), join(TRUST_ROOT, 'production-evidence-key-id')]) protectedPath(path)
  const attestation = JSON.parse(readRegular(attestationPath, 32 * 1024).toString())
  const backupSha256 = await hashFile(backupPath, 16 * 1024 * 1024 * 1024)
  const binding = validateRestoreInputs({ backupSha256, backupName: basename(backupPath), attestation, publicPem: readRegular(join(TRUST_ROOT, 'production-evidence-public.pem'), 8192), keyId: readRegular(join(TRUST_ROOT, 'production-evidence-key-id'), 128).toString().trim(), identity, imageSet, releaseId: options['--release-id'], gitSha: options['--git-sha'], imageSetDigest: options['--image-set-digest'], manifestSha256: options['--manifest-sha256'], deploymentNonce: options['--deployment-nonce'] })
  const nonce = randomBytes(12).toString('hex'), containerName = `merchant_restore_${nonce}`, migrationName = `merchant_restore_migrate_${nonce}`, network = `merchant_restore_net_${nonce}`, volume = `merchant_restore_data_${nonce}`
  const output = join(RESTORE_ROOT, `${options['--release-id']}-${nonce}.json`)
  const extraction = join(RESTORE_ROOT, `${options['--release-id']}-${nonce}-source`)
  mkdirSync(extraction, { mode: 0o700 })
  const tar = spawnSync('/usr/bin/tar', ['--no-same-owner', '--no-same-permissions', '-xf', join(root, '.candidate-source.tar'), '-C', extraction, 'packages/persistence/src/migrations', 'infra/scripts/apply-migrations.sh', 'infra/scripts/validate-ecs-compose-release.rb'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } })
  requireValue(!tar.error && tar.status === 0, 'candidate migration assets could not be extracted from verified archive')
  requireValue(await hashFile(join(root, '.candidate-source.tar'), 4 * 1024 * 1024 * 1024) === identity.source_sha256.slice(7), 'staged source archive changed during extraction')
  const migrations = join(extraction, 'packages/persistence/src/migrations'), script = join(extraction, 'infra/scripts/apply-migrations.sh')
  protectedPath(migrations, 'directory'); protectedPath(script)
  const migrationNames = readdirSync(migrations)
  validateMigrationAssets(migrationNames)
  for (const name of migrationNames) protectedPath(join(migrations, name))
  const composeGate = join(extraction, 'infra/scripts/validate-ecs-compose-release.rb')
  protectedPath(composeGate); protectedPath('/usr/bin/ruby'); protectedPath('/usr/bin/tar')
  for (const [mode, expected] of [['--print-image-set-digest', options['--image-set-digest']], ['--print-manifest-sha256', options['--manifest-sha256']]]) {
    const result = spawnSync('/usr/bin/ruby', [composeGate, options['--rendered-compose'], digestJson, mode], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } })
    requireValue(!result.error && result.status === 0 && result.stdout.trim() === expected, `rendered Compose ${mode} does not match frozen release`)
  }
  const imageId = JSON.parse(docker(['image', 'inspect', binding.postgresImage]))[0]?.Id
  requireValue(/^sha256:[a-f0-9]{64}$/u.test(imageId ?? ''), 'PostgreSQL 17 image is missing')
  const isolatedPassword = randomBytes(48).toString('base64url')
  let containerId
  let networkId
  try {
  networkId = docker(['network', 'create', '--internal', network])
  requireValue(/^[a-f0-9]{64}$/u.test(networkId), 'internal network identity invalid')
  const volumeName = docker(['volume', 'create', volume]); requireValue(volumeName === volume, 'isolated volume identity mismatch')
  containerId = docker(postgresContainerArgs({ containerName, network, volume, image: binding.postgresImage }), undefined, 120_000, { POSTGRES_PASSWORD: isolatedPassword })
  requireValue(/^[a-f0-9]{64}$/u.test(containerId), 'isolated container ID invalid')
  const networkState = JSON.parse(docker(['network', 'inspect', network]))[0]
  requireValue(networkState?.Id === networkId && networkState.Internal === true, 'restore network is not internal')
  inspectContainer(containerId, imageId, network, volume)
  for (let attempt = 0; attempt < 60; attempt++) { try { docker(['exec', '-u', 'postgres', containerId, 'pg_isready', '-U', 'postgres', '-d', 'merchant'], undefined, 10_000); break } catch { if (attempt === 59) throw new Error('isolated database did not become ready'); await new Promise(done => setTimeout(done, 1000)) } }
  requireValue(/^17\d{4}$/u.test(query(containerId, 'show server_version_num')), 'isolated database is not PostgreSQL 17')
  docker(['exec', '-i', '-u', 'postgres', containerId, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'merchant'], Buffer.from("CREATE ROLE merchant_app LOGIN; CREATE ROLE merchant_ops LOGIN;"))
  await dockerStream(['exec', '-i', '-u', 'postgres', containerId, 'pg_restore', '-U', 'postgres', '-d', 'merchant', '--exit-on-error', '--no-owner', '--no-privileges'], backupPath)
  requireValue(await hashFile(backupPath, 16 * 1024 * 1024 * 1024) === backupSha256, 'backup changed during isolated restore')
  const dbIdentity = query(containerId, 'select system_identifier from pg_control_system()')
  requireValue(/^\d{1,32}$/u.test(dbIdentity) && sha(dbIdentity) !== binding.sourceDatabaseIdSha256, 'restore target is not an isolated database identity')
  const before = query(containerId, "select min(version)||':'||max(version)||':'||count(*) from public.schema_migrations")
  requireValue(before === '1:242:242', 'restored migration history is not the complete 242 prefix')
  const migrationContainer = docker(migrationContainerArgs({ migrationName, containerName, network, migrations, script, image: binding.postgresImage }), undefined, 3_600_000, { PGPASSWORD: isolatedPassword })
  requireValue(migrationContainer.length < 64 * 1024, 'migration diagnostics exceeded limit')
  const after = query(containerId, "select min(version)||':'||max(version)||':'||count(*) from public.schema_migrations")
  requireValue(after === '1:245:245', 'candidate migrations did not end at complete 245 prefix')
  const migrationRows = docker(['exec', '-u', 'postgres', containerId, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'merchant', '-c', 'select version, name, checksum from public.schema_migrations order by version'])
  requireValue(migrationRows.split('\n').length === 245, 'migration chain row count changed')
  for (const [version, name] of [[243, 'local_plugin_connection_requests'], [244, 'local_plugin_install_instances'], [245, 'local_plugin_authorized_timestamp']]) {
    const fileName = readRegular(join(migrations, `${version}_${name}.sql`), 4 * 1024 * 1024)
    requireValue(migrationRows.split('\n')[version - 1]?.split('|')[2] === sha(fileName), `migration ${version} checksum mismatch`)
  }
  inspectContainer(containerId, imageId, network, volume)
  record(output, { schema_version: 'pg17-isolated-restore-capture/1', status: 'pass', simulated: false, release_id: options['--release-id'], release_git_sha: options['--git-sha'], image_set_digest: options['--image-set-digest'], manifest_sha256: options['--manifest-sha256'], ...retainedNonceBinding(options['--deployment-nonce']), source_archive_sha256: identity.source_sha256, migration_script_sha256: sha(readRegular(script, 256 * 1024)), backup_sha256: binding.backupSha256, source_database_id_sha256: binding.sourceDatabaseIdSha256, target_database_id_sha256: sha(dbIdentity), postgres_image_ref: binding.postgresImage, postgres_image_id: imageId, network_id: networkId, container_id: containerId, volume_name: volume, restored_migration_prefix: before, migrated_prefix: after, migration_chain_sha256: sha(migrationRows), migration_chain_rows: migrationRows.split('\n'), migration_command_output_sha256: sha(migrationContainer), captured_at: new Date().toISOString() })
  process.stdout.write(`PG17 isolated restore captured: ${output}\n`)
  } catch (error) {
    try { docker(['rm', '-f', migrationName], undefined, 10_000) } catch {}
    if (containerId && /^[a-f0-9]{64}$/u.test(containerId)) {
      try { docker(['stop', '--time', '3', containerId], undefined, 10_000) } catch {}
      try { docker(['rm', containerId], undefined, 10_000) } catch {}
    }
    if (networkId && /^[a-f0-9]{64}$/u.test(networkId)) { try { docker(['network', 'rm', networkId], undefined, 10_000) } catch {} }
    try { record(output, { schema_version: 'pg17-isolated-restore-capture/1', status: 'fail', release_id: options['--release-id'], backup_sha256: binding.backupSha256, network_id: networkId ?? null, container_id: containerId ?? null, volume_name: volume, captured_at: new Date().toISOString() }) } catch {}
    throw error
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2)).catch(error => { process.stderr.write(`PG17 isolated restore rejected: ${error.message}\n`); process.exitCode = 1 })
