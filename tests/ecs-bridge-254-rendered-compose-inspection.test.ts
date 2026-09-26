import { describe, expect, it } from 'vitest'
import { inspectBridge254Compose } from '../infra/scripts/inspect-ecs-bridge-254-rendered-compose.mjs'

const runtime = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
const sha = 'a'.repeat(64)
const release = { RELEASE_ID: 'release-bridge-review', RELEASE_GIT_SHA: 'b'.repeat(40), RELEASE_MANIFEST_SHA256: sha, RELEASE_IMAGE_SET_DIGEST: `sha256:${sha}` }

function rendered() {
  return { services: Object.fromEntries(runtime.map(name => [name, {
    image: `${name.startsWith('api') ? 'api' : 'worker'}@sha256:${sha}`,
    environment: {
      BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_254',
      RUN_MIGRATIONS_ON_STARTUP: 'false',
      ...(name.startsWith('api') ? release : {}),
    },
  }])) }
}

describe('242/254 rendered Compose review inspection', () => {
  it('reports a complete static inspection as review-only', () => {
    expect(inspectBridge254Compose(rendered())).toMatchObject({
      status: 'review_only', deployable: false, runtime_verified: false,
      release_id: release.RELEASE_ID, inspected_services: runtime,
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
      delete omitted.services[name]!.environment.RUN_MIGRATIONS_ON_STARTUP
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
})
