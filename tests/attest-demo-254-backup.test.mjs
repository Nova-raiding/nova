import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'
import { observeDemo254Topology, assertDemo254LocalTarget, consumeDemo254BackupNonce } from '../infra/protected/attest-demo-254-backup.mjs'
import { CONTROLS, prepareControlBytes } from '../infra/scripts/install-ecs-release-controls.mjs'

const project = 'merchant-demo-85575f9c'
const id = value => value.repeat(64)
function fixture() {
  const net = { NetworkID: id('c'), IPAddress: '192.168.96.3' }
  const container = (service, letter) => ({ Name: `/${project}-${service}-1`, Id: id(letter), Image: `sha256:${id(letter)}`,
    State: { Running: true }, Config: { Image: service === 'postgres' ? 'postgres:16.15' : 'example:stable',
      Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service }, Env: [] },
    NetworkSettings: { Networks: { [`${project}_default`]: net }, Ports: {} }, Mounts: [] })
  const gateway = container('pilot-gateway', 'a')
  gateway.NetworkSettings.Ports['8443/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '443' }]
  const api = container('api-replica', 'b')
  api.Config.Env = ['DATABASE_URL=postgres://merchant_app:secret@postgres:5432/merchant?sslmode=require',
    'OPS_DATABASE_URL=postgres://merchant_ops:secret@postgres:5432/merchant?sslmode=require']
  const postgres = container('postgres', 'd')
  postgres.Config.Env = ['POSTGRES_DB=merchant', 'POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=secret']
  postgres.Mounts = [{ Type: 'volume', Name: `${project}_merchant-postgres`, Destination: '/var/lib/postgresql/data' }]
  const config = `server { listen 8443 ssl; server_name yxsona.com; location ^~ /api/ { proxy_pass http://pilot_api; } }
    upstream pilot_api { resolver 127.0.0.11; server api-replica:8787 resolve; }`
  const release = { data: { ready: true, release: { release_id: 'release-f48c8454-dual-e2e', release_git_sha: 'f48c84544c519642de7c92615351007c9ac70a99',
    manifest_sha256: id('e'), image_set_digest: `sha256:${id('f')}` } } }
  const source = { [gateway.Name.slice(1)]: gateway, [api.Name.slice(1)]: api, [postgres.Name.slice(1)]: postgres }
  const run = (binary, args) => {
    if (binary === '/usr/bin/docker' && args[2] === 'inspect') return JSON.stringify([source[args[3]]])
    if (binary === '/usr/bin/docker' && args[2] === 'exec') return args[4] === 'getent' ? '192.168.96.3 postgres\n' : config
    if (binary === '/usr/bin/curl') return JSON.stringify(release)
    throw new Error('unexpected external command')
  }
  return { source, release, run }
}

test('observes exact public gateway, API replica, demo PG16 volume and redacted role endpoints', () => {
  const { observation, pg } = observeDemo254Topology(fixture().run)
  assert.equal(observation.public_route.gateway_id, id('a'))
  assert.equal(observation.gateway.upstream_container_id, id('b'))
  assert.equal(observation.api_replica.postgres_container_id, id('d'))
  assert.equal(observation.connections.runtime.user, 'merchant_app')
  assert.equal(observation.connections.ops.user, 'merchant_ops')
  assert.equal(pg.PGHOST, '192.168.96.3')
  assert.equal(pg.PGUSER, 'postgres')
  assert.equal(JSON.stringify(observation).includes('secret'), false)
  assert.deepEqual(CONTROLS.demo254Backup, { executable: 'attest-demo-254-backup', digest: 'production-demo-254-backup-attester-sha256' })
})

test('rejects old project, API route switch, missing ops URL, PG17 and nonlocal Docker', () => {
  for (const change of [
    value => { value.source[`${project}-postgres-1`].Config.Labels['com.docker.compose.project'] = 'merchant-production' },
    value => { value.run = ((original) => (binary, args) => binary === '/usr/bin/docker' && args[2] === 'exec'
      ? 'upstream pilot_api { server api:8787 resolve; }' : original(binary, args))(value.run) },
    value => { value.source[`${project}-api-replica-1`].Config.Env.pop() },
    value => { value.source[`${project}-postgres-1`].Config.Image = 'postgres:17.0' },
    value => { value.run = ((original) => (binary, args) => binary === '/usr/bin/docker' && args[4] === 'getent'
      ? '172.29.0.2 postgres\n' : original(binary, args))(value.run) },
  ]) {
    const value = fixture(); change(value)
    assert.throws(() => observeDemo254Topology(value.run), /DEMO_254_BACKUP_/u)
  }
  assert.throws(() => assertDemo254LocalTarget({ DOCKER_HOST: 'tcp://elsewhere:2375' }), /REMOTE_DOCKER_FORBIDDEN/u)
  assert.throws(() => assertDemo254LocalTarget({ PGHOST: 'elsewhere' }), /CALLER_DATABASE_OR_NODE_ENV_FORBIDDEN/u)
})

test('protected installer accepts a standalone reviewed bundle with a fixed Node shebang', () => {
  const bundled = buildSync({ entryPoints: ['infra/protected/attest-demo-254-backup.mjs'], bundle: true,
    platform: 'node', format: 'esm', target: 'node22', write: false }).outputFiles[0].contents
  const bundleBytes = Buffer.from(bundled)
  const sha = createHash('sha256').update(bundleBytes).digest('hex')
  const installed = prepareControlBytes('demo254Backup', bundleBytes, sha,
    '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node')
  assert.match(installed.toString(), /^#!\/usr\/local\/libexec\/merchant\/runtime\/node-v22\.23\.2-linux-x64\/bin\/node\n/u)
  assert.equal(installed.includes(Buffer.from("from './capture-demo-254-backup.mjs'")), false)
})

test('one-use nonce is bound to exact public release identity and backup attempt', () => {
  const releaseIdentity = fixture().release.data.release
  let invocation
  consumeDemo254BackupNonce({ nonce: 'N'.repeat(24), attemptId: 'attempt_Demo254_abcdefgh', releaseIdentity }, (binary, args, options) => {
    invocation = { binary, args, options }
    return { status: 0, stdout: 'nonce accepted\n' }
  })
  assert.equal(invocation.binary, '/usr/local/libexec/merchant/consume-production-evidence-nonce')
  assert.deepEqual(invocation.args.slice(-4), ['--operation', 'demo-254-backup', '--attempt-id', 'attempt_Demo254_abcdefgh'])
  assert.equal(invocation.args[invocation.args.indexOf('--manifest-sha256') + 1], releaseIdentity.manifest_sha256)
  assert.deepEqual(invocation.options.env, {})
  assert.throws(() => consumeDemo254BackupNonce({ nonce: 'N'.repeat(24), attemptId: 'attempt_Demo254_abcdefgh', releaseIdentity }, () => ({ status: 1, stderr: 'duplicate' })), /NONCE_CONSUMPTION_REJECTED/u)
})
