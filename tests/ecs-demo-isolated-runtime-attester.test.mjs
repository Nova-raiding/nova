import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalRepoDigest, PG_SQL, verifyIsolatedRuntime } from '../infra/scripts/attest-ecs-demo-isolated-runtime.mjs'

const project = 'merchant-demo-proof'
const sha = 'a'.repeat(40)
const source = `sha256:${'b'.repeat(64)}`
const manifestSha = 'c'.repeat(64)
const ids = { api: '1'.repeat(64), postgres: '2'.repeat(64), redis: '3'.repeat(64) }
const imageIds = { api: `sha256:${'4'.repeat(64)}`, postgres: `sha256:${'5'.repeat(64)}`, redis: `sha256:${'6'.repeat(64)}` }
const refs = { api: `registry.invalid/api@sha256:${'7'.repeat(64)}`, postgres: `postgres:17-alpine@sha256:${'8'.repeat(64)}`, redis: `redis:7-alpine@sha256:${'9'.repeat(64)}` }

function fixture() {
  const compose = { name: project, services: {
    api: { image: refs.api, environment: { RELEASE_ID: 'release-proof', RELEASE_GIT_SHA: sha, RELEASE_MANIFEST_SHA256: manifestSha } },
    postgres: { image: refs.postgres }, redis: { image: refs.redis },
  } }
  const identity = { release_id: 'release-proof', git_sha: sha, source_sha256: source }
  const manifest = { schema: 'isolated-demo-candidate/1', deployment_scope: 'isolated_four_service_candidate',
    public_ports: [], release_id: identity.release_id, release_git_sha: sha, source_sha256: source,
    image_references: { 'merchant-api': refs.api, 'postgres-migration': refs.postgres, 'candidate-redis': refs.redis },
    image_digests: { 'merchant-api': refs.api.split('@')[1], 'postgres-migration': refs.postgres.split('@')[1], 'candidate-redis': refs.redis.split('@')[1] } }
  const containers = {}, images = {}, members = {}
  for (const service of ['api', 'postgres', 'redis']) {
    const id = ids[service]
    containers[service] = { Id: id, Name: `/${project}-${service}-1`, Image: imageIds[service], State: { Running: true },
      Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service,
        ...(service === 'api' ? { 'com.storenova.release.id': identity.release_id } : {}) } },
      HostConfig: { NetworkMode: `${project}_private`, PortBindings: {} },
      NetworkSettings: { Networks: { [`${project}_private`]: {} }, Ports: { '5432/tcp': null } } }
    images[service] = { Id: imageIds[service], RepoDigests: [canonicalRepoDigest(refs[service])], Config: { Labels: service === 'api' ? {
      'com.storenova.release.id': identity.release_id, 'org.opencontainers.image.revision': sha,
      'com.storenova.release.source_sha256': source } : {} } }
    members[id] = { Name: `${project}-${service}-1` }
  }
  const network = { Name: `${project}_private`, Labels: { 'com.docker.compose.project': project }, Internal: false, Containers: members }
  const database = { server_version_num: 170006, history_count: 254, history_first: 1, history_last: 254, history_distinct: 254,
    checksums: true, role_count: 3, roles_safe: true, tenant_count: 47, unsafe_tenant_count: 0 }
  const health = { status: 200, body: JSON.stringify({ data: { persistence: { ready: true } } }) }
  const readiness = { status: 503, body: JSON.stringify({ error: { code: 'PRODUCTION_READINESS_BLOCKED', details: { gates: { relay: { ready: false } } } } }) }
  return { compose, identity, manifest, manifestSha256: manifestSha, containers, images, network, database, health, readiness }
}

test('records exact three-container isolated observation without claiming production GO', () => {
  const result = verifyIsolatedRuntime(fixture())
  assert.equal(result.status, 'review_only')
  assert.equal(result.scope, 'isolated')
  assert.equal(result.deployable, false)
  assert.equal(result.production_go, false)
  assert.deepEqual(Object.keys(result.containers).sort(), ['api', 'postgres', 'redis'])
  assert.equal(result.api.readyz_status, 503)
  assert.deepEqual(result.postgres.workspace_rls, {
    scope: 'public_workspace_id_tables_excluding_special_policy_tables', checked_table_count: 47, verified: true,
  })
  assert.equal(Object.hasOwn(result.postgres, 'tenant_rls_verified'), false)
  assert.doesNotMatch(JSON.stringify(result), /password|DATABASE_URL|secret/u)
})

test('accepts Docker tag-less RepoDigests while preserving repository and registry port', () => {
  assert.equal(canonicalRepoDigest(refs.redis), `redis@sha256:${'9'.repeat(64)}`)
  assert.equal(canonicalRepoDigest(refs.postgres), `postgres@sha256:${'8'.repeat(64)}`)
  assert.equal(canonicalRepoDigest(`registry.invalid:5000/team/api:v3@sha256:${'7'.repeat(64)}`),
    `registry.invalid:5000/team/api@sha256:${'7'.repeat(64)}`)
  assert.equal(verifyIsolatedRuntime(fixture()).scope, 'isolated')
})

test('PG observation evaluates every policy and rejects inherited privileges', () => {
  assert.match(PG_SQL, /bool_or\(permissive <> 'PERMISSIVE' OR roles <> ARRAY\['public'\]::name\[\]/u)
  assert.match(PG_SQL, /cmd NOT IN \('ALL','SELECT','INSERT','UPDATE','DELETE'\)/u)
  assert.match(PG_SQL, /with_check IS NOT NULL AND with_check <>/u)
  assert.match(PG_SQL, /coalesce\(p\.policy_count,0\)=0 OR coalesce\(p\.unsafe_policy,true\)/u)
  assert.match(PG_SQL, /NOT rolinherit/u)
  assert.match(PG_SQL, /NOT EXISTS \(SELECT 1 FROM pg_auth_members m WHERE m\.member=pg_roles\.oid\)/u)
  assert.doesNotMatch(PG_SQL, /OR NOT EXISTS \(SELECT 1 FROM pg_policies/u)
})

test('rejects image, identity, project and network substitution', () => {
  for (const mutate of [
    x => { x.containers.api.Id = 'f'.repeat(64) },
    x => { x.images.api.Config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40) },
    x => { x.images.redis.RepoDigests = [`other/redis@sha256:${'9'.repeat(64)}`] },
    x => { x.images.redis.RepoDigests = [`redis@sha256:${'f'.repeat(64)}`] },
    x => { x.images.redis.Id = `sha256:${'f'.repeat(64)}` },
    x => { x.manifest.image_references['merchant-api'] = refs.redis },
    x => { x.compose.services.api.environment.RELEASE_MANIFEST_SHA256 = 'f'.repeat(64) },
    x => { x.network.Name = 'merchant-production_default' },
    x => { x.network.Containers['f'.repeat(64)] = { Name: 'foreign-container' } },
    x => { x.containers.api.HostConfig.NetworkMode = 'host' },
    x => { x.containers.extra = x.containers.redis },
  ]) {
    const value = fixture(); mutate(value)
    assert.throws(() => verifyIsolatedRuntime(value))
  }
})

test('rejects published ports, incomplete migration, unsafe roles/RLS and ready traffic', () => {
  for (const mutate of [
    x => { x.containers.api.HostConfig.PortBindings = { '8787/tcp': [{ HostIp: '0.0.0.0', HostPort: '8787' }] } },
    x => { x.containers.api.NetworkSettings.Ports = { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '8787' }] } },
    x => { x.database.history_count = 253 },
    x => { x.database.server_version_num = 160012 },
    x => { x.database.roles_safe = false },
    x => { x.database.unsafe_tenant_count = 1 },
    x => { x.health.status = 503 },
    x => { x.readiness.status = 200 },
    x => { x.readiness.body = '{}' },
    x => { x.readiness.body = JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE' } }) },
    x => { x.readiness.body = JSON.stringify({ error: { code: 'PRODUCTION_READINESS_BLOCKED', details: { gates: {} } } }) },
    x => { x.readiness.body = JSON.stringify({ error: { code: 'PRODUCTION_READINESS_BLOCKED', details: { gates: { relay: { ready: true } } } } }) },
  ]) {
    const value = fixture(); mutate(value)
    assert.throws(() => verifyIsolatedRuntime(value))
  }
})
