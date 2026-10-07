import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const launchScript = resolve('infra/scripts/start-ecs-demo-candidate.mjs')
const project = 'merchant-demo-healthcheck'
const gitSha = 'a'.repeat(40)
const sourceSha = `sha256:${'c'.repeat(64)}`
const imageDigest = `sha256:${'b'.repeat(64)}`
const image = `registry.invalid/merchant/api@${imageDigest}`
const postgresId = '1'.repeat(64)

test('demo startup refuses to migrate or start API when a preflighted dependency container is unhealthy', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-demo-startup-health-')))
  try {
    const composePath = join(root, 'candidate.compose.json')
    const envPath = join(root, 'candidate.env')
    const identityPath = join(root, 'candidate-identity.txt')
    const callsPath = join(root, 'docker-calls.jsonl')
    const dockerPath = join(root, 'docker-stub.mjs')
    const runtimePasswords = {
      merchant_app: 'a'.repeat(48),
      merchant_ops: 'b'.repeat(48),
      merchant_alert_receiver: 'c'.repeat(48),
    }
    const apiEnvironment = {
      RELEASE_ID: 'release-health-check', RELEASE_GIT_SHA: gitSha, NODE_ENV: 'production',
      DEPLOYMENT_PROFILE: 'ecs', RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false',
      AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true', MCP_AUTHZ_MODE: 'enforce', MCP_AUTHZ_ENFORCE_DOMAINS: '',
      RELEASE_MANIFEST_SHA256: 'd'.repeat(64), RELEASE_IMAGE_SET_DIGEST: `sha256:${'e'.repeat(64)}`,
      DATABASE_URL: `postgres://merchant_app:${runtimePasswords.merchant_app}@postgres:5432/merchant`,
      OPS_DATABASE_URL: `postgres://merchant_ops:${runtimePasswords.merchant_ops}@postgres:5432/merchant`,
      ALERT_RECEIVER_DATABASE_URL: `postgres://merchant_alert_receiver:${runtimePasswords.merchant_alert_receiver}@postgres:5432/merchant`,
      REDIS_URL: 'redis://redis:6379', PLUGIN_WRITE_ENABLED: 'false',
      ASSET_STORAGE_PREFIX: 'demo-candidate/release-health-check',
    }
    const artifacts = [
      'merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui',
      'payment-gateway', 'pilot-gateway', 'postgres-migration', 'clamav',
    ]
    const labels = {
      'com.storenova.release.id': 'release-health-check',
      'org.opencontainers.image.revision': gitSha,
      'com.storenova.release.source_sha256': sourceSha,
    }
    const compose = {
      services: {
        postgres: { image: 'postgres:17-alpine', volumes: ['pgdata:/var/lib/postgresql/data'] },
        redis: { image: 'redis:7-alpine', volumes: ['redisdata:/data'] },
        migrate: { image, environment: {
          PGHOST: 'postgres', DATABASE_URL: apiEnvironment.DATABASE_URL,
          OPS_DATABASE_URL: apiEnvironment.OPS_DATABASE_URL,
          ALERT_RECEIVER_DATABASE_URL: apiEnvironment.ALERT_RECEIVER_DATABASE_URL,
        } },
        api: { image, environment: apiEnvironment },
      },
      volumes: { pgdata: {}, redisdata: {} },
      'x-candidate-image-oci-metadata': Object.fromEntries(artifacts.map(artifact => [artifact, {
        reference: image, digest: imageDigest, labels,
      }])),
    }
    writeFileSync(composePath, JSON.stringify(compose))
    writeFileSync(envPath, 'RELEASE_ID=release-health-check\n')
    writeFileSync(identityPath, `release_id=release-health-check\ngit_sha=${gitSha}\nsource_sha256=${sourceSha}\n`)
    writeFileSync(dockerPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2).slice(2)
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const output = value => process.stdout.write(value + '\\n')
if (args[0] === 'ps' && args.includes('--filter')) process.exit(0)
if (args[0] === 'volume' || args[0] === 'network') process.exit(0)
if (args[0] === 'image' && args.includes('inspect')) {
  if (args.includes('{{.Id}}')) output('${imageDigest}')
  else if (args.includes('{{json .Config.Labels}}')) output(JSON.stringify(${JSON.stringify(labels)}))
  process.exit(0)
}
if (args[0] === 'compose' && args.includes('up')) process.exit(0)
if (args[0] === 'compose' && args.includes('ps') && args.at(-1) === 'postgres') { output('${postgresId}'); process.exit(0) }
if (args[0] === 'inspect' && args.includes('${postgresId}')) {
  output(JSON.stringify([{
    Id: '${postgresId}',
    Config: { Labels: { 'com.docker.compose.project': '${project}', 'com.docker.compose.service': 'postgres' } },
    State: { Running: true, Health: { Status: 'unhealthy' } },
    HostConfig: { PortBindings: {} },
  }]))
  process.exit(0)
}
process.stderr.write('unexpected stub Docker command')
process.exit(96)
`, { mode: 0o700 })

    const result = spawnSync(process.execPath, [launchScript, composePath, envPath, project, identityPath], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test', VITEST: 'true', DEMO_CANDIDATE_TEST_UNPROTECTED_FILES: 'true',
        DEMO_CANDIDATE_TEST_DOCKER_BINARY: dockerPath, DEMO_DOCKER_CALLS: callsPath,
      },
    })

    assert.notEqual(result.status, 0, 'startup must fail closed for an unhealthy Postgres container')
    assert.match(result.stderr, /postgres is not healthy/u)
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(calls.some(args => args[0] === 'compose' && args.includes('up') && args.includes('postgres') && args.includes('redis')))
    assert.ok(calls.some(args => args[0] === 'inspect' && args.includes(postgresId)))
    assert.ok(!calls.some(args => args[0] === 'compose' && args.includes('run') && args.includes('migrate')),
      'migration must not run after dependency health fails')
    assert.ok(!calls.some(args => args[0] === 'compose' && args.includes('up') && args.includes('api')),
      'API must not start after dependency health fails')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
