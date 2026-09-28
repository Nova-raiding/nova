import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createIsolatedPg17DockerPorts, isolatedDockerArgs } from '../infra/protected/ecs-bridge-255-isolated-host.mjs'
import { parseBridge255IsolatedArgs, parseBridge255PreviewPlanArgs,
  validateBridge255IsolatedPaths,
  verifySignedBridge255Plan } from '../infra/protected/ecs-bridge-255-isolated-runner.mjs'
import { prepareControlBytes } from '../infra/scripts/install-ecs-release-controls.mjs'

const h = char => char.repeat(64)
const imageRef = `sha256:${h('a')}`
const attemptId = 'attempt_abcdefghijklmnop'
const suffix = 'abcdef012345abcdef012345'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('isolated Docker commands create only internal network and new volume, without ports', () => {
  const args = isolatedDockerArgs({ attemptId, suffix, imageRef,
    network: `merchant_restore_net_${suffix}`,
    volume: `merchant_restore_data_${suffix}`,
    container: `merchant_restore_pg_${suffix}` })
  assert.deepEqual(args.network.slice(0, 3), ['network', 'create', '--internal'])
  assert.deepEqual(args.volume.slice(0, 2), ['volume', 'create'])
  assert.equal(args.postgres.includes('-p'), false)
  assert.equal(args.postgres.includes('--publish'), false)
  assert.equal(args.postgres.includes('--network'), true)
  assert.throws(() => isolatedDockerArgs({ attemptId, suffix, imageRef,
    network: 'merchant-demo-85575f9c_default', volume: 'production', container: 'postgres' }),
  /NAMES_NOT_ISOLATED/u)
})

function fakeDocker({ publishPort = false, badNetwork = false, transientVersionFailures = 0 } = {}) {
  const events = []
  let versionFailures = 0
  const network = `merchant_restore_net_${suffix}`
  const volume = `merchant_restore_data_${suffix}`
  const container = `merchant_restore_pg_${suffix}`
  const docker = (args, options) => {
    events.push(args)
    const command = args.join(' ')
    if (command.startsWith('image inspect')) return JSON.stringify([{ Id: imageRef }])
    if (command.startsWith('network create')) return h('b')
    if (command.startsWith('volume create')) return volume
    if (command.startsWith('run -d')) return h('c')
    if (command.startsWith('exec -u postgres') && command.includes('pg_isready')) return 'ready'
    if (command.includes('SHOW server_version_num')) {
      if (versionFailures++ < transientVersionFailures) throw new Error('database restarting after initdb')
      return '170006'
    }
    if (command.startsWith('network inspect')) return JSON.stringify([{ Id: h('b'), Internal: !badNetwork }])
    if (command.startsWith('volume inspect')) return JSON.stringify([{ Name: volume }])
    if (command.startsWith('inspect ')) return JSON.stringify([{ Id: h('c'), Image: imageRef,
      Config: { Image: imageRef }, State: { Running: true },
      NetworkSettings: { Networks: { [network]: {} }, Ports: { '5432/tcp': publishPort ? [{ HostPort: '5432' }] : null } },
      Mounts: [{ Type: 'volume', Name: volume }] }])
    if (command.includes('SELECT system_identifier FROM pg_control_system()')) return '7456012345678901234'
    if (command.startsWith('exec -i') && options?.input) return ''
    if (command.startsWith('stop --time')) return container
    throw new Error(`unexpected Docker call: ${command}`)
  }
  return { docker, events }
}

test('waits through the temporary initdb server restart before querying PG17', async () => {
  const mock = fakeDocker({ transientVersionFailures: 1 })
  let waits = 0
  const ports = createIsolatedPg17DockerPorts({ docker: mock.docker,
    stream: async () => {}, random: () => suffix, wait: async () => { waits++ } })
  await ports.create({ attemptId, imageRef, preserveVolume: true,
    internalNetwork: true, publishPorts: false })
  assert.equal(waits, 1)
  assert.equal(mock.events.filter(args => args.includes('SHOW server_version_num')).length, 2)
})

test('real port adapter rejects exposed container or external network before source restore', async () => {
  for (const flag of ['publishPort', 'badNetwork']) {
    const mock = fakeDocker({ [flag]: true })
    const ports = createIsolatedPg17DockerPorts({ docker: mock.docker,
      stream: async () => { throw new Error('stream must not run') }, random: () => suffix,
      wait: async () => {} })
    await ports.create({ attemptId, imageRef, preserveVolume: true,
      internalNetwork: true, publishPorts: false })
    await assert.rejects(ports.inspect(attemptId), /DOCKER_INSPECTION_INVALID/u)
    await ports.quarantineAttempt({ attemptId, preserveVolume: true, keepInternal: true })
    assert.equal(mock.events.some(args => args[0] === 'rm' || args[0] === 'volume' && args[1] === 'rm'), false)
    assert.equal(mock.events.some(args => args[0] === 'stop'), true)
  }
})

test('adapter refuses wrong 255 SQL/name and never issues SQL', async () => {
  const mock = fakeDocker()
  const ports = createIsolatedPg17DockerPorts({ docker: mock.docker,
    stream: async () => {}, random: () => suffix, wait: async () => {} })
  await ports.create({ attemptId, imageRef, preserveVolume: true,
    internalNetwork: true, publishPorts: false })
  await assert.rejects(ports.applyOnly255({ attemptId, sql: Buffer.from('SELECT 1'),
    sqlSha256: sha('SELECT 1'), name: 'foreign_migration', expectedBefore: h('d') }),
  /MIGRATION_NAME_INVALID/u)
  assert.equal(mock.events.some(args => args[0] === 'exec' && args.includes('ON_ERROR_STOP=1')
    && args.includes('-i')), false)
})

test('root preview CLI accepts exact attempt paths and rejects unsigned or foreign plans', () => {
  const plan = { bridge_254_255: { identity: { release_id: 'release-reviewed' } },
    attempt_id: 'attempt_abcdefghijklmnop' }
  const base = '/var/lib/merchant-release-security'
  const backup = `${base}/backups/release-reviewed-demo254-${plan.attempt_id}/before-upgrade-254.dump`
  const assets = `${base}/bridge-255/${plan.attempt_id}`
  const args = ['--backup', backup, '--attestation', `${backup}.attestation.json`,
    '--capture', `${backup}.capture.json`,
    '--migration-255', `${assets}/255_scoped_brand_settings.sql`,
    '--output', `${base}/preview-restores/${plan.attempt_id}-isolated-255.json`]
  const parsed = parseBridge255IsolatedArgs(args)
  assert.doesNotThrow(() => validateBridge255IsolatedPaths(parsed, plan))
  assert.throws(() => parseBridge255IsolatedArgs([...args, '--production', 'true']),
    /ARGUMENT_COUNT_INVALID/u)
  assert.throws(() => validateBridge255IsolatedPaths({ ...parsed,
    '--backup': '/var/lib/merchant-release-security/backups/production.dump' }, plan),
  /BACKUP_ATTEMPT_PATH_INVALID/u)
  const keys = generateKeyPairSync('ed25519')
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const envelope = { plan, key_id: 'production-evidence' }
  envelope.signature_base64 = sign(null, Buffer.from(JSON.stringify(Object.fromEntries(
    Object.entries(envelope).sort(([a], [b]) => a.localeCompare(b))))), keys.privateKey).toString('base64')
  assert.throws(() => verifySignedBridge255Plan({ ...envelope, key_id: 'foreign' },
    publicPem, 'production-evidence'), /PLAN_ENVELOPE_INVALID/u)
  assert.throws(() => verifySignedBridge255Plan({ ...envelope, signature_base64: 'fake' },
    publicPem, 'production-evidence'), /PLAN_SIGNATURE_INVALID/u)
  const createdAt = '2026-09-28T04:00:00.000Z'
  const planArgs = ['inspect', '--attempt-id', plan.attempt_id,
    '--pg17-image-id', imageRef, '--created-at', createdAt, ...args]
  assert.equal(parseBridge255PreviewPlanArgs(planArgs).mode, 'inspect')
  assert.throws(() => parseBridge255PreviewPlanArgs([...planArgs, '--approved-plan-sha256', h('1')]),
    /ARGUMENT_COUNT_INVALID/u)
})

test('preview runner bundles as one fixed-install reviewed control', () => {
  const bundle = Buffer.from(buildSync({ entryPoints: ['infra/protected/ecs-bridge-255-isolated-runner.mjs'],
    bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].contents)
  const installed = prepareControlBytes('bridge255Isolated', bundle, sha(bundle),
    '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node')
  assert.equal(installed.toString().startsWith('#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node\n'), true)
  assert.equal(installed.toString().includes("from './"), false)
})
