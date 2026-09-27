#!/usr/bin/env node
// Read-only observation of the three running first-install candidate services.
// This is isolated review evidence and can never authorize production cutover.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_ID = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u
const SERVICES = ['api', 'postgres', 'redis']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const requireValue = (value, message) => { if (!value) throw new Error(message) }

// Docker reports RepoDigests without a tag even when inspect was requested as
// repository:tag@sha256. Remove only the final path component's tag; a registry
// port remains part of the repository identity.
export function canonicalRepoDigest(reference) {
  requireValue(IMAGE.test(reference ?? ''), 'image reference is not immutable')
  const [repository, digest] = reference.split('@')
  const slash = repository.lastIndexOf('/')
  const tag = repository.lastIndexOf(':')
  return `${tag > slash ? repository.slice(0, tag) : repository}@${digest}`
}

function protectedJson(path, label) {
  requireValue(typeof path === 'string' && path.startsWith('/') && resolve(path) === path && realpathSync(path) === path, `${label} path is unsafe`)
  const file = statSync(path)
  requireValue(file.isFile() && file.uid === 0 && (file.mode & 0o777) === 0o600, `${label} is not protected`)
  for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
    const stat = statSync(parent)
    requireValue(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0, `${label} parent is unsafe`)
  }
  const bytes = readFileSync(path)
  requireValue(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, `${label} size is invalid`)
  return { value: JSON.parse(bytes.toString('utf8')), digest: sha(bytes) }
}

function protectedIdentity(path) {
  requireValue(typeof path === 'string' && path.startsWith('/') && resolve(path) === path && realpathSync(path) === path, 'identity path is unsafe')
  const file = statSync(path)
  requireValue(file.isFile() && file.uid === 0 && (file.mode & 0o777) === 0o600, 'identity is not protected')
  for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
    const stat = statSync(parent)
    requireValue(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'identity parent is unsafe')
  }
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/u)
  const identity = {}
  for (const line of lines) {
    const at = line.indexOf('=')
    requireValue(at > 0 && !Object.hasOwn(identity, line.slice(0, at)), 'identity has malformed or duplicate field')
    identity[line.slice(0, at)] = line.slice(at + 1)
  }
  return identity
}

function docker(args, input) {
  const result = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    input, encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  // stderr may contain interpolated Compose secrets. Never propagate it.
  requireValue(!result.error && result.status === 0, `isolated Docker observation failed: ${args[0]}`)
  return result.stdout.trim()
}

const parseDocker = (args, input) => {
  try { return JSON.parse(docker(args, input)) } catch { throw new Error(`isolated Docker response is invalid: ${args[0]}`) }
}

export const PG_SQL = `WITH history AS (
  SELECT count(*) AS total, min(version) AS first, max(version) AS last,
         count(DISTINCT version) AS distinct_versions,
         bool_and(name IS NOT NULL AND length(name)>0 AND checksum ~ '^[a-f0-9]{64}$') AS checksums
    FROM schema_migrations
), roles AS (
  SELECT count(*) AS total,
         bool_and(rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
           AND NOT rolbypassrls AND NOT rolinherit
           AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=pg_roles.oid)) AS safe
    FROM pg_roles WHERE rolname IN ('merchant_app','merchant_ops','merchant_alert_receiver')
), tenant AS (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE NOT c.relrowsecurity OR NOT c.relforcerowsecurity
           OR coalesce(p.policy_count,0)=0 OR coalesce(p.unsafe_policy,true)) AS unsafe
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped
    LEFT JOIN LATERAL (
      SELECT count(*) AS policy_count,
             bool_or(permissive <> 'PERMISSIVE' OR roles <> ARRAY['public']::name[]
               OR cmd NOT IN ('ALL','SELECT','INSERT','UPDATE','DELETE')
               OR coalesce(qual,'') <> '(workspace_id = current_setting(''app.workspace_id''::text, true))'
               OR (with_check IS NOT NULL AND with_check <> '(workspace_id = current_setting(''app.workspace_id''::text, true))')) AS unsafe_policy
        FROM pg_policies WHERE schemaname='public' AND tablename=c.relname
    ) p ON true
   WHERE n.nspname='public' AND c.relkind IN ('r','p')
     AND c.relname NOT IN ('commercial_rollouts','workspace_members','workspace_identity_bindings',
       'workspace_commercial_settings','workspace_subscriptions','ops_access_grants','ops_access_grant_events',
       'authorization_execution_reservations','mcp_oauth_authorization_codes','mcp_oauth_tokens',
       'local_plugin_connection_requests','local_plugin_install_instances','local_plugin_install_audit')
) SELECT json_build_object('server_version_num',current_setting('server_version_num')::integer,
  'history_count',history.total,'history_first',history.first,
  'history_last',history.last,'history_distinct',history.distinct_versions,'checksums',history.checksums,
  'role_count',roles.total,'roles_safe',roles.safe,'tenant_count',tenant.total,'unsafe_tenant_count',tenant.unsafe)
FROM history,roles,tenant`

const HTTP_PROBE = `const http=require('node:http');const path=process.argv[1];
const req=http.get({host:'127.0.0.1',port:8787,path,timeout:5000},res=>{
 let body='';res.setEncoding('utf8');res.on('data',v=>{body+=v;if(body.length>65536)req.destroy()});
 res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body})));
});req.on('timeout',()=>req.destroy());req.on('error',()=>process.exit(2));`

export function verifyIsolatedRuntime({ compose, identity, manifest, manifestSha256, containers, images, network, database, health, readiness }) {
  const project = compose?.name
  requireValue(/^merchant-demo-[a-z0-9][a-z0-9_-]{0,25}$/u.test(project ?? ''), 'isolated project identity is invalid')
  requireValue(manifest?.schema === 'isolated-demo-candidate/1' && manifest.deployment_scope === 'isolated_four_service_candidate' &&
    Array.isArray(manifest.public_ports) && manifest.public_ports.length === 0, 'manifest is not an isolated candidate')
  requireValue(identity.release_id === manifest.release_id && identity.git_sha === manifest.release_git_sha &&
    identity.source_sha256 === manifest.source_sha256 && compose.services?.api?.environment?.RELEASE_ID === identity.release_id &&
    compose.services.api.environment.RELEASE_GIT_SHA === identity.git_sha &&
    compose.services.api.environment.RELEASE_MANIFEST_SHA256 === manifestSha256, 'candidate identity or manifest binding differs')
  requireValue(/^[0-9a-f]{40}$/u.test(identity.git_sha ?? '') && DIGEST.test(identity.source_sha256 ?? '') &&
    /^[0-9a-f]{64}$/u.test(manifestSha256 ?? ''), 'candidate digest is invalid')
  requireValue(Object.keys(containers).sort().join(',') === SERVICES.slice().sort().join(','), 'candidate project has unexpected running or stopped containers')
  requireValue(network?.Name === `${project}_private` && network?.Labels?.['com.docker.compose.project'] === project &&
    network?.Internal === false, 'candidate project network differs')
  requireValue(Object.keys(network.Containers ?? {}).sort().join(',') ===
    SERVICES.map(service => containers[service]?.Id).sort().join(','), 'candidate private network has an unexpected endpoint')
  const details = {}
  for (const service of SERVICES) {
    const config = compose.services?.[service], container = containers[service], image = images[service]
    const artifact = service === 'api' ? 'merchant-api' : service === 'postgres' ? 'postgres-migration' : 'candidate-redis'
    requireValue(config && IMAGE.test(config.image ?? '') && config.image === manifest.image_references?.[artifact] &&
      manifest.image_digests?.[artifact] === config.image.split('@')[1], `${service} manifest image differs`)
    requireValue(FULL_ID.test(container?.Id ?? '') && DIGEST.test(container?.Image ?? '') &&
      container.State?.Running === true && container.Config?.Labels?.['com.docker.compose.project'] === project &&
      container.Config?.Labels?.['com.docker.compose.service'] === service &&
      container.Image === image?.Id && image?.RepoDigests?.includes(canonicalRepoDigest(config.image)), `${service} container/image identity differs`)
    requireValue(!Object.values(container.HostConfig?.PortBindings ?? {}).some(value => value?.length) &&
      !Object.values(container.NetworkSettings?.Ports ?? {}).some(value => value?.length) &&
      container.HostConfig?.NetworkMode === `${project}_private` &&
      Object.keys(container.NetworkSettings?.Networks ?? {}).join(',') === `${project}_private` &&
      network.Containers?.[container.Id]?.Name === container.Name?.slice(1), `${service} network or host port differs`)
    if (service === 'api') requireValue(image.Config?.Labels?.['com.storenova.release.id'] === identity.release_id &&
      image.Config?.Labels?.['org.opencontainers.image.revision'] === identity.git_sha &&
      image.Config?.Labels?.['com.storenova.release.source_sha256'] === identity.source_sha256 &&
      container.Config?.Labels?.['com.storenova.release.id'] === identity.release_id, 'API release labels differ')
    details[service] = { container_id: container.Id, image_id: container.Image, image_digest: config.image.split('@')[1] }
  }
  requireValue(database?.server_version_num >= 170000 && database.server_version_num < 180000 &&
    database.history_count === 254 && database.history_first === 1 && database.history_last === 254 &&
    database.history_distinct === 254 && database.checksums === true && database.role_count === 3 &&
    database.roles_safe === true && database.tenant_count > 0 && database.unsafe_tenant_count === 0,
  'PG17 migration, role or RLS observation failed')
  requireValue(health?.status === 200 && (() => { try { return JSON.parse(health.body)?.data?.persistence?.ready === true } catch { return false } })(),
    'isolated API healthz is unhealthy')
  requireValue(readiness?.status === 503 && (() => {
    try {
      const body = JSON.parse(readiness.body)
      return body?.error?.code === 'PRODUCTION_READINESS_BLOCKED' &&
        body.error.details?.gates && typeof body.error.details.gates === 'object' &&
        !Array.isArray(body.error.details.gates)
    } catch { return false }
  })(), 'isolated API readyz did not report the expected production gate block')
  return { schema: 'ecs-demo-isolated-runtime-attestation/1', status: 'review_only', scope: 'isolated',
    deployable: false, production_go: false, project, release_id: identity.release_id, git_sha: identity.git_sha,
    manifest_sha256: `sha256:${manifestSha256}`, containers: details,
    postgres: { migration_prefix: 254, roles_verified: true, tenant_rls_verified: true },
    api: { healthz_status: 200, readyz_status: 503 } }
}

export function attestIsolatedRuntime({ composePath, identityPath, manifestPath }) {
  const compose = protectedJson(composePath, 'Compose').value
  const identity = protectedIdentity(identityPath)
  const manifestFile = protectedJson(manifestPath, 'manifest')
  const project = compose?.name
  requireValue(/^merchant-demo-[a-z0-9][a-z0-9_-]{0,25}$/u.test(project ?? ''), 'isolated project is invalid')
  const ids = docker(['container', 'ls', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']).split('\n').filter(Boolean)
  requireValue(ids.length === 3 && ids.every(id => FULL_ID.test(id)) && new Set(ids).size === 3, 'candidate project must have exactly three containers')
  const containers = {}
  for (const id of ids) {
    const result = parseDocker(['inspect', '--type', 'container', id])
    requireValue(Array.isArray(result) && result.length === 1 && result[0]?.Id === id, 'container inspection differs')
    const service = result[0].Config?.Labels?.['com.docker.compose.service']
    requireValue(SERVICES.includes(service) && !Object.hasOwn(containers, service), 'candidate service set differs')
    containers[service] = result[0]
  }
  const images = {}
  for (const service of SERVICES) {
    const ref = compose.services?.[service]?.image
    requireValue(IMAGE.test(ref ?? ''), `${service} image reference is invalid`)
    const result = parseDocker(['image', 'inspect', ref])
    requireValue(Array.isArray(result) && result.length === 1, `${service} image inspection differs`)
    images[service] = result[0]
  }
  const networkResult = parseDocker(['network', 'inspect', `${project}_private`])
  requireValue(Array.isArray(networkResult) && networkResult.length === 1, 'candidate network inspection differs')
  const pgId = containers.postgres?.Id, apiId = containers.api?.Id
  requireValue(FULL_ID.test(pgId ?? '') && FULL_ID.test(apiId ?? ''), 'candidate API/PG IDs are missing')
  const database = JSON.parse(docker(['exec', pgId, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'merchant', '-d', 'merchant', '-c', PG_SQL]))
  const probe = path => parseDocker(['exec', '-e', 'NODE_OPTIONS=', apiId, 'node', '-e', HTTP_PROBE, path])
  return verifyIsolatedRuntime({ compose, identity, manifest: manifestFile.value, manifestSha256: manifestFile.digest,
    containers, images, network: networkResult[0], database, health: probe('/healthz'), readiness: probe('/readyz') })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length === 5, 'usage: attest-ecs-demo-isolated-runtime.mjs <protected-compose.json> <protected-identity.txt> <protected-manifest.json>')
    process.stdout.write(`${JSON.stringify(attestIsolatedRuntime({ composePath: process.argv[2], identityPath: process.argv[3], manifestPath: process.argv[4] }))}\n`)
  } catch (error) {
    process.stderr.write(`isolated runtime attestation rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
