#!/usr/bin/env node
// Read-only topology/configuration preflight. Deliberately does not start an
// API/worker, write a pass artifact, or issue production restore evidence.
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX = /^[a-f0-9]{64}$/u
const IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u
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
  check(capture?.schema_version === 'pg17-isolated-restore-capture/1' && capture.status === 'pass' && capture.simulated === false && HEX.test(capture.network_id ?? '') && HEX.test(capture.container_id ?? ''), 'valid protected PG17 capture required')
  check(network?.Id === capture?.network_id && network?.Internal === true && network?.Ingress !== true && network?.Driver === 'bridge', 'restore network must be exact internal bridge')
  check(postgres?.Id === capture?.container_id && postgres?.State?.Running === true && postgres?.HostConfig?.NetworkMode === network?.Name && postgres?.Image === capture?.postgres_image_id, 'restore Postgres identity/network mismatch')
  check(postgres?.Mounts?.length === 1 && postgres?.Mounts?.[0]?.Type === 'volume' && postgres?.Mounts?.[0]?.Name === capture?.volume_name, 'restore Postgres volume mismatch')
  check(Object.keys(postgres?.HostConfig?.PortBindings ?? {}).length === 0, 'restore Postgres publishes a port')
  check(HEX.test(redis?.Id ?? '') && redis?.State?.Running === true && redis?.HostConfig?.NetworkMode === network?.Name && redis?.Image === images?.redis_id, 'isolated Redis identity/network mismatch')
  check(redis?.Mounts?.length === 0 && Object.keys(redis?.HostConfig?.PortBindings ?? {}).length === 0, 'isolated Redis has a mount or published port')
  for (const name of ['api', 'worker', 'redis']) check(IMAGE.test(images?.[name] ?? '') && /^sha256:[a-f0-9]{64}$/u.test(images?.[`${name}_id`] ?? ''), `${name} image must be immutable and inspected`)
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
  const allowedWorker = new Set(['DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'WORKER_ROLE', 'WORKER_ONCE', 'WORKER_METRICS_PORT', 'WORKER_API_BASE_URL'])
  check(Object.keys(apiEnv ?? {}).every(key => allowedApi.has(key)), 'API smoke environment contains unreviewed key or external integration')
  check(Object.keys(workerEnv ?? {}).every(key => allowedWorker.has(key)), 'worker smoke environment contains unreviewed key or external integration')
  check(apiEnv?.NODE_ENV === 'production' && apiEnv?.DEPLOYMENT_PROFILE === 'ecs' && apiEnv?.RUN_MIGRATIONS_ON_STARTUP === 'false' && apiEnv?.CONNECTOR_FIXTURE_MODE === 'false' && apiEnv?.PAYMENT_RECONCILIATION_ENABLED === 'false' && apiEnv?.PAYMENT_REFUND_ENABLED === 'false' && apiEnv?.OPERATIONAL_ALERT_SWEEP_ENABLED === 'false', 'API side-effect controls incomplete')
  // Existing worker roles all enter a dispatch/poll loop. No released mode
  // proves a no-dispatch startup probe, so this must remain a hard blocker.
  errors.push('worker no-dispatch restore smoke mode is not implemented')
  return errors
}
function dockerInspect(kind, id) {
  requireValue(HEX.test(id ?? ''), 'Docker identity invalid')
  const result = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', kind, 'inspect', id], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } })
  requireValue(!result.error && result.status === 0, 'read-only Docker inspection failed')
  return JSON.parse(result.stdout)[0]
}
function main(args) {
  const names = ['--capture', '--api-env', '--worker-env', '--redis-id', '--images', '--roles']
  requireValue(args.length === names.length * 2, 'exact preflight arguments required')
  const inputs = {}
  for (let i = 0; i < args.length; i += 2) { requireValue(names.includes(args[i]) && !Object.hasOwn(inputs, args[i]) && args[i + 1], 'unknown or duplicate argument'); inputs[args[i]] = args[i + 1] }
  requireValue(names.every(name => inputs[name]), 'missing preflight argument')
  const capture = JSON.parse(protectedFile(inputs['--capture']).toString())
  const images = JSON.parse(protectedFile(inputs['--images']).toString())
  const roles = JSON.parse(protectedFile(inputs['--roles']).toString())
  const apiEnv = parseSmokeEnv(protectedFile(inputs['--api-env']).toString())
  const workerEnv = parseSmokeEnv(protectedFile(inputs['--worker-env']).toString())
  const network = dockerInspect('network', capture.network_id)
  const postgres = dockerInspect('container', capture.container_id)
  const redis = dockerInspect('container', inputs['--redis-id'])
  const errors = validatePg17SmokeTopology({ capture, network, postgres, redis, images, apiEnv, workerEnv, roles })
  requireValue(errors.length === 0, errors.join('; '))
  // Never report a runtime pass or issue evidence from this read-only tool.
  throw new Error('application smoke has not run; preflight cannot issue production evidence')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`PG17 application smoke preflight NO-GO: ${error.message}\n`); process.exitCode = 1 }
}
