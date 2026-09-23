import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseSmokeEnv, validatePg17SmokeTopology } from '../infra/protected/preflight-pg17-application-smoke.mjs'

const h = (char: string) => char.repeat(64)
const capture = { schema_version: 'pg17-isolated-restore-capture/1', status: 'pass', simulated: false, network_id: h('a'), container_id: h('b'), postgres_image_id: `sha256:${h('c')}`, volume_name: 'merchant_restore_data_0123456789abcdef01234567' }
const network = { Id: capture.network_id, Name: 'merchant_restore_net_0123456789abcdef01234567', Internal: true, Ingress: false, Driver: 'bridge', Containers: { [capture.container_id]: {}, [h('d')]: {} } }
const postgres = { Id: capture.container_id, Name: '/merchant_restore_0123456789abcdef01234567', State: { Running: true }, HostConfig: { NetworkMode: network.Name, PortBindings: {} }, Image: capture.postgres_image_id, Mounts: [{ Type: 'volume', Name: capture.volume_name }] }
const redis = { Id: h('d'), Name: '/merchant_restore_redis_0123456789abcdef01234567', State: { Running: true }, HostConfig: { NetworkMode: network.Name, PortBindings: {} }, Image: `sha256:${h('e')}`, Mounts: [] }
const images = { api: `registry.example/api@sha256:${h('f')}`, api_id: `sha256:${h('f')}`, worker: `registry.example/worker@sha256:${h('1')}`, worker_id: `sha256:${h('1')}`, redis: `registry.example/redis@sha256:${h('e')}`, redis_id: redis.Image }
const pgUrl = `postgres://restore_app:ephemeral@${postgres.Name.slice(1)}/merchant`
const opsUrl = `postgres://restore_ops:ephemeral@${postgres.Name.slice(1)}/merchant`
const redisUrl = `redis://restore:ephemeral@${redis.Name.slice(1)}/0`
const apiEnv = { DATABASE_URL: pgUrl, OPS_DATABASE_URL: opsUrl, REDIS_URL: redisUrl, NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false', PAYMENT_RECONCILIATION_ENABLED: 'false', PAYMENT_REFUND_ENABLED: 'false', OPERATIONAL_ALERT_SWEEP_ENABLED: 'false' }
const workerEnv = { DATABASE_URL: pgUrl, REDIS_URL: redisUrl, NODE_ENV: 'production', WORKER_ROLE: 'sync', WORKER_ONCE: 'true' }
const role = (name: string) => ({ name, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, has_write_privilege: false, default_read_only: true })
const input = () => ({ capture, network, postgres, redis, images, apiEnv, workerEnv, roles: [role('restore_app'), role('restore_ops')] })

describe('PG17 application smoke read-only preflight', () => {
  it('never calls a runtime smoke success on a structurally safe topology', () => {
    expect(validatePg17SmokeTopology(input())).toEqual(['worker no-dispatch restore smoke mode is not implemented'])
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
  it('rejects shell expansion, duplicate keys and any attempt to invoke it as a runtime pass', () => {
    expect(() => parseSmokeEnv('DATABASE_URL=$LIVE_DATABASE\n')).toThrow(/unsafe/u)
    expect(() => parseSmokeEnv('NODE_ENV=production\nNODE_ENV=test\n')).toThrow(/duplicate/u)
    const child = spawnSync(process.execPath, ['infra/protected/preflight-pg17-application-smoke.mjs'], { encoding: 'utf8' })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain('NO-GO')
  })
})
