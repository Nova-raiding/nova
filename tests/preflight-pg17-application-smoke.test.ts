import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cleanupWorkerProbeContainer, parseSmokeEnv, runWorkerProbe, validatePg17SmokeTopology, validatePostProbeTopology, validateSmokeImageInventory, validateWorkerRestoreSmokeResult } from '../infra/protected/preflight-pg17-application-smoke.mjs'

const h = (char: string) => char.repeat(64)
const artifactKeys = ['clamav', 'merchant-api', 'merchant-ops-ui', 'merchant-ui', 'merchant-worker', 'payment-gateway', 'pilot-gateway', 'postgres-migration']
const imageDigests = Object.fromEntries(artifactKeys.map((key, index) => [key, `sha256:${String(index + 1).repeat(64)}`]))
const imageSetDigest = `sha256:${createHash('sha256').update(artifactKeys.slice().sort().map(key => `${key}=${imageDigests[key]}\n`).join('')).digest('hex')}`
const migrationChainRows = Array.from({ length: 254 }, (_, index) => `${index + 1}|migration_${index + 1}|${h('6')}`)
const capture = { schema_version: 'pg17-isolated-restore-capture/2', status: 'pass', simulated: false, release_id: 'release-1', release_git_sha: '1'.repeat(40), image_set_digest: imageSetDigest, manifest_sha256: h('3'), deployment_nonce_sha256: h('4'), backup_sha256: h('5'), source_database_id_sha256: h('7'), target_database_id_sha256: h('8'), migration_target_version: 254, restored_migration_prefix: '1:242:242', migrated_prefix: '1:254:254', migration_chain_sha256: createHash('sha256').update(migrationChainRows.join('\n')).digest('hex'), migration_chain_rows: migrationChainRows, network_id: h('a'), container_id: h('b'), postgres_image_id: `sha256:${h('c')}`, volume_name: 'merchant_restore_data_0123456789abcdef01234567', captured_at: '2026-09-23T02:00:00.000Z' }
const network = { Id: capture.network_id, Name: 'merchant_restore_net_0123456789abcdef01234567', Internal: true, Ingress: false, Driver: 'bridge', Containers: { [capture.container_id]: {}, [h('d')]: {} } }
const postgres = { Id: capture.container_id, Name: '/merchant_restore_0123456789abcdef01234567', State: { Running: true }, HostConfig: { NetworkMode: network.Name, PortBindings: {} }, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } }, Image: capture.postgres_image_id, Mounts: [{ Type: 'volume', Name: capture.volume_name }] }
const redis = { Id: h('d'), Name: '/merchant_restore_redis_0123456789abcdef01234567', State: { Running: true }, HostConfig: { NetworkMode: network.Name, PortBindings: {} }, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } }, Image: `sha256:${h('e')}`, Mounts: [] }
const imageReferences = Object.fromEntries(artifactKeys.map(key => [key, `registry.example/${key}@${imageDigests[key]}`]))
const images = { schema_version: 'pg17-restore-image-inventory/1', release_id: capture.release_id, release_git_sha: capture.release_git_sha, image_set_digest: capture.image_set_digest, manifest_sha256: capture.manifest_sha256, image_digests: imageDigests, image_references: imageReferences, api: imageReferences['merchant-api'], api_id: `sha256:${h('f')}`, worker: imageReferences['merchant-worker'], worker_id: `sha256:${h('1')}`, redis: `registry.example/redis@sha256:${h('e')}`, redis_id: redis.Image }
const pgUrl = `postgres://restore_app:ephemeral@${postgres.Name.slice(1)}/merchant`
const opsUrl = `postgres://restore_ops:ephemeral@${postgres.Name.slice(1)}/merchant`
const redisUrl = `redis://restore:ephemeral@${redis.Name.slice(1)}/0`
const apiEnv = { DATABASE_URL: pgUrl, OPS_DATABASE_URL: opsUrl, REDIS_URL: redisUrl, NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false', PAYMENT_RECONCILIATION_ENABLED: 'false', PAYMENT_REFUND_ENABLED: 'false', OPERATIONAL_ALERT_SWEEP_ENABLED: 'false' }
const workerEnv = { DATABASE_URL: pgUrl, REDIS_URL: redisUrl, NODE_ENV: 'production', RESTORE_SMOKE_MODE: 'isolated_read_only', RESTORE_SMOKE_WORKSPACE_ID: 'ws_restore_probe' }
const role = (name: string) => ({ name, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, has_write_privilege: false, default_read_only: true })
const input = () => ({ capture, network, postgres, redis, images, apiEnv, workerEnv, roles: [role('restore_app'), role('restore_ops')] })

describe('PG17 application smoke read-only preflight', () => {
  it('allows only a structurally safe topology to attempt the separate worker probe', () => {
    expect(validatePg17SmokeTopology(input())).toEqual([])
  })
  it('rejects legacy captures or a migration target mismatch', () => {
    expect(validatePg17SmokeTopology({ ...input(), capture: { ...capture, schema_version: 'pg17-isolated-restore-capture/1' } })).toContain('valid protected PG17 v2 capture required')
    expect(validatePg17SmokeTopology({ ...input(), capture: { ...capture, image_set_digest: h('2') } })).toContain('valid protected PG17 v2 capture required')
    expect(validatePg17SmokeTopology({ ...input(), capture: { ...capture, migrated_prefix: '1:253:253' } })).toContain('restore capture migration binding invalid')
    expect(validatePg17SmokeTopology({ ...input(), capture: { ...capture, migration_chain_rows: migrationChainRows.slice(1) } })).toContain('restore capture migration chain invalid')
  })
  it('rejects an egress-capable network and production Redis or DB URL', () => {
    const changed: Parameters<typeof validatePg17SmokeTopology>[0] = input()
    changed.network = { ...network, Internal: false }
    changed.apiEnv = { ...apiEnv, REDIS_URL: 'rediss://restore:password@redis.production.example/0' }
    changed.workerEnv = { ...workerEnv, DATABASE_URL: 'postgres://restore_app:password@postgres.production.example/merchant' }
    expect(validatePg17SmokeTopology(changed)).toEqual(expect.arrayContaining([
      'restore network must be exact internal bridge',
      'API Redis does not target isolated Redis',
      'worker database does not target restore Postgres',
    ]))
  })
  it('rejects restore containers attached to any network other than the captured internal network', () => {
    const changed: Parameters<typeof validatePg17SmokeTopology>[0] = input()
    changed.postgres = { ...postgres, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id }, production: { NetworkID: h('9') } } } }
    expect(validatePg17SmokeTopology(changed)).toContain('restore Postgres must attach only to the captured internal network ID')
    changed.postgres = postgres
    changed.redis = { ...redis, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id }, production: { NetworkID: h('9') } } } }
    expect(validatePg17SmokeTopology(changed)).toContain('isolated Redis must attach only to the captured internal network ID')
  })
  it('binds the worker reference and image set to the restore capture candidate', () => {
    expect(() => validateSmokeImageInventory(images, capture)).not.toThrow()
    expect(() => validateSmokeImageInventory({ ...images, release_git_sha: '2'.repeat(40) }, capture)).toThrow(/candidate identity mismatch/u)
    expect(() => validateSmokeImageInventory({ ...images, worker: `registry.example/other-worker@${imageDigests['merchant-worker']}` }, capture)).toThrow(/API\/worker references/u)
    const changedWorkerDigest = `sha256:${h('9')}`
    expect(() => validateSmokeImageInventory({ ...images, image_digests: { ...imageDigests, 'merchant-worker': changedWorkerDigest }, image_references: { ...imageReferences, 'merchant-worker': `registry.example/merchant-worker@${changedWorkerDigest}` } }, capture)).toThrow(/image-set digest mismatch/u)
  })
  it('rejects writable roles, unreviewed peers, mounted Redis and external-integration env', () => {
    const changed: Parameters<typeof validatePg17SmokeTopology>[0] = input()
    changed.roles = [role('restore_app'), { ...role('restore_ops'), has_write_privilege: true }]
    changed.network = { ...network, Containers: { ...network.Containers, [h('2')]: {} } }
    changed.redis = { ...redis, Mounts: [{ Type: 'volume', Name: 'production' }] }
    changed.apiEnv = { ...apiEnv, MODEL_RELAY_API_KEY: 'must-not-be-passed' }
    expect(validatePg17SmokeTopology(changed)).toEqual(expect.arrayContaining([
      'restore database roles are not proven read-only', 'restore network has unreviewed peers',
      'isolated Redis has a mount or published port', 'API smoke environment contains unreviewed key or external integration',
    ]))
  })
  it('rejects normal worker poll settings and mismatched probe output', () => {
    expect(validatePg17SmokeTopology({ ...input(), workerEnv: { ...workerEnv, WORKER_ONCE: 'true' } })).toContain('worker smoke environment contains unreviewed key or external integration')
    const observation = { schema_version: 'pg17-worker-restore-smoke/1', status: 'pass', simulated: false, database_role: 'restore_app', redis_ping: 'PONG', migration_target_version: 254, migration_chain_sha256: capture.migration_chain_sha256, workspace_id_sha256: createHash('sha256').update(workerEnv.RESTORE_SMOKE_WORKSPACE_ID).digest('hex'), observed_at: new Date().toISOString() }
    expect(() => validateWorkerRestoreSmokeResult(observation, capture, workerEnv.RESTORE_SMOKE_WORKSPACE_ID)).not.toThrow()
    expect(() => validateWorkerRestoreSmokeResult({ ...observation, migration_target_version: 253 }, capture, workerEnv.RESTORE_SMOKE_WORKSPACE_ID)).toThrow(/target mismatch/u)
    expect(() => validateWorkerRestoreSmokeResult({ ...observation, status: 'fail' }, capture, workerEnv.RESTORE_SMOKE_WORKSPACE_ID)).toThrow(/did not pass/u)
  })
  it('rejects resource drift or a retained worker container after the probe', () => {
    const after = { network, postgres, redis }
    expect(validatePostProbeTopology(input(), after, true)).toEqual([])
    expect(validatePostProbeTopology(input(), { ...after, network: { ...network, Internal: false } }, true)).toContain('restore network must be exact internal bridge')
    expect(validatePostProbeTopology(input(), { ...after, redis: { ...redis, Id: h('9') } }, true)).toContain('isolated resource identity changed during worker probe')
    expect(validatePostProbeTopology(input(), after, false)).toContain('isolated worker probe container was not removed')
  })
  it('removes and verifies only the generated worker probe container on timeout', async () => {
    const calls: string[][] = []
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    const runner = (_command: string, args: string[]) => {
      calls.push(args)
      if (args.includes('image')) return { status: 0, stdout: JSON.stringify([{ Id: images.worker_id }]), stderr: '' }
      if (args.includes('run')) return { status: null, stdout: '', stderr: '', error: timeout }
      if (args.includes('container') && args.includes('inspect')) {
        if (calls.filter(call => call.includes('container') && call.includes('inspect')).length > 1) return { status: 1, stdout: '', stderr: 'Error: No such object: probe' }
        const run = calls.find(call => call.includes('run'))!
        const name = run[run.indexOf('--name') + 1]!
        const nonce = name.slice('merchant_restore_worker_'.length)
        return { status: 0, stdout: JSON.stringify([{ Id: h('9'), Name: `/${name}`, Config: { Labels: { 'merchant.restore.probe_nonce': nonce } }, Image: images.worker_id, HostConfig: { NetworkMode: network.Name }, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } } }]), stderr: '' }
      }
      if (args.includes('rm')) return { status: 0, stdout: '', stderr: '' }
      throw new Error(`unexpected docker command: ${args.join(' ')}`)
    }
    expect(() => runWorkerProbe({ workerEnvPath: '/protected/worker.env', images, network, capture, workspaceId: 'ws_restore_probe', runner }))
      .toThrow(/isolated worker restore probe failed/u)
    const runArgs = calls.find(call => call.includes('run'))!
    const nameIndex = runArgs.indexOf('--name')
    const generatedName = runArgs[nameIndex + 1]!
    expect(generatedName).toMatch(/^merchant_restore_worker_[a-f0-9]{24}$/u)
    expect(runArgs).toContain(`merchant.restore.probe_nonce=${generatedName.slice('merchant_restore_worker_'.length)}`)
    expect(calls.find(call => call.includes('container') && call.includes('rm'))).toEqual(['--host', 'unix:///var/run/docker.sock', 'container', 'rm', '--force', h('9')])
    expect(calls.filter(call => call.includes('container') && call.includes('inspect')).at(-1)).toEqual(['--host', 'unix:///var/run/docker.sock', 'container', 'inspect', generatedName])
  })
  it('never removes a foreign container with the generated probe name', () => {
    const nonce = 'a'.repeat(24)
    const name = `merchant_restore_worker_${nonce}`
    const calls: string[][] = []
    const runner = (_command: string, args: string[]) => {
      calls.push(args)
      if (args.includes('inspect')) return { status: 0, stdout: JSON.stringify([{ Id: h('9'), Name: `/${name}`, Config: { Labels: { 'merchant.restore.probe_nonce': 'foreign' } }, Image: images.worker_id, HostConfig: { NetworkMode: network.Name }, NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } } }]), stderr: '' }
      throw new Error('foreign container must never be removed')
    }
    expect(() => cleanupWorkerProbeContainer(name, { nonce, imageId: images.worker_id, network }, runner)).toThrow(/ownership mismatch/u)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('inspect')
  })
  it('rejects shell expansion, duplicate keys and any attempt to invoke it as a runtime pass', () => {
    expect(() => parseSmokeEnv('DATABASE_URL=$LIVE_DATABASE\n')).toThrow(/unsafe/u)
    expect(() => parseSmokeEnv('NODE_ENV=production\nNODE_ENV=test\n')).toThrow(/duplicate/u)
    const child = spawnSync(process.execPath, ['infra/protected/preflight-pg17-application-smoke.mjs'], { encoding: 'utf8' })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain('NO-GO')
  })
})
