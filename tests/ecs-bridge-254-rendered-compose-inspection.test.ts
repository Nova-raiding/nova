import { describe, expect, it } from 'vitest'
import { inspectBridge254Compose } from '../infra/scripts/inspect-ecs-bridge-254-rendered-compose.mjs'

const runtime = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
const support = ['ui', 'ops-ui', 'payment-gateway', 'pilot-gateway', 'clamav']
const allowedServices = [...runtime, ...support]
const sha = 'a'.repeat(64)
const release = { RELEASE_ID: 'release-bridge-review', RELEASE_GIT_SHA: 'b'.repeat(40), RELEASE_MANIFEST_SHA256: sha, RELEASE_IMAGE_SET_DIGEST: `sha256:${sha}` }
type RenderedService = { image: string; environment: Record<string, string>; build?: unknown; depends_on?: string[] | Record<string, unknown>; command?: string | string[]; entrypoint?: string | string[] }

function rendered(): { services: Record<string, RenderedService> } {
  return { services: Object.fromEntries([...runtime.map(name => [name, {
    image: `${name.startsWith('api') ? 'api' : 'worker'}@sha256:${sha}`,
    environment: {
      BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_254',
      RUN_MIGRATIONS_ON_STARTUP: 'false',
      ...release,
    },
  }] as const), ...support.map(name => [name, { image: `${name}@sha256:${sha}`, environment: {} }] as const)]) }
}

describe('242/254 rendered Compose review inspection', () => {
  it('reports a complete static inspection as review-only', () => {
    expect(inspectBridge254Compose(rendered())).toMatchObject({
      status: 'review_only', deployable: false, runtime_verified: false,
      release_id: release.RELEASE_ID, inspected_services: allowedServices,
    })
  })

  it('rejects missing, mixed, and mutable runtime services', () => {
    for (const name of runtime) {
      const missing = rendered()
      delete missing.services[name]
      expect(() => inspectBridge254Compose(missing), name).toThrow()

      const mixed = rendered()
      mixed.services[name]!.environment.BRIDGE_SCHEMA_COMPATIBILITY_MODE = 'prefix_242_or_244'
      expect(() => inspectBridge254Compose(mixed), name).toThrow(`${name} bridge mode`)

      const mutable = rendered()
      mutable.services[name]!.image = 'app:latest'
      expect(() => inspectBridge254Compose(mutable), name).toThrow(`${name} image`)
    }
  })

  it('rejects identity drift and startup migrations on either API', () => {
    const drift = rendered()
    drift.services['api-replica']!.environment.RELEASE_GIT_SHA = 'c'.repeat(40)
    expect(() => inspectBridge254Compose(drift)).toThrow('api-replica RELEASE_GIT_SHA differs')
    const migration = rendered()
    migration.services.api!.environment.RUN_MIGRATIONS_ON_STARTUP = 'true'
    expect(() => inspectBridge254Compose(migration)).toThrow('api startup migrations must be disabled')
  })

  it('rejects omitted or enabled startup migrations on every worker', () => {
    for (const name of runtime.filter(service => service.startsWith('worker-'))) {
      const omitted = rendered()
      Reflect.deleteProperty(omitted.services[name]!.environment, 'RUN_MIGRATIONS_ON_STARTUP')
      expect(() => inspectBridge254Compose(omitted), `${name} omitted`).toThrow(`${name} startup migrations must be disabled`)

      const enabled = rendered()
      enabled.services[name]!.environment.RUN_MIGRATIONS_ON_STARTUP = 'true'
      expect(() => inspectBridge254Compose(enabled), `${name} enabled`).toThrow(`${name} startup migrations must be disabled`)
    }
  })

  it('rejects distinct worker images even when both are pinned', () => {
    const input = rendered()
    input.services['worker-scan']!.image = `worker@sha256:${'c'.repeat(64)}`
    expect(() => inspectBridge254Compose(input)).toThrow('worker-scan worker image differs')
  })

  it('requires every runtime identity and rejects migration containers or startup dependencies', () => {
    const missingIdentity = rendered()
    Reflect.deleteProperty(missingIdentity.services['worker-scan']!.environment, 'RELEASE_GIT_SHA')
    expect(() => inspectBridge254Compose(missingIdentity)).toThrow('worker-scan RELEASE_GIT_SHA differs from api')

    const migrationService = rendered()
    migrationService.services['postgres-migration'] = { image: `postgres@sha256:${sha}`, environment: {} }
    expect(() => inspectBridge254Compose(migrationService)).toThrow('must not contain a migration service')

    const dependency = rendered()
    dependency.services.api!.depends_on = { migrate: { condition: 'service_completed_successfully' } }
    expect(() => inspectBridge254Compose(dependency)).toThrow('api depends on a migration service')

    const command = rendered()
    command.services['worker-generation']!.command = ['sh', '/app/apply-migrations.sh']
    expect(() => inspectBridge254Compose(command)).toThrow('worker-generation contains a migration startup command')
  })

  it('accepts only the explicit runtime and support service set', () => {
    const extra = rendered()
    extra.services['debug-shell'] = { image: `debug@sha256:${sha}`, environment: {} }
    expect(() => inspectBridge254Compose(extra)).toThrow('outside the reviewed allowlist: debug-shell')

    const missingSupport = rendered()
    delete missingSupport.services.clamav
    expect(() => inspectBridge254Compose(missingSupport)).toThrow('missing allowlisted services: clamav')

    const mutableSupport = rendered()
    mutableSupport.services['pilot-gateway']!.build = { context: '.' }
    expect(() => inspectBridge254Compose(mutableSupport)).toThrow('pilot-gateway retains a mutable build')

    const unpinnedSupport = rendered()
    unpinnedSupport.services['ops-ui']!.image = 'ops-ui:latest'
    expect(() => inspectBridge254Compose(unpinnedSupport)).toThrow('ops-ui image is not digest pinned')
  })
})
