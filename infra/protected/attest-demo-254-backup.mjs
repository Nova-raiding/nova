#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node
// Bundle this entry from an exact reviewed commit, then install via the
// protected control installer. It never accepts a container name or DB URL.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSnapshot, createProtectedEnvironment, pgDumpArguments } from './attest-postgres-backup.mjs'
import { captureDemo254Backup } from './capture-demo-254-backup.mjs'

const ROOT = '/var/lib/merchant-release-security/backups'
const TRUST = '/run/release-security/evidence-trust'
const INSTALLED = '/usr/local/libexec/merchant/attest-demo-254-backup'
const DIGEST = `${TRUST}/production-demo-254-backup-attester-sha256`
const PLAN = `${TRUST}/production-demo-254-backup-source-plan.json`
const PRIVATE = '/var/lib/merchant-release-security/production-capability-private.pem'
const PUBLIC = `${TRUST}/production-evidence-public.pem`
const KEY_ID = `${TRUST}/production-evidence-key-id`
const DOCKER = '/usr/bin/docker'
const DOCKER_HOST = 'unix:///var/run/docker.sock'
const PSQL = '/usr/pgsql-16/bin/psql'
const DUMP = '/usr/pgsql-16/bin/pg_dump'
const CURL = '/usr/bin/curl'
const PROJECT = 'merchant-demo-85575f9c'
const NETWORK = `${PROJECT}_default`
const NAMES = { gateway: `${PROJECT}-pilot-gateway-1`, api: `${PROJECT}-api-replica-1`, postgres: `${PROJECT}-postgres-1` }
const SHA = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`DEMO_254_BACKUP_${message}`) }
const check = (value, message) => { if (!value) fail(message) }
const hash = value => createHash('sha256').update(value).digest('hex')

function protectedFile(path, max = 8 * 1024 * 1024, mode) {
  check(path === resolve(path) && realpathSync(path) === path, 'PROTECTED_PATH_INVALID')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    check(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'PROTECTED_OWNER_INVALID')
    if (cursor === '/') break
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size > 0 && stat.size <= max && (mode === undefined || (stat.mode & 0o777) === mode), 'PROTECTED_FILE_INVALID')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
function protectedDirectory(path) {
  check(path === resolve(path) && realpathSync(path) === path, 'PROTECTED_DIRECTORY_INVALID')
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor)
    check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'PROTECTED_DIRECTORY_OWNER_INVALID')
    if (cursor === '/') break
  }
}
export function assertDemo254LocalTarget(env = process.env) {
  check(!env.DOCKER_CONTEXT && !env.DOCKER_CONFIG && (!env.DOCKER_HOST || env.DOCKER_HOST === DOCKER_HOST), 'REMOTE_DOCKER_FORBIDDEN')
  for (const name of Object.keys(env)) check(!name.startsWith('PG') && !['DATABASE_URL', 'OPS_DATABASE_URL', 'NODE_OPTIONS', 'NODE_PATH'].includes(name), 'CALLER_DATABASE_OR_NODE_ENV_FORBIDDEN')
}
function run(binary, args, maxBuffer = 2 * 1024 * 1024) {
  return execFileSync(binary, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_HOST }, timeout: 30_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] })
}
function inspect(name, execute) {
  const values = JSON.parse(execute(DOCKER, ['--host', DOCKER_HOST, 'inspect', name]))
  check(Array.isArray(values) && values.length === 1 && values[0]?.Name === `/${name}` && values[0]?.State?.Running === true, 'CONTAINER_UNAVAILABLE')
  return values[0]
}
function network(value, service) {
  const labels = value.Config?.Labels ?? {}
  const list = Object.entries(value.NetworkSettings?.Networks ?? {})
  check(labels['com.docker.compose.project'] === PROJECT && labels['com.docker.compose.service'] === service
    && list.length === 1 && list[0][0] === NETWORK && SHA.test(value.Id)
    && /^sha256:[a-f0-9]{64}$/u.test(value.Image ?? '') && SHA.test(list[0][1]?.NetworkID ?? ''), 'CONTAINER_IDENTITY_INVALID')
  return { name: NETWORK, id: list[0][1].NetworkID, ipv4: list[0][1].IPAddress }
}
function envMap(value) {
  check(Array.isArray(value.Config?.Env), 'CONTAINER_ENV_MISSING')
  const map = new Map()
  for (const line of value.Config.Env) {
    const at = line.indexOf('=')
    check(at > 0 && !map.has(line.slice(0, at)), 'CONTAINER_ENV_INVALID')
    map.set(line.slice(0, at), line.slice(at + 1))
  }
  return map
}
function endpoint(raw, role, ip) {
  check(typeof raw === 'string', 'DATABASE_URL_MISSING')
  const url = new URL(raw)
  check(url.protocol === 'postgres:' && url.hostname === 'postgres' && url.port === '5432'
    && url.pathname === '/merchant' && decodeURIComponent(url.username) === role
    && url.searchParams.get('sslmode') === 'require' && url.password.length > 0, 'DATABASE_URL_INVALID')
  return { host: 'postgres', resolved_ip: ip, port: 5432, database: 'merchant', user: role }
}
export function observeDemo254Topology(execute = run) {
  const gateway = inspect(NAMES.gateway, execute), api = inspect(NAMES.api, execute), postgres = inspect(NAMES.postgres, execute)
  const gnet = network(gateway, 'pilot-gateway'), anet = network(api, 'api-replica'), pnet = network(postgres, 'postgres')
  check(gnet.id === anet.id && anet.id === pnet.id, 'NETWORK_DRIFT')
  check(/(?:^|\/)postgres:16(?:[.\-@]|$)/u.test(postgres.Config?.Image ?? ''), 'POSTGRES_NOT_PG16')
  const mounts = postgres.Mounts ?? []
  check(mounts.length >= 1 && mounts.some(item => item.Type === 'volume' && item.Name === `${PROJECT}_merchant-postgres` && item.Destination === '/var/lib/postgresql/data'), 'POSTGRES_VOLUME_INVALID')
  const ports = gateway.NetworkSettings?.Ports ?? {}
  check(ports['8443/tcp']?.some(item => item.HostPort === '443'), 'PUBLIC_GATEWAY_PORT_INVALID')
  const conf = execute(DOCKER, ['--host', DOCKER_HOST, 'exec', NAMES.gateway, 'cat', '/etc/nginx/conf.d/default.conf'])
  check(/upstream\s+pilot_api\s*\{[^}]*server\s+api-replica:8787\s+resolve;/su.test(conf)
    && /location\s+\^~\s+\/api\/\s*\{[^}]*proxy_pass\s+http:\/\/pilot_api;/su.test(conf)
    && /server_name\s+yxsona\.com\b/u.test(conf), 'PUBLIC_GATEWAY_ROUTE_INVALID')
  const releaseArgs = ['--fail', '--silent', '--show-error', '--max-time', '10']
  const release = JSON.parse(execute(CURL, [...releaseArgs, 'https://yxsona.com/api/releasez'], 64 * 1024))
  const gatewayRelease = JSON.parse(execute(CURL, [...releaseArgs, '--resolve', 'yxsona.com:443:127.0.0.1', 'https://yxsona.com/api/releasez'], 64 * 1024))
  check(JSON.stringify(release?.data?.release) === JSON.stringify(gatewayRelease?.data?.release)
    && gatewayRelease?.data?.ready === true, 'PUBLIC_GATEWAY_RESPONSE_DRIFT')
  check(release?.data?.ready === true, 'PUBLIC_RELEASE_UNREADY')
  const metadata = release.data.release
  check(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(metadata?.release_id ?? '')
    && /^[a-f0-9]{40}$/u.test(metadata?.release_git_sha ?? ''), 'PUBLIC_RELEASE_INVALID')
  const apiEnv = envMap(api)
  const resolved = execute(DOCKER, ['--host', DOCKER_HOST, 'exec', NAMES.api, 'getent', 'hosts', 'postgres'], 4096)
    .trim().split(/\s+/u)[0]
  check(resolved === pnet.ipv4, 'API_POSTGRES_DNS_DRIFT')
  const connections = { runtime: endpoint(apiEnv.get('DATABASE_URL'), 'merchant_app', pnet.ipv4),
    ops: endpoint(apiEnv.get('OPS_DATABASE_URL'), 'merchant_ops', pnet.ipv4) }
  const dbEnv = envMap(postgres)
  check(dbEnv.get('POSTGRES_DB') === 'merchant' && dbEnv.get('POSTGRES_USER') && dbEnv.get('POSTGRES_PASSWORD'), 'POSTGRES_CREDENTIALS_UNAVAILABLE')
  return { observation: {
    schema_version: 'demo-254-backup-source-observation/1', observed_at: new Date().toISOString(),
    public_route: { origin: 'https://yxsona.com', host: 'yxsona.com', path_prefix: '/api', release_id: metadata.release_id,
      git_sha: metadata.release_git_sha, gateway_id: gateway.Id, api_replica_id: api.Id },
    gateway: { id: gateway.Id, image_id: gateway.Image, route_host: 'yxsona.com', route_path_prefix: '/api', upstream_container_id: api.Id, upstream_port: 8787 },
    api_replica: { id: api.Id, image_id: api.Image, compose_project: PROJECT, compose_service: 'api-replica', network_name: NETWORK, network_id: anet.id, postgres_container_id: postgres.Id },
    postgres: { id: postgres.Id, image_id: postgres.Image, compose_project: PROJECT, compose_service: 'postgres', network_name: NETWORK, network_id: pnet.id,
      ipv4: pnet.ipv4, volume_name: `${PROJECT}_merchant-postgres` }, connections,
  }, pg: { PGHOST: pnet.ipv4, PGPORT: '5432', PGDATABASE: 'merchant', PGUSER: dbEnv.get('POSTGRES_USER'), PGPASSWORD: dbEnv.get('POSTGRES_PASSWORD'), PGCONNECT_TIMEOUT: '10' } }
}
function queryMigrations(snapshot, pg) {
  check(/^[A-Za-z0-9:-]{1,256}$/u.test(snapshot), 'SNAPSHOT_INVALID')
  const sql = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; SELECT json_build_object('name',current_database(),'oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),'server_version_num',current_setting('server_version_num')::integer,'migration_rows',(SELECT coalesce(json_agg(json_build_object('version',version,'name',name,'checksum',checksum) ORDER BY version),'[]'::json) FROM public.schema_migrations)); ROLLBACK;`
  const result = execFileSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...createProtectedEnvironment(pg), PGOPTIONS: '-c default_transaction_read_only=on' }, timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = result.trim().split('\n').map(line => line.trim()).filter(Boolean)
  check(lines.length === 1 && lines[0].startsWith('{'), 'SNAPSHOT_QUERY_OUTPUT_INVALID')
  return JSON.parse(lines[0])
}
function dump(snapshot, path, pg) {
  return new Promise((resolveDump, rejectDump) => {
    const child = spawn(DUMP, pgDumpArguments(snapshot, path), { env: createProtectedEnvironment(pg), stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrBytes = 0, settled = false
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? rejectDump(error) : resolveDump() }
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('protected pg_dump timed out')) }, 6 * 60 * 60_000)
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 64 * 1024) child.kill('SIGTERM') })
    child.on('error', () => finish(new Error('protected pg_dump failed')))
    child.on('exit', code => finish(code === 0 ? null : new Error('protected pg_dump failed')))
  })
}
function parseArgs(args) {
  check(args.length === 7 && args[0] === 'create', 'EXACT_ARGS_REQUIRED')
  const values = new Map()
  for (let i = 1; i < args.length; i += 2) {
    check(['--release-id', '--attempt-id', '--approved-plan-sha256'].includes(args[i]) && !values.has(args[i]), 'ARG_INVALID')
    values.set(args[i], args[i + 1])
  }
  check(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(values.get('--release-id') ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u.test(values.get('--attempt-id') ?? '')
    && SHA.test(values.get('--approved-plan-sha256') ?? ''), 'ARG_VALUE_INVALID')
  return { releaseId: values.get('--release-id'), attemptId: values.get('--attempt-id'), planSha: values.get('--approved-plan-sha256') }
}
async function main(args) {
  check(process.getuid?.() === 0 && process.geteuid?.() === 0, 'ROOT_REQUIRED')
  assertDemo254LocalTarget()
  check(realpathSync(process.argv[1]) === INSTALLED, 'FIXED_INSTALL_REQUIRED')
  check(hash(protectedFile(INSTALLED)) === protectedFile(DIGEST, 128).toString('utf8').trim(), 'INSTALL_DIGEST_MISMATCH')
  for (const path of [process.execPath, DOCKER, PSQL, DUMP, CURL]) protectedFile(path, path === process.execPath ? 256 * 1024 * 1024 : 64 * 1024 * 1024)
  const { releaseId, attemptId, planSha } = parseArgs(args)
  const planBytes = protectedFile(PLAN, 1024 * 1024, 0o444)
  check(hash(planBytes) === planSha, 'PLAN_DIGEST_MISMATCH')
  const signedPlan = JSON.parse(planBytes.toString('utf8'))
  check(signedPlan?.freeze?.public_route?.release_id === releaseId, 'PLAN_RELEASE_MISMATCH')
  const publicPem = protectedFile(PUBLIC), privatePem = protectedFile(PRIVATE, 8192, 0o600)
  const keyId = protectedFile(KEY_ID, 128).toString('utf8').trim()
  protectedDirectory(ROOT)
  const output = join(ROOT, `${releaseId}-demo254-${attemptId}`)
  mkdirSync(output, { mode: 0o700 }); protectedDirectory(output)
  const backupPath = join(output, 'before-upgrade-254.dump')
  const first = observeDemo254Topology()
  check(first.observation.public_route.release_id === releaseId, 'PUBLIC_RELEASE_MISMATCH')
  for (const name of Object.keys(process.env)) if (name.startsWith('PG')) delete process.env[name]
  Object.assign(process.env, first.pg)
  const collector = {
    observeTopology: async () => observeDemo254Topology().observation,
    snapshot: captureSnapshot,
    dump: (snapshot, path) => dump(snapshot, path, first.pg),
    observeMigrations: snapshot => queryMigrations(snapshot, first.pg),
  }
  const result = await captureDemo254Backup({ signedPlan, planPublicPem: publicPem, privatePem, publicPem, keyId,
    backupPath, attestationPath: `${backupPath}.attestation.json`, checksumPath: `${backupPath}.sha256`, manifestPath: `${backupPath}.capture.json` }, collector)
  process.stdout.write(`${JSON.stringify({ backup_name: basename(backupPath), backup_sha256: result.attestation.backup_sha256,
    manifest_sha256: hash(JSON.stringify(result.manifest)), migration_version: 254, database_mutations: false })}\n`)
}
if (process.argv[1] && basename(process.argv[1]) === basename(INSTALLED) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`demo 254 backup rejected: ${error.message}\n`); process.exitCode = 1 })
}
