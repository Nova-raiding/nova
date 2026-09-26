#!/usr/bin/env node
// Read-only topology/configuration preflight. Its optional worker probe uses a
// separate no-dispatch image entrypoint; this never issues restore evidence.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX = /^[a-f0-9]{64}$/u
const RELEASE = /^[A-Za-z0-9._:-]{1,128}$/u
const IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u
const WORKSPACE = /^[A-Za-z0-9._:-]{1,128}$/u
const RESTORE_ROOT = '/var/lib/merchant-release-security/preview-restores'
const RELEASE_IMAGE_ARTIFACTS = Object.freeze(['clamav', 'merchant-api', 'merchant-ops-ui', 'merchant-ui', 'merchant-worker', 'payment-gateway', 'pilot-gateway', 'postgres-migration'])
const requireValue = (ok, message) => { if (!ok) throw new Error(message) }
function protectedFile(path) {
  requireValue(path === resolve(path) && realpathSync(path) === path, 'input must be a canonical absolute file')
  let parent = dirname(path)
  while (parent !== '/') {
    const st = lstatSync(parent)
    requireValue(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0, 'input parent is not root protected')
    parent = dirname(parent)
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    requireValue(st.isFile() && st.uid === 0 && (st.mode & 0o777) === 0o600 && st.size > 0 && st.size <= 1024 * 1024, 'input must be root-owned regular mode 0600 and bounded')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function protectedDirectory(path) {
  requireValue(path === resolve(path) && realpathSync(path) === path, 'output root must be a canonical protected directory')
  let cursor = path
  while (cursor !== '/') {
    const stat = lstatSync(cursor)
    requireValue(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'output directory chain is not root protected')
    cursor = dirname(cursor)
  }
}
export function parseSmokeEnv(source) {
  const values = {}
  for (const line of source.split(/\r?\n/u)) {
    if (!line) continue
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/u.exec(line)
    requireValue(match && !Object.hasOwn(values, match[1]) && !/[`$]/u.test(match[2]), 'unsafe or duplicate smoke environment entry')
    values[match[1]] = match[2]
  }
  return values
}
function host(url, schemes, user, database) {
  try {
    const parsed = new URL(url)
    requireValue(schemes.includes(parsed.protocol) && parsed.username === user && Boolean(parsed.password) && parsed.pathname === `/${database}` && !parsed.search && !parsed.hash && !parsed.port, 'isolated service URL is invalid')
    return parsed.hostname
  } catch { throw new Error('isolated service URL is invalid') }
}
export function validatePg17SmokeTopology({ capture, network, postgres, redis, images, apiEnv, workerEnv, roles }) {
  const errors = []
  const check = (condition, message) => { if (!condition) errors.push(message) }
  check(capture?.schema_version === 'pg17-isolated-restore-capture/2' && capture.status === 'pass' && capture.simulated === false && RELEASE.test(capture.release_id ?? '') && /^[a-f0-9]{40}$/u.test(capture.release_git_sha ?? '') && /^sha256:[a-f0-9]{64}$/u.test(capture.image_set_digest ?? '') && HEX.test(capture.manifest_sha256 ?? '') && HEX.test(capture.deployment_nonce_sha256 ?? '') && HEX.test(capture.backup_sha256 ?? '') && HEX.test(capture.source_database_id_sha256 ?? '') && HEX.test(capture.target_database_id_sha256 ?? '') && capture.source_database_id_sha256 !== capture.target_database_id_sha256 && HEX.test(capture.network_id ?? '') && HEX.test(capture.container_id ?? ''), 'valid protected PG17 v2 capture required')
  check(Number.isSafeInteger(capture?.migration_target_version) && capture.migration_target_version >= 242 && capture.restored_migration_prefix === '1:242:242' && capture.migrated_prefix === `1:${capture.migration_target_version}:${capture.migration_target_version}` && HEX.test(capture.migration_chain_sha256 ?? ''), 'restore capture migration binding invalid')
  check(Array.isArray(capture?.migration_chain_rows) && capture.migration_chain_rows.length === capture.migration_target_version && capture.migration_chain_rows.every((row, index) => typeof row === 'string' && row.startsWith(`${index + 1}|`)) && createHash('sha256').update(capture.migration_chain_rows.join('\n')).digest('hex') === capture.migration_chain_sha256, 'restore capture migration chain invalid')
  check(network?.Id === capture?.network_id && network?.Internal === true && network?.Ingress !== true && network?.Driver === 'bridge', 'restore network must be exact internal bridge')
  check(postgres?.Id === capture?.container_id && postgres?.State?.Running === true && postgres?.HostConfig?.NetworkMode === network?.Name && postgres?.Image === capture?.postgres_image_id, 'restore Postgres identity/network mismatch')
  check(isOnlyAttachedNetwork(postgres, network), 'restore Postgres must attach only to the captured internal network ID')
  check(postgres?.Mounts?.length === 1 && postgres?.Mounts?.[0]?.Type === 'volume' && postgres?.Mounts?.[0]?.Name === capture?.volume_name, 'restore Postgres volume mismatch')
  check(Object.keys(postgres?.HostConfig?.PortBindings ?? {}).length === 0, 'restore Postgres publishes a port')
  check(HEX.test(redis?.Id ?? '') && redis?.State?.Running === true && redis?.HostConfig?.NetworkMode === network?.Name && redis?.Image === images?.redis_id, 'isolated Redis identity/network mismatch')
  check(isOnlyAttachedNetwork(redis, network), 'isolated Redis must attach only to the captured internal network ID')
  check(redis?.Mounts?.length === 0 && Object.keys(redis?.HostConfig?.PortBindings ?? {}).length === 0, 'isolated Redis has a mount or published port')
  for (const name of ['api', 'worker', 'redis']) check(IMAGE.test(images?.[name] ?? '') && /^sha256:[a-f0-9]{64}$/u.test(images?.[`${name}_id`] ?? ''), `${name} image must be immutable and inspected`)
  try { validateSmokeImageInventory(images, capture) } catch (error) { errors.push(error instanceof Error ? error.message : 'restore image inventory invalid') }
  const expectedPeers = [capture?.container_id, redis?.Id].filter(Boolean).sort()
  check(Object.keys(network?.Containers ?? {}).sort().join(',') === expectedPeers.join(','), 'restore network has unreviewed peers')
  check(Array.isArray(roles) && roles.length === 2 && roles.every(role => role?.rolcanlogin === true && role?.rolsuper === false && role?.rolcreatedb === false && role?.rolcreaterole === false && role?.rolbypassrls === false && role?.has_write_privilege === false && role?.default_read_only === true) && roles.map(role => role.name).sort().join(',') === 'restore_app,restore_ops', 'restore database roles are not proven read-only')
  const pgName = postgres?.Name?.replace(/^\//u, '')
  const redisName = redis?.Name?.replace(/^\//u, '')
  const targets = [
    [apiEnv?.DATABASE_URL, ['postgres:', 'postgresql:'], 'restore_app', 'merchant', pgName, 'API database does not target restore Postgres'],
    [apiEnv?.OPS_DATABASE_URL, ['postgres:', 'postgresql:'], 'restore_ops', 'merchant', pgName, 'ops database does not target restore Postgres'],
    [apiEnv?.REDIS_URL, ['redis:'], 'restore', '0', redisName, 'API Redis does not target isolated Redis'],
    [workerEnv?.DATABASE_URL, ['postgres:', 'postgresql:'], 'restore_app', 'merchant', pgName, 'worker database does not target restore Postgres'],
    [workerEnv?.REDIS_URL, ['redis:'], 'restore', '0', redisName, 'worker Redis does not target isolated Redis'],
  ]
  for (const [url, schemes, user, database, expected, message] of targets) {
    try { check(host(url, schemes, user, database) === expected, message) }
    catch { errors.push(message) }
  }
  const allowedApi = new Set(['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'DEPLOYMENT_PROFILE', 'RUN_MIGRATIONS_ON_STARTUP', 'CONNECTOR_FIXTURE_MODE', 'PAYMENT_RECONCILIATION_ENABLED', 'PAYMENT_REFUND_ENABLED', 'OPERATIONAL_ALERT_SWEEP_ENABLED', 'PORT'])
  const allowedWorker = new Set(['DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'RESTORE_SMOKE_MODE', 'RESTORE_SMOKE_WORKSPACE_ID'])
  check(Object.keys(apiEnv ?? {}).every(key => allowedApi.has(key)), 'API smoke environment contains unreviewed key or external integration')
  check(Object.keys(workerEnv ?? {}).every(key => allowedWorker.has(key)), 'worker smoke environment contains unreviewed key or external integration')
  check(apiEnv?.NODE_ENV === 'production' && apiEnv?.DEPLOYMENT_PROFILE === 'ecs' && apiEnv?.RUN_MIGRATIONS_ON_STARTUP === 'false' && apiEnv?.CONNECTOR_FIXTURE_MODE === 'false' && apiEnv?.PAYMENT_RECONCILIATION_ENABLED === 'false' && apiEnv?.PAYMENT_REFUND_ENABLED === 'false' && apiEnv?.OPERATIONAL_ALERT_SWEEP_ENABLED === 'false', 'API side-effect controls incomplete')
  check(workerEnv?.NODE_ENV === 'production' && workerEnv?.RESTORE_SMOKE_MODE === 'isolated_read_only' && WORKSPACE.test(workerEnv?.RESTORE_SMOKE_WORKSPACE_ID ?? ''), 'worker isolated read-only smoke configuration incomplete')
  return errors
}
function isOnlyAttachedNetwork(container, network) {
  const attached = container?.NetworkSettings?.Networks
  if (!attached || typeof attached !== 'object' || Array.isArray(attached)) return false
  const entries = Object.entries(attached)
  return entries.length === 1 && entries[0]?.[0] === network?.Name && entries[0]?.[1]?.NetworkID === network?.Id
}
export function validateSmokeImageInventory(images, capture) {
  requireValue(images?.schema_version === 'pg17-restore-image-inventory/1', 'protected candidate image inventory schema invalid')
  requireValue(images.release_id === capture.release_id && images.release_git_sha === capture.release_git_sha && images.image_set_digest === capture.image_set_digest && images.manifest_sha256 === capture.manifest_sha256, 'protected image inventory candidate identity mismatch')
  const digests = images.image_digests
  const references = images.image_references
  requireValue(digests && typeof digests === 'object' && !Array.isArray(digests) && Object.keys(digests).sort().join(',') === [...RELEASE_IMAGE_ARTIFACTS].sort().join(','), 'protected image inventory artifact set invalid')
  requireValue(references && typeof references === 'object' && !Array.isArray(references) && Object.keys(references).sort().join(',') === [...RELEASE_IMAGE_ARTIFACTS].sort().join(','), 'protected image inventory references invalid')
  for (const artifact of RELEASE_IMAGE_ARTIFACTS) {
    requireValue(/^sha256:[a-f0-9]{64}$/u.test(digests[artifact] ?? '') && IMAGE.test(references[artifact] ?? '') && references[artifact].endsWith(`@${digests[artifact]}`), `protected image inventory digest/ref mismatch: ${artifact}`)
  }
  const canonicalSet = RELEASE_IMAGE_ARTIFACTS.slice().sort().map(artifact => `${artifact}=${digests[artifact]}\n`).join('')
  requireValue(`sha256:${createHash('sha256').update(canonicalSet).digest('hex')}` === capture.image_set_digest, 'protected image inventory image-set digest mismatch')
  requireValue(images.worker === references['merchant-worker'] && images.api === references['merchant-api'], 'restore API/worker references do not match the candidate image inventory')
  requireValue(/^sha256:[a-f0-9]{64}$/u.test(images.worker_id ?? ''), 'candidate worker image ID invalid')
}
function dockerInspect(kind, id) {
  requireValue(HEX.test(id ?? ''), 'Docker identity invalid')
  const result = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', kind, 'inspect', id], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
  requireValue(!result.error && result.status === 0, 'read-only Docker inspection failed')
  return JSON.parse(result.stdout)[0]
}
export function validateWorkerRestoreSmokeResult(result, capture, workspaceId) {
  requireValue(result?.schema_version === 'pg17-worker-restore-smoke/1' && result.status === 'pass' && result.simulated === false && result.database_role === 'restore_app' && result.redis_ping === 'PONG', 'worker restore probe did not pass')
  requireValue(result.migration_target_version === capture.migration_target_version && result.migration_chain_sha256 === capture.migration_chain_sha256 && result.workspace_id_sha256 === createHash('sha256').update(workspaceId).digest('hex'), 'worker restore probe target mismatch')
  requireValue(typeof result.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.observed_at) && Number.isFinite(Date.parse(result.observed_at)) && Date.parse(result.observed_at) >= Date.parse(capture.captured_at) && Date.parse(result.observed_at) <= Date.now() + 300_000, 'worker restore probe observation time invalid')
}
function inspectWorkerImage(reference, expectedId, runner = spawnSync) {
  requireValue(IMAGE.test(reference) && /^sha256:[a-f0-9]{64}$/u.test(expectedId), 'worker image identity invalid')
  const result = runner('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', reference], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
  requireValue(!result.error && result.status === 0 && JSON.parse(result.stdout)[0]?.Id === expectedId, 'local worker image does not match reviewed digest')
}
export function ownsWorkerProbeContainer(container, { containerName, nonce, imageId, network }) {
  const attached = container?.NetworkSettings?.Networks
  return HEX.test(container?.Id ?? '') && container?.Name === `/${containerName}`
    && container?.Config?.Labels?.['merchant.restore.probe_nonce'] === nonce
    && container?.Image === imageId && container?.HostConfig?.NetworkMode === network?.Name
    && attached && typeof attached === 'object' && !Array.isArray(attached)
    && Object.keys(attached).length === 1 && attached[network.Name]?.NetworkID === network.Id
}
export function cleanupWorkerProbeContainer(containerName, ownership, runner = spawnSync) {
  requireValue(/^merchant_restore_worker_[a-f0-9]{24}$/u.test(containerName), 'worker probe cleanup requires its unique generated container name')
  requireValue(ownership?.nonce === containerName.slice('merchant_restore_worker_'.length) && /^sha256:[a-f0-9]{64}$/u.test(ownership?.imageId ?? '') && HEX.test(ownership?.network?.Id ?? ''), 'worker probe cleanup ownership binding invalid')
  const docker = args => runner('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
  const inspected = docker(['container', 'inspect', containerName])
  if (inspected.error) throw new Error('worker probe ownership inspection failed')
  if (inspected.status !== 0) {
    requireValue(/No such (object|container)/iu.test(inspected.stderr ?? ''), 'worker probe ownership inspection failed')
    return
  }
  let container
  try { container = JSON.parse(inspected.stdout)[0] } catch { throw new Error('worker probe ownership inspection invalid') }
  requireValue(ownsWorkerProbeContainer(container, { containerName, ...ownership }), 'worker probe container ownership mismatch; refusing cleanup')
  const removed = docker(['container', 'rm', '--force', container.Id])
  requireValue(!removed.error && removed.status === 0, 'owned worker probe container could not be removed')
  const verified = docker(['container', 'inspect', containerName])
  requireValue(!verified.error && verified.status !== 0 && /No such (object|container)/iu.test(verified.stderr ?? ''), 'isolated worker probe container cleanup could not be verified')
}
export function runWorkerProbe({ workerEnvPath, images, network, capture, workspaceId, runner = spawnSync }) {
  inspectWorkerImage(images.worker, images.worker_id, runner)
  const nonce = randomBytes(12).toString('hex')
  const containerName = `merchant_restore_worker_${nonce}`
  const args = [
    '--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--pull=never',
    '--name', containerName,
    '--label', `merchant.restore.probe_nonce=${nonce}`,
    '--network', network.Name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=64', '--memory=256m', '--user=10001:10001', '--env-file', workerEnvPath,
    '--env', `RESTORE_SMOKE_EXPECTED_MIGRATION_VERSION=${capture.migration_target_version}`,
    '--env', `RESTORE_SMOKE_MIGRATION_CHAIN_SHA256=${capture.migration_chain_sha256}`,
    '--entrypoint', 'node', images.worker, 'dist/apps/worker/src/restore-smoke.js',
  ]
  let observation, failure
  try {
    const result = runner('/usr/bin/docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
    requireValue(!result.error && result.status === 0 && result.stdout.trim().split('\n').length === 1, 'isolated worker restore probe failed')
    observation = JSON.parse(result.stdout.trim())
    validateWorkerRestoreSmokeResult(observation, capture, workspaceId)
  } catch (error) { failure = error }
  try { cleanupWorkerProbeContainer(containerName, { nonce, imageId: images.worker_id, network }, runner) }
  catch (error) { throw new Error(`isolated worker restore probe cleanup failed: ${error instanceof Error ? error.message : String(error)}`) }
  if (failure) throw failure
  return { observation, containerName }
}
export function validatePostProbeTopology(input, after, workerGone) {
  const errors = validatePg17SmokeTopology({ ...input, network: after.network, postgres: after.postgres, redis: after.redis })
  if (after.network?.Id !== input.network?.Id || after.postgres?.Id !== input.postgres?.Id || after.redis?.Id !== input.redis?.Id) errors.push('isolated resource identity changed during worker probe')
  if (!workerGone) errors.push('isolated worker probe container was not removed')
  return errors
}
function verifyPostProbeTopology({ capture, images, apiEnv, workerEnv, roles, redisId, containerName, before }) {
  const network = dockerInspect('network', capture.network_id)
  const postgres = dockerInspect('container', capture.container_id)
  const redis = dockerInspect('container', redisId)
  inspectWorkerImage(images.worker, images.worker_id)
  const gone = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'container', 'inspect', containerName], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
  const workerGone = !gone.error && gone.status !== 0 && /No such (object|container)/iu.test(gone.stderr)
  requireValue(validatePostProbeTopology({ capture, ...before, images, apiEnv, workerEnv, roles }, { network, postgres, redis }, workerGone).length === 0, 'isolated topology changed or worker probe container remained')
  return { network, postgres, redis }
}
function main(args) {
  const names = ['--capture', '--api-env', '--worker-env', '--redis-id', '--images', '--roles', '--worker-output']
  requireValue(args.length === names.length * 2, 'exact preflight arguments required')
  const inputs = {}
  for (let i = 0; i < args.length; i += 2) { requireValue(names.includes(args[i]) && !Object.hasOwn(inputs, args[i]) && args[i + 1], 'unknown or duplicate argument'); inputs[args[i]] = args[i + 1] }
  requireValue(names.every(name => inputs[name]), 'missing preflight argument')
  const capture = JSON.parse(protectedFile(inputs['--capture']).toString())
  const imageInventoryBytes = protectedFile(inputs['--images'])
  const images = JSON.parse(imageInventoryBytes.toString())
  const roles = JSON.parse(protectedFile(inputs['--roles']).toString())
  const apiEnv = parseSmokeEnv(protectedFile(inputs['--api-env']).toString())
  const workerEnv = parseSmokeEnv(protectedFile(inputs['--worker-env']).toString())
  const network = dockerInspect('network', capture.network_id)
  const postgres = dockerInspect('container', capture.container_id)
  const redis = dockerInspect('container', inputs['--redis-id'])
  const errors = validatePg17SmokeTopology({ capture, network, postgres, redis, images, apiEnv, workerEnv, roles })
  requireValue(errors.length === 0, errors.join('; '))
  const output = inputs['--worker-output']
  requireValue(output === resolve(output) && dirname(output) === RESTORE_ROOT, 'worker output must be in protected restore root')
  protectedDirectory(RESTORE_ROOT)
  try { lstatSync(output); throw new Error('worker output already exists') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  const probe = runWorkerProbe({ workerEnvPath: inputs['--worker-env'], images, network, capture, workspaceId: workerEnv.RESTORE_SMOKE_WORKSPACE_ID })
  const after = verifyPostProbeTopology({ capture, images, apiEnv, workerEnv, roles, redisId: inputs['--redis-id'], containerName: probe.containerName, before: { network, postgres, redis } })
  writeFileSync(output, `${JSON.stringify({ schema_version: 'pg17-worker-restore-capture/1', status: 'incomplete', final_production_evidence: false, release_id: capture.release_id, release_git_sha: capture.release_git_sha, image_set_digest: capture.image_set_digest, manifest_sha256: capture.manifest_sha256, deployment_nonce_sha256: capture.deployment_nonce_sha256, restore_capture_sha256: createHash('sha256').update(protectedFile(inputs['--capture'])).digest('hex'), image_inventory_sha256: createHash('sha256').update(imageInventoryBytes).digest('hex'), restore_container_id: after.postgres.Id, redis_container_id: after.redis.Id, network_id: after.network.Id, worker_image_reference: images.worker, worker_image_id: images.worker_id, worker_container_name: probe.containerName, worker_probe: probe.observation, captured_at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  // The worker probe is only one raw application observation. API, Desktop,
  // data integrity and independent attestation remain separate hard gates.
  throw new Error('worker probe captured; complete API/Desktop restore acceptance and independent attestation before release')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`PG17 application smoke preflight NO-GO: ${error.message}\n`); process.exitCode = 1 }
}
